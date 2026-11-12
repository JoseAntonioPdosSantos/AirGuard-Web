// Telemetry of the AirGuard boards (ESP32 node + RP2040 receiver).
//
// The ESP32 node is the only board on the network: it records every frame it
// sends or receives on LoRa and publishes the records over Wi-Fi to the MQTT
// broker (topic airguard/<device>/telemetry, see mqtt_ingest.js) as
// {now: <its millis>, records: [...]}. POST /api/telemetry/ingest takes the
// same body (simulator, tests). The RP2040 receiver logs nothing: it
// reports to the node over LoRa (rssi/snr in its ACKs, periodic STAT frames)
// and the node forwards that as "gw" records.
// Record kinds: AirGuard-IoT/docs/11_telemetry.md.
//
// What this module keeps:
//   - every accepted record, appended to data/telemetry/YYYY-MM-DD.ndjson
//     (local date), kept RETENTION_DAYS days;
//   - raw environment samples of the last RAW_HOURS hours (memory);
//   - one aggregate per minute (temperature, humidity, gas, RSSI, packets)
//     for the whole retention period (memory, rebuilt from the files);
//   - the last LINK_KEEP radio packets, the node -> receiver conversation;
//   - alert events (ALERT / RECOVERY) for the history markers.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export const RETENTION_DAYS = 30;
export const RAW_HOURS = 48;
export const LINK_KEEP = 400;
export const NODE_ONLINE_MS = 20_000;  // node: heartbeat (tx + env) every 5 s, POST every 2 s
export const GW_ONLINE_MS = 50_000;    // receiver: STAT every 15 s (30 s without heartbeats)
const MAX_SKEW_MS = 5 * 60_000;        // "pc" clock (simulator) vs server clock
const MAX_AGE_MS = 3_600_000;          // a record older than this in a batch: use arrival time
const HB_WINDOW = 32;                  // heartbeats covered by one STAT ("map" bits)
const MINUTE = 60_000;

// Comfort / alarm bands shown on the charts (the node's thresholds.h).
export const DEFAULT_LIMITS = {
  gasMedium: 0.9, gasHigh: 1.5,                  // MQ-135 AO volts
  tempLow: 18, tempHigh: 29,                     // comfort band (°C)
  humLow: 30, humHigh: 75,                       // comfort band (%)
};

export const RANGES = {
  '1h': { span: 3_600_000, step: 10_000 },
  '6h': { span: 6 * 3_600_000, step: 60_000 },
  '24h': { span: 24 * 3_600_000, step: 5 * 60_000 },
  '7d': { span: 7 * 86_400_000, step: 30 * 60_000 },
  '30d': { span: 30 * 86_400_000, step: 2 * 3_600_000 },
};

const SEV = { N: 'NORMAL', L: 'LOW', M: 'MEDIUM', H: 'HIGH' };
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v, max = 40) => (typeof v === 'string' ? v.slice(0, max) : null);

function dayKey(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function parseFrame(s) {
  if (typeof s !== 'string' || s.length > 300) return null;
  try {
    const o = JSON.parse(s);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch { return null; }
}

// What a LoRa frame is: { type, ref } (ref = seq / event_id / ack_for).
function frameInfo(f) {
  if (!f) return { type: '?', ref: null };
  const type = str(f.type, 12) || '?';
  const ref = type === 'HB' ? num(f.seq) : type === 'ACK' ? num(f.ack_for) : num(f.event_id) ?? num(f.message_id);
  return { type, ref };
}

function levelsFromLetters(s) {
  if (typeof s !== 'string' || s.length !== 4) return null;
  const [air, temp, hum, sys] = [...s].map((c) => SEV[c] || 'NORMAL');
  return { air, temp, hum, sys };
}

class Agg {
  constructor(t) { this.t = t; this.f = {}; }
  add(name, v) {
    if (v == null) return;
    const a = this.f[name] || (this.f[name] = { n: 0, sum: 0, min: v, max: v });
    a.n += 1; a.sum += v;
    if (v < a.min) a.min = v;
    if (v > a.max) a.max = v;
  }
  count(name, k = 1) { this.f[name] = (this.f[name] || 0) + k; }
}

export class Telemetry {
  constructor(dir, { now = () => Date.now(), persist = true, limits = DEFAULT_LIMITS } = {}) {
    this.dir = dir;
    this.now = now;
    this.persist = persist;
    this.limits = { ...limits };
    this.raw = [];               // env samples { t, temp, hum, hi, gas, via }
    this.minutes = new Map();    // minute epoch -> Agg
    this.packets = [];           // newest last
    this.alerts = [];            // { t, id, type, cat, sev, prev }
    this.alertIds = new Set();
    this.subs = new Set();
    this.node = { lastSeen: 0, env: null, boot: null };
    this.gw = { lastSeen: 0, stat: null, boot: null, lastRssi: null, lastSnr: null };
    this.seq = 0;
    this.mqtt = { enabled: false, connected: false, url: null, lastMessage: null, error: null };  // set by mqtt_ingest.js
    if (persist) {
      mkdirSync(dir, { recursive: true });
      this.prune();
      this.load();
    }
  }

  // ---- input ---------------------------------------------------------------
  // records: [{ src, k, ms, ... }]. deviceNow = the sender's millis() when it
  // posted the batch: a record's time is now - (deviceNow - ms) (the node has
  // no clock). A record may instead carry "pc" (epoch ms, simulator).
  // Returns how many records were kept.
  ingest(records, deviceNow = null) {
    if (!Array.isArray(records)) return 0;
    const now = this.now();
    const dn = num(deviceNow);
    const lines = [];
    let kept = 0;
    for (const r of records) {
      if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
      if (r.src !== 'node' && r.src !== 'gw') continue;
      if (typeof r.k !== 'string' || r.k.length > 12) continue;
      let t = now;
      if (num(r.pc) != null) t = Math.abs(r.pc - now) > MAX_SKEW_MS ? now : r.pc;
      else if (dn != null && num(r.ms) != null) {
        const age = (dn - r.ms) >>> 0;  // uint32 difference: survives millis() wrap-around
        if (age < MAX_AGE_MS) t = now - age;
      }
      const rec = { ...r, t };
      delete rec.pc;
      this.apply(rec, true);
      if (this.persist) lines.push(JSON.stringify(rec));
      kept += 1;
    }
    if (lines.length) {
      try { appendFileSync(join(this.dir, `${dayKey(now)}.ndjson`), lines.join('\n') + '\n'); }
      catch (e) { console.error(`telemetry write failed: ${e.message}`); }
    }
    return kept;
  }

  // live = false while replaying the files at start-up (no broadcast).
  apply(r, live) {
    const t = r.t;
    if (r.src === 'node') this.node.lastSeen = Math.max(this.node.lastSeen, t);
    else this.gw.lastSeen = Math.max(this.gw.lastSeen, t);

    if (r.src === 'node') {
      switch (r.k) {
        case 'boot':
          this.node.boot = { t, fw: str(r.fw), boot: num(r.boot) };
          if (num(r.gas_med) != null) this.limits.gasMedium = r.gas_med;
          if (num(r.gas_high) != null) this.limits.gasHigh = r.gas_high;
          this.emit(live, 'boot', { src: 'node', t, ...this.node.boot });
          return;
        case 'env': return this.onNodeEnv(r, live);
        case 'tx': return this.onNodeTx(r, live);
        case 'txd': return this.onNodeTxDone(r, live);
        case 'ack': return this.onNodeAck(r, live);
        case 'text': return this.addPacket(live, { t, from: 'gw', type: 'TEXT', ref: num(r.id), tx: null,
          rx: { t, rssi: num(r.rssi), snr: num(r.snr) }, note: str(r.text, 120) });
        case 'rxbad': return this.addPacket(live, { t, from: '?', type: 'INVÁLIDO', ref: null, tx: null,
          rx: { t, rssi: num(r.rssi), snr: num(r.snr) }, status: 'invalid', note: str(r.err) });
        case 'evt': return this.onAlert({ t, id: num(r.id), type: str(r.type), cat: str(r.cat), sev: str(r.sev), prev: str(r.prev) }, live);
        case 'fail': {
          const p = this.findPacket((x) => x.from === 'node' && x.qid === num(r.id));
          if (p) { p.status = 'failed'; this.emit(live, 'packet', p); }
          this.minute(t).count('fail');
          return;
        }
        default: return;
      }
    }
    switch (r.k) {
      case 'stat': return this.onGwStat(r, live);
      default: return;
    }
  }

  onNodeEnv(r, live) {
    const t = r.t;
    const env = {
      t, temp: num(r.temp), hum: num(r.rh), hi: num(r.hi), gas: num(r.gas), ao: num(r.ao), adc: num(r.adc),
      envState: str(r.env), airState: str(r.air), sim: !!r.sim, levels: levelsFromLetters(r.lv), overall: str(r.ov),
      relay: !!r.relay, flags: num(r.flags), lora: str(r.lora), queue: num(r.q), waitAck: num(r.wack), uptime: num(r.up),
    };
    this.node.env = env;
    this.addSample({ t, temp: env.temp, hum: env.hum, hi: env.hi, gas: env.gas, via: 'node' }, live);
  }

  onNodeTx(r, live) {
    const f = parseFrame(r.frame);
    const { type, ref } = frameInfo(f);
    const p = { t: r.t, from: 'node', type, ref, qid: num(r.id), try: num(r.try) || 1, len: num(r.len),
      tx: { t: r.t, airtime: null, ok: null }, rx: null, frame: str(r.frame, 300) };
    if (p.try > 1) p.retry = true;
    this.minute(r.t).count('tx');
    this.addPacket(live, p);
  }

  onNodeTxDone(r, live) {
    const p = this.findPacket((x) => x.from === 'node' && x.qid === num(r.id) && x.tx && x.tx.ok == null);
    if (!p) return;
    p.tx.ok = r.ok === true;
    p.tx.airtime = num(r.air);
    if (!p.tx.ok) p.status = 'txerror';
    this.emit(live, 'packet', p);
  }

  // ACK from the receiver, heard by the node. grssi/gsnr: how the receiver
  // heard the event it confirms.
  onNodeAck(r, live) {
    const id = num(r.id);
    const grssi = num(r.grssi), gsnr = num(r.gsnr);
    this.gwLink(r.t, grssi, gsnr);
    this.addPacket(live, { t: r.t, from: 'gw', type: 'ACK', ref: id, tx: null,
      rx: { t: r.t, rssi: num(r.rssi), snr: num(r.snr) }, dup: !!r.dup, frame: str(r.frame, 300) });
    // the event it confirms (the newest transmission of it)
    const ev = this.findPacket((x) => x.from === 'node' && x.type !== 'HB' && x.type !== 'ACK' && x.ref === id);
    if (ev && !ev.acked) {
      ev.acked = r.t;
      ev.latency = r.t - ev.t;
      ev.rx = { t: null, rssi: grssi, snr: gsnr, res: 'event' };
      this.emit(live, 'packet', ev);
    }
    this.minute(r.t).count('ack');
  }

  // Receiver status (STAT frame) as heard and forwarded by the node.
  //   seq/map: last heartbeat the receiver heard, and which of the HB_WINDOW
  //   heartbeats up to it it heard (bit i = seq - i) -> each heartbeat the node
  //   sent is marked received or lost.
  //   grssi/gsnr: how the receiver hears the node; rssi/snr: how the node heard this STAT.
  onGwStat(r, live) {
    const t = r.t;
    const up = num(r.up);
    // a receiver reboot (uptime went back): its counters restarted
    if (this.gw.stat && up != null && this.gw.stat.up != null && up < this.gw.stat.up) this.gw.boot = { t };
    this.gw.stat = { t, lcd: !!r.lcd, lora: !!r.lora, lost: !!r.lost, events: num(r.events), hbs: num(r.hbs),
      miss: num(r.miss), dups: num(r.dups), bad: num(r.bad), seq: num(r.seq), up };
    this.gwLink(t, num(r.grssi), num(r.gsnr));
    this.emit(live, 'gw', this.gw.stat);
    this.addPacket(live, { t, from: 'gw', type: 'STAT', ref: num(r.seq), tx: null,
      rx: { t, rssi: num(r.rssi), snr: num(r.snr) }, frame: str(r.frame, 300) });

    const seq = num(r.seq), map = num(r.map);
    if (seq == null || map == null || seq < 1) return;
    const decided = new Set();
    for (let i = this.packets.length - 1, n = 0; i >= 0 && n < 300; i -= 1, n += 1) {
      const p = this.packets[i];
      if (t - p.t > 10 * MINUTE) break;
      if (p.from !== 'node' || p.type !== 'HB' || p.ref == null) continue;
      const back = seq - p.ref;
      if (back < 0 || back >= HB_WINDOW || decided.has(p.ref)) continue;
      decided.add(p.ref);  // newest packet with this seq (older ones: before a node reboot)
      if (p.rx || p.status === 'lost') continue;
      if ((map >>> back) & 1) p.rx = { t: null, rssi: null, snr: null, res: 'hb' };
      else p.status = 'lost';
      this.minute(p.t).count(p.rx ? 'hb' : 'lost');
      this.emit(live, 'packet', p);
    }
  }

  // The receiver is alive and hears the node with this rssi/snr.
  gwLink(t, rssi, snr) {
    this.gw.lastSeen = Math.max(this.gw.lastSeen, t);
    if (rssi == null) return;
    this.gw.lastRssi = rssi;
    this.gw.lastSnr = snr;
    const m = this.minute(t);
    m.add('rssi', rssi);
    m.add('snr', snr);
  }

  onAlert(a, live) {
    if (a.id != null && this.alertIds.has(a.id)) return;
    if (a.id != null) this.alertIds.add(a.id);
    this.alerts.push(a);
    const cut = this.now() - RETENTION_DAYS * 86_400_000;
    while (this.alerts.length && this.alerts[0].t < cut) this.alertIds.delete(this.alerts.shift().id);
    this.emit(live, 'alert', a);
  }

  addSample(s, live) {
    this.raw.push(s);
    const cut = s.t - RAW_HOURS * 3_600_000;
    if (this.raw.length > 1000 && this.raw[0].t < cut) {
      let i = 0;
      while (i < this.raw.length && this.raw[i].t < cut) i += 1;
      this.raw.splice(0, i);
    }
    const m = this.minute(s.t);
    m.add('temp', s.temp);
    m.add('hum', s.hum);
    m.add('gas', s.gas);
    this.emit(live, 'env', s);
  }

  addPacket(live, p) {
    p.key = ++this.seq;
    this.packets.push(p);
    if (this.packets.length > LINK_KEEP) this.packets.splice(0, this.packets.length - LINK_KEEP);
    this.emit(live, 'packet', p);
    return p;
  }

  findPacket(pred) {
    for (let i = this.packets.length - 1, n = 0; i >= 0 && n < 60; i -= 1, n += 1)
      if (pred(this.packets[i])) return this.packets[i];
    return null;
  }

  minute(t) {
    const k = Math.floor(t / MINUTE) * MINUTE;
    let m = this.minutes.get(k);
    if (!m) { m = new Agg(k); this.minutes.set(k, m); }
    return m;
  }

  // ---- output --------------------------------------------------------------
  subscribe(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }
  emit(live, type, data) {
    if (!live) return;
    for (const fn of this.subs) { try { fn(type, data); } catch { /* a closed client */ } }
  }

  state() {
    const now = this.now();
    const since = now - 10 * MINUTE;
    let hb = 0, lost = 0, tx = 0, ack = 0, fail = 0;
    for (const [k, m] of this.minutes) {
      if (k < since) continue;
      hb += m.f.hb || 0; lost += m.f.lost || 0; tx += m.f.tx || 0; ack += m.f.ack || 0; fail += m.f.fail || 0;
    }
    const lat = this.packets.filter((p) => p.latency != null).slice(-10).map((p) => p.latency);
    const nodeOnline = now - this.node.lastSeen < NODE_ONLINE_MS;
    const gwOnline = now - this.gw.lastSeen < GW_ONLINE_MS;
    const current = nodeOnline && this.node.env ? { ...this.node.env, via: 'node' } : null;
    return {
      now,
      limits: this.limits,
      current,
      node: { online: nodeOnline, lastSeen: this.node.lastSeen || null, boot: this.node.boot, env: this.node.env },
      gateway: { online: gwOnline, lastSeen: this.gw.lastSeen || null, stat: this.gw.stat, boot: this.gw.boot },
      link: {
        rssi: this.gw.lastRssi, snr: this.gw.lastSnr,
        hbReceived: hb, hbLost: lost, lossPct: hb + lost ? (100 * lost) / (hb + lost) : null,
        txCount: tx, ackCount: ack, failCount: fail,
        ackLatencyMs: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null,
      },
      mqtt: { enabled: this.mqtt.enabled, connected: this.mqtt.connected, lastMessage: this.mqtt.lastMessage, error: this.mqtt.error },
      packets: this.packets.slice(-120),
      alerts: this.alerts.slice(-20),
    };
  }

  // Bucketed series for the charts: [{ t, temp, tempMin, tempMax, hum, ..., gasMax, rssi, loss }].
  history(rangeName) {
    const range = RANGES[rangeName] || RANGES['24h'];
    const now = this.now();
    const from = Math.floor((now - range.span) / range.step) * range.step;
    const buckets = new Map();
    const bucket = (t) => {
      const k = Math.floor(t / range.step) * range.step;
      let b = buckets.get(k);
      if (!b) { b = new Agg(k); buckets.set(k, b); }
      return b;
    };
    const merge = (b, name, a) => {
      if (!a) return;
      const x = b.f[name] || (b.f[name] = { n: 0, sum: 0, min: a.min, max: a.max });
      x.n += a.n; x.sum += a.sum;
      if (a.min < x.min) x.min = a.min;
      if (a.max > x.max) x.max = a.max;
    };
    if (range.step < MINUTE) {
      for (const s of this.raw) {
        if (s.t < from) continue;
        const b = bucket(s.t);
        b.add('temp', s.temp); b.add('hum', s.hum); b.add('gas', s.gas);
      }
      for (const [k, m] of this.minutes) {
        if (k < from - MINUTE) continue;
        const b = bucket(k);
        merge(b, 'rssi', m.f.rssi); merge(b, 'snr', m.f.snr);
        b.count('hb', m.f.hb || 0); b.count('lost', m.f.lost || 0);
      }
    } else {
      for (const [k, m] of this.minutes) {
        if (k < from) continue;
        const b = bucket(k);
        for (const name of ['temp', 'hum', 'gas', 'rssi', 'snr']) merge(b, name, m.f[name]);
        b.count('hb', m.f.hb || 0); b.count('lost', m.f.lost || 0);
      }
    }
    const r2 = (v, d) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
    const avg = (a, d) => (a ? r2(a.sum / a.n, d) : null);
    const points = [...buckets.values()].sort((a, b) => a.t - b.t).map((b) => {
      const hb = b.f.hb || 0, lost = b.f.lost || 0;
      return {
        t: b.t,
        temp: avg(b.f.temp, 1), tempMin: r2(b.f.temp?.min, 1), tempMax: r2(b.f.temp?.max, 1),
        hum: avg(b.f.hum, 0), humMin: r2(b.f.hum?.min, 0), humMax: r2(b.f.hum?.max, 0),
        gas: avg(b.f.gas, 3), gasMax: r2(b.f.gas?.max, 3),
        rssi: avg(b.f.rssi, 0), snr: avg(b.f.snr, 1),
        loss: hb + lost ? r2((100 * lost) / (hb + lost), 1) : null,
      };
    });
    const alerts = this.alerts.filter((a) => a.t >= from);
    return { range: rangeName in RANGES ? rangeName : '24h', from, to: now, step: range.step, points, alerts, limits: this.limits };
  }

  // ---- files ---------------------------------------------------------------
  files() {
    return readdirSync(this.dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.ndjson$/.test(f)).sort();
  }

  prune() {
    const keep = new Set();
    for (let i = 0; i < RETENTION_DAYS; i += 1) keep.add(`${dayKey(this.now() - i * 86_400_000)}.ndjson`);
    for (const f of this.files()) if (!keep.has(f)) { try { unlinkSync(join(this.dir, f)); } catch { /* ignore */ } }
  }

  load() {
    let n = 0;
    for (const f of this.files()) {
      const p = join(this.dir, f);
      if (!existsSync(p)) continue;
      for (const line of readFileSync(p, 'utf8').split('\n')) {
        if (!line) continue;
        try { this.apply(JSON.parse(line), false); n += 1; } catch { /* torn last line */ }
      }
    }
    // the live state is not known after a restart: only history is replayed
    this.node.lastSeen = 0; this.gw.lastSeen = 0;
    return n;
  }
}
