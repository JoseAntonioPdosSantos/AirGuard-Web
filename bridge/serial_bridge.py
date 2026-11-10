#!/usr/bin/env python3
"""AirGuard serial bridge: USB serial of the boards -> AirGuard Web.

The ESP32 node and the RP2040 receiver print telemetry lines on their USB
serial ports, mixed with the normal log:

    @T {"src":"node","k":"env","ms":12345,"temp":25.4,...}

This script reads every port, keeps only those lines, stamps each record
with the PC clock ("pc", ms since 1970) and POSTs them in batches to
POST /api/telemetry/ingest (header X-Device-Key). It reconnects by itself
when a board is unplugged or reset, and keeps up to 20000 records while the
server is down.

    # key: docker compose exec airguard-web node server/src/cli.js device:add "bridge"
    export AIRGUARD_DEVICE_KEY=<key>      (or save it in bridge/device.key)
    python3 bridge/serial_bridge.py                       # every /dev/ttyUSB* and /dev/ttyACM*
    python3 bridge/serial_bridge.py --port /dev/ttyACM0   # only the receiver
    python3 bridge/serial_bridge.py --echo                # also print the boards' log
    python3 bridge/serial_bridge.py --simulate            # no boards: synthetic data

Needs pyserial (not for --simulate): pip install pyserial, or use
~/.platformio/penv/bin/python, which already has it.
The ports are opened WITHOUT pulsing DTR/RTS, so the ESP32 is not reset.
"""
import argparse
import collections
import glob
import json
import math
import os
import random
import sys
import threading
import time
import urllib.error
import urllib.request

PREFIX = "@T {"
QUEUE_MAX = 20000
BATCH_MAX = 500


def now_ms() -> int:
    return int(time.time() * 1000)


class Uplink:
    """Batches records and POSTs them; keeps them while the server is down."""

    def __init__(self, server: str, key: str):
        self.url = server.rstrip("/") + "/api/telemetry/ingest"
        self.key = key
        self.q = collections.deque(maxlen=QUEUE_MAX)
        self.lock = threading.Lock()
        self.sent = 0
        self.down_since = None

    def put(self, rec: dict) -> None:
        with self.lock:
            self.q.append(rec)

    def run(self) -> None:
        while True:
            time.sleep(0.5)
            with self.lock:
                batch = [self.q.popleft() for _ in range(min(BATCH_MAX, len(self.q)))]
            if not batch:
                continue
            body = json.dumps({"records": batch}).encode()
            req = urllib.request.Request(self.url, data=body, method="POST", headers={
                "content-type": "application/json", "x-device-key": self.key})
            try:
                with urllib.request.urlopen(req, timeout=5) as r:
                    r.read()
                self.sent += len(batch)
                if self.down_since:
                    log(f"server back after {time.time() - self.down_since:.0f} s")
                    self.down_since = None
            except urllib.error.HTTPError as e:
                if e.code in (401, 429):
                    log(f"server refused the key (HTTP {e.code}); check AIRGUARD_DEVICE_KEY")
                    time.sleep(10)
                    with self.lock:
                        self.q.extendleft(reversed(batch))
                else:
                    log(f"server answered HTTP {e.code}; batch of {len(batch)} dropped")
            except (urllib.error.URLError, OSError) as e:
                if not self.down_since:
                    self.down_since = time.time()
                    log(f"server unreachable ({e}); keeping records (max {QUEUE_MAX})")
                with self.lock:
                    self.q.extendleft(reversed(batch))
                time.sleep(2)


def log(msg: str) -> None:
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def parse_line(line: str):
    i = line.find(PREFIX)
    if i < 0:
        return None
    try:
        rec = json.loads(line[i + 3:])
    except ValueError:
        return None
    if not isinstance(rec, dict) or rec.get("src") not in ("node", "gw"):
        return None
    rec["pc"] = now_ms()
    return rec


# ---------------------------------------------------------------------------
# Serial ports
# ---------------------------------------------------------------------------
def port_reader(port: str, up: Uplink, echo: bool, active: set) -> None:
    import serial  # pyserial

    try:
        s = serial.Serial()
        s.port = port
        s.baudrate = 115200
        s.timeout = 0.2
        s.dtr = False  # do not reset the ESP32 (auto-reset circuit on DTR/RTS)
        s.rts = False
        s.open()
    except (serial.SerialException, OSError) as e:
        log(f"{port}: cannot open ({e})")
        active.discard(port)
        return
    log(f"{port}: open")
    buf = b""
    seen = None
    try:
        while True:
            chunk = s.read(4096)
            if not chunk:
                continue
            buf += chunk
            while b"\n" in buf:
                raw, buf = buf.split(b"\n", 1)
                line = raw.decode("utf-8", errors="replace").strip("\r")
                rec = parse_line(line)
                if rec is not None:
                    up.put(rec)
                    if seen != rec["src"]:
                        seen = rec["src"]
                        log(f"{port}: telemetry from {'ESP32 node' if seen == 'node' else 'RP2040 receiver'}")
                elif echo and line.strip():
                    print(f"[{os.path.basename(port)}] {line}", flush=True)
            if len(buf) > 8192:  # no newline for too long: garbage
                buf = b""
    except (serial.SerialException, OSError) as e:
        log(f"{port}: closed ({e})")
    finally:
        try:
            s.close()
        except Exception:
            pass
        active.discard(port)


def watch_ports(fixed, up: Uplink, echo: bool) -> None:
    active = set()
    while True:
        ports = fixed or sorted(glob.glob("/dev/ttyUSB*") + glob.glob("/dev/ttyACM*"))
        for p in ports:
            if p not in active and os.path.exists(p):
                active.add(p)
                threading.Thread(target=port_reader, args=(p, up, echo, active), daemon=True).start()
        time.sleep(2)


# ---------------------------------------------------------------------------
# Simulation (no boards): the same records the firmwares write
# ---------------------------------------------------------------------------
class Sim:
    GAS_MED, GAS_HIGH, HYST = 0.90, 1.5, 0.05

    def __init__(self, up: Uplink):
        self.up = up
        self.t0 = time.time()
        self.seq = 0
        self.event_id = (1 << 16) * 7
        self.gas_level = "NORMAL"
        self.spike_at = time.time() + 40

    def ms(self) -> int:
        return int((time.time() - self.t0) * 1000)

    def put(self, src: str, k: str, **f) -> None:
        self.up.put({"src": src, "k": k, "ms": self.ms(), "pc": now_ms(), **f})

    def readings(self):
        t = time.time()
        temp = 25.0 + 1.6 * math.sin(t / 900) + random.gauss(0, 0.05)
        hum = 60 + 6 * math.sin(t / 1300 + 1) + random.gauss(0, 0.4)
        gas = 0.45 + 0.03 * math.sin(t / 60) + random.gauss(0, 0.01)
        d = t - self.spike_at  # a gas leak test every ~4 min: up to 1.9 V, ~50 s
        if 0 <= d < 50:
            gas += 1.45 * math.sin(math.pi * d / 50) ** 2
        elif d >= 240:
            self.spike_at = t + random.uniform(0, 30)
        return round(temp, 1), round(hum), round(max(gas, 0.05), 3)

    def level(self, gas: float) -> str:
        lv = self.gas_level
        if gas >= self.GAS_HIGH:
            return "HIGH"
        if lv == "HIGH" and gas >= self.GAS_HIGH - self.HYST:
            return "HIGH"
        if gas >= self.GAS_MED:
            return "MEDIUM"
        if lv != "NORMAL" and gas >= self.GAS_MED - self.HYST:
            return "MEDIUM"
        return "NORMAL"

    def radio(self, frame: dict, qid: int, kind: str) -> None:
        """node TX -> (airtime) -> receiver RX; ALERT/RECOVERY are ACKed."""
        text = json.dumps(frame, separators=(",", ":"))
        self.put("node", "tx", id=qid, kind=kind, len=len(text), frame=text, **{"try": 1})
        air = 300 + len(text)
        time.sleep(air / 1000)
        self.put("node", "txd", id=qid, kind=kind, ok=True, air=air)
        if random.random() < 0.04:  # lost on the air
            return
        rssi = round(-34 + random.gauss(0, 3))
        snr = round(10 + random.gauss(0, 1.2))
        res = "hb" if frame["type"] == "HB" else "event"
        self.put("gw", "rx", **{"from": 101}, rssi=rssi, snr=snr, len=len(text), res=res, frame=text)
        if res == "event":
            time.sleep(0.05)
            ack = json.dumps({"type": "ACK", "device": "GATEWAY_01", "dst": "KITCHEN_01",
                              "ack_for": frame["event_id"]}, separators=(",", ":"))
            self.put("gw", "ack", id=frame["event_id"], to=101, frame=ack)
            time.sleep(0.25)
            self.put("node", "ack", id=frame["event_id"], **{"from": "GATEWAY_01"},
                     rssi=rssi + random.randint(-2, 2), snr=snr)

    def run(self) -> None:
        log("simulation: synthetic ESP32 node + RP2040 receiver (gas test every ~4 min)")
        self.put("node", "boot", fw="1.0.0", device="KITCHEN_01", gateway="GATEWAY_01", boot=7,
                 gas_med=self.GAS_MED, gas_high=self.GAS_HIGH)
        self.put("gw", "boot", gateway="GATEWAY_01", node="KITCHEN_01", lora=True, lcd=True)
        last_env = last_hb = last_stat = 0.0
        events = hbs = 0
        while True:
            now = time.time()
            temp, hum, gas = self.readings()
            lv = self.level(gas)
            ov = lv
            letters = {"NORMAL": "N", "MEDIUM": "M", "HIGH": "H"}[lv] + "NNN"
            if lv != self.gas_level:
                prev, self.gas_level = self.gas_level, lv
                self.event_id += 1
                typ = "RECOVERY" if lv == "NORMAL" else "ALERT"
                self.put("node", "evt", id=self.event_id, type=typ, cat="AIR_QUALITY", sev=lv, prev=prev)
                frame = {"v": 1, "type": typ, "device": "KITCHEN_01", "dst": "GATEWAY_01",
                         "event_id": self.event_id, "category": "AIR_QUALITY", "severity": lv,
                         "prev": prev, "sensor": "MQ135", "air_index": round(gas * 20),
                         "temperature": temp, "humidity": hum, "timestamp": self.ms() // 1000}
                events += 1
                self.radio(frame, self.event_id, "event")
            if now - last_env >= 2:
                last_env = now
                self.put("node", "env", temp=temp, rh=hum, hi=temp, env="ok", gas=gas, ao=gas,
                         adc=int(gas / 5 * 4095), air="ok", lv=letters, ov=ov, relay=lv == "HIGH",
                         flags=0, lora="ok", q=0, wack=0, up=self.ms() // 1000)
            if now - last_hb >= 5:
                last_hb = now
                self.seq += 1
                hbs += 1
                frame = {"v": 1, "type": "HB", "device": "KITCHEN_01", "dst": "GATEWAY_01",
                         "seq": self.seq, "levels": letters, "air_index": round(gas * 20),
                         "temperature": temp, "humidity": hum, "timestamp": self.ms() // 1000}
                self.radio(frame, 0xE0000000 | self.seq, "hb")
            if now - last_stat >= 10:
                last_stat = now
                self.put("gw", "stat", lcd=True, lora=True, events=events, hbs=hbs, ov=ov, lost=False, rssi=-34)
            time.sleep(0.2)


def read_key(arg: str) -> str:
    if arg:
        return arg
    if os.environ.get("AIRGUARD_DEVICE_KEY"):
        return os.environ["AIRGUARD_DEVICE_KEY"].strip()
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "device.key")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return f.read().strip()
    return ""


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--server", default="http://127.0.0.1:8787")
    ap.add_argument("--key", default="", help="device key (default: $AIRGUARD_DEVICE_KEY or bridge/device.key)")
    ap.add_argument("--port", action="append", default=[], help="serial port (repeatable); default: all USB ports")
    ap.add_argument("--echo", action="store_true", help="print the boards' log lines too")
    ap.add_argument("--simulate", action="store_true", help="synthetic data, no boards needed")
    args = ap.parse_args()

    key = read_key(args.key)
    if not key:
        print("missing device key: --key, $AIRGUARD_DEVICE_KEY or bridge/device.key\n"
              "create one: docker compose exec airguard-web node server/src/cli.js device:add \"bridge\"",
              file=sys.stderr)
        return 1
    up = Uplink(args.server, key)
    threading.Thread(target=up.run, daemon=True).start()
    log(f"sending to {up.url}")
    try:
        if args.simulate:
            Sim(up).run()
        else:
            try:
                import serial  # noqa: F401
            except ImportError:
                print("pyserial missing: pip install pyserial (or run with ~/.platformio/penv/bin/python)",
                      file=sys.stderr)
                return 1
            watch_ports(args.port, up, args.echo)
    except KeyboardInterrupt:
        log(f"stopped; {up.sent} records sent")
    return 0


if __name__ == "__main__":
    sys.exit(main())
