#!/usr/bin/env python3
"""AirGuard node simulator: synthetic telemetry for testing the Ambiente page
without the boards.

Sends exactly what the ESP32 node sends over Wi-Fi (POST /api/telemetry/ingest,
header X-Device-Key, body {"now": <millis>, "records": [...]}): a heartbeat
every 5 s with its readings, the receiver's STAT every 15 s, a gas leak test
about every 4 minutes (ALERT/RECOVERY + ACK) and ~4 % of heartbeats lost.

    docker compose exec airguard-web node server/src/cli.js device:add "simulador"
    python3 tools/simulate_node.py --key <key> [--server http://127.0.0.1:8787]

Standard library only.
"""
import argparse
import json
import math
import os
import random
import sys
import time
import urllib.error
import urllib.request

GAS_MED, GAS_HIGH, HYST = 0.90, 1.5, 0.05


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


class Node:
    def __init__(self, server, key):
        self.url = server.rstrip("/") + "/api/telemetry/ingest"
        self.key = key
        self.t0 = time.time()
        self.q = []
        self.seq = 0
        self.event_id = (1 << 16) * 7
        self.gas_level = "NORMAL"
        self.spike_at = time.time() + 40
        self.heard = []  # heartbeat seqs the "receiver" heard
        self.gw_hbs = self.gw_miss = self.gw_events = 0
        self.last_post = 0.0

    def ms(self):
        return int((time.time() - self.t0) * 1000) & 0xFFFFFFFF

    def put(self, src, k, **f):
        self.q.append({"src": src, "k": k, "ms": self.ms(), **f})

    def post(self):
        if not self.q or time.time() - self.last_post < 2:
            return
        self.last_post = time.time()
        body = json.dumps({"now": self.ms(), "records": self.q[:60]}).encode()
        req = urllib.request.Request(self.url, data=body, method="POST", headers={
            "content-type": "application/json", "x-device-key": self.key})
        try:
            with urllib.request.urlopen(req, timeout=4) as r:
                r.read()
            del self.q[:60]
        except urllib.error.HTTPError as e:
            log(f"HTTP {e.code}" + (" (device key not accepted)" if e.code == 401 else ""))
            if e.code == 400:
                del self.q[:60]
        except (urllib.error.URLError, OSError) as e:
            log(f"server unreachable: {e}")
        del self.q[:-3000]

    def readings(self):
        t = time.time()
        temp = 25.0 + 1.6 * math.sin(t / 900) + random.gauss(0, 0.05)
        hum = 60 + 6 * math.sin(t / 1300 + 1) + random.gauss(0, 0.4)
        gas = 0.45 + 0.03 * math.sin(t / 60) + random.gauss(0, 0.01)
        d = t - self.spike_at
        if 0 <= d < 50:
            gas += 1.45 * math.sin(math.pi * d / 50) ** 2
        elif d >= 240:
            self.spike_at = t + random.uniform(0, 30)
        return round(temp, 1), round(hum), round(max(gas, 0.05), 3)

    def level(self, gas):
        lv = self.gas_level
        if gas >= GAS_HIGH or (lv == "HIGH" and gas >= GAS_HIGH - HYST):
            return "HIGH"
        if gas >= GAS_MED or (lv != "NORMAL" and gas >= GAS_MED - HYST):
            return "MEDIUM"
        return "NORMAL"

    def env(self, temp, hum, gas, letters):
        self.put("node", "env", temp=temp, rh=hum, hi=temp, env="ok", gas=gas, ao=gas, adc=int(gas / 5 * 4095),
                 air="ok", lv=letters, ov=self.gas_level, relay=self.gas_level == "HIGH", flags=0, lora="ok",
                 q=0, wack=0, up=self.ms() // 1000)

    def transmit(self, frame, qid, kind, reading):
        text = json.dumps(frame, separators=(",", ":"))
        self.env(*reading)
        self.put("node", "tx", id=qid, kind=kind, len=len(text), frame=text, **{"try": 1})
        air = 300 + len(text)
        time.sleep(air / 1000)
        self.put("node", "txd", id=qid, kind=kind, ok=True, air=air)
        lost = random.random() < 0.04
        rssi, snr = round(-34 + random.gauss(0, 3)), round(10 + random.gauss(0, 1.2))
        if kind == "hb" and not lost:
            self.heard.append(frame["seq"])
            self.gw_hbs += 1
            self.rssi, self.snr = rssi, snr
        elif kind == "hb":
            self.gw_miss += 1
        if kind == "event" and not lost:
            self.gw_events += 1
            time.sleep(0.3)
            ack = {"type": "ACK", "device": "GATEWAY_01", "dst": "KITCHEN_01", "ack_for": frame["event_id"],
                   "rssi": rssi, "snr": snr}
            self.put("node", "ack", id=frame["event_id"], **{"from": "GATEWAY_01"}, rssi=rssi + random.randint(-2, 2),
                     snr=snr, grssi=rssi, gsnr=snr, frame=json.dumps(ack, separators=(",", ":")))

    def stat(self):
        seq = self.seq
        m = 0
        for s in self.heard:
            if 0 <= seq - s < 32:
                m |= 1 << (seq - s)
        frame = {"type": "STAT", "device": "GATEWAY_01", "dst": "KITCHEN_01", "seq": seq, "map": m,
                 "hbs": self.gw_hbs, "miss": self.gw_miss, "ev": self.gw_events, "dup": 0, "bad": 0,
                 "rssi": getattr(self, "rssi", -34), "snr": getattr(self, "snr", 10), "lcd": 1, "lora": 1,
                 "lost": 0, "up": self.ms() // 1000 + 30}
        self.put("gw", "stat", seq=seq, map=m, hbs=self.gw_hbs, miss=self.gw_miss, events=self.gw_events, dups=0,
                 bad=0, up=frame["up"], lcd=True, lora=True, lost=False, grssi=frame["rssi"], gsnr=frame["snr"],
                 rssi=round(-36 + random.gauss(0, 3)), snr=9.5, frame=json.dumps(frame, separators=(",", ":")))

    def run(self):
        log(f"simulating the ESP32 node -> {self.url}")
        self.put("node", "boot", fw="1.0.0", device="KITCHEN_01", gateway="GATEWAY_01", boot=7,
                 gas_med=GAS_MED, gas_high=GAS_HIGH)
        last_hb = last_stat = 0.0
        while True:
            now = time.time()
            temp, hum, gas = self.readings()
            lv = self.level(gas)
            letters = {"NORMAL": "N", "MEDIUM": "M", "HIGH": "H"}[lv] + "NNN"
            if lv != self.gas_level:
                prev, self.gas_level = self.gas_level, lv
                self.event_id += 1
                typ = "RECOVERY" if lv == "NORMAL" else "ALERT"
                self.put("node", "evt", id=self.event_id, type=typ, cat="AIR_QUALITY", sev=lv, prev=prev)
                frame = {"v": 1, "type": typ, "device": "KITCHEN_01", "dst": "GATEWAY_01", "event_id": self.event_id,
                         "category": "AIR_QUALITY", "severity": lv, "prev": prev, "sensor": "MQ135",
                         "air_index": round(gas * 20), "temperature": temp, "humidity": hum,
                         "timestamp": self.ms() // 1000}
                self.transmit(frame, self.event_id, "event", (temp, hum, gas, letters))
            if now - last_hb >= 5:
                last_hb = now
                self.seq += 1
                frame = {"v": 1, "type": "HB", "device": "KITCHEN_01", "dst": "GATEWAY_01", "seq": self.seq,
                         "levels": letters, "air_index": round(gas * 20), "temperature": temp, "humidity": hum,
                         "timestamp": self.ms() // 1000}
                self.transmit(frame, 0xE0000000 | self.seq, "hb", (temp, hum, gas, letters))
                if now - last_stat >= 15:
                    last_stat = now
                    time.sleep(0.25)
                    self.stat()
            self.post()
            time.sleep(0.2)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--server", default="http://127.0.0.1:8787")
    ap.add_argument("--key", default=os.environ.get("AIRGUARD_DEVICE_KEY", ""))
    a = ap.parse_args()
    if not a.key:
        print("missing --key (or $AIRGUARD_DEVICE_KEY)", file=sys.stderr)
        return 1
    try:
        Node(a.server, a.key).run()
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
