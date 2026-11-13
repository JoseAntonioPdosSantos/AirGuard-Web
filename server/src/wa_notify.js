// Alert messages for WhatsApp, from the state the node publishes on MQTT
// (airguard/<device>/state, retained):
//   {"boot":12,"up":345,"lv":"NNHN","relay":true,"flags":0,"temp":27.5,"rh":61,"gas":1.82}
//
// The node sends its STATE, not events: every change and again every 30 s. A
// message is written when the state differs from the last one reported, so a
// lost publish or a restart of this server only delays a message, and a
// repeated state never produces a second one. Pure: time comes from the caller.

export const CATS = [
  { key: 'air', label: 'Gás' },
  { key: 'temp', label: 'Temperatura' },
  { key: 'hum', label: 'Umidade' },
  { key: 'sys', label: 'Sistema' },
];
const LETTER = { N: 0, L: 1, M: 2, H: 3 };
const GRAVITY = ['normal', 'BAIXA', 'MÉDIA', 'ALTA'];
const ICON = ['✅', '🟡', '🟠', '🚨'];

// Bits of "flags" (AirGuard-IoT src/monitoring/alert_types.h).
const SYSTEM_FLAGS = [
  [1, 'sensor de temperatura/umidade sem leitura'],
  [2, 'sensor de gás (MQ-135) sem leitura'],
  [8, 'rádio LoRa com falha'],
  [16, 'o receptor não confirma os alertas (LoRa)'],
  [32, 'visor OLED com falha'],
];

const fin = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// Validates what the node sent. null = not a node state.
export function parseNodeState(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  if (typeof o.lv !== 'string' || !/^[NLMH]{4}$/.test(o.lv)) return null;
  return {
    lv: [...o.lv].map((c) => LETTER[c]),
    relay: o.relay === true,
    flags: Number.isInteger(o.flags) && o.flags >= 0 ? o.flags : 0,
    boot: fin(o.boot), up: fin(o.up),
    temp: fin(o.temp), rh: fin(o.rh), gas: fin(o.gas),
    sim: o.sim === true,
  };
}

export const NORMAL = Object.freeze({ lv: Object.freeze([0, 0, 0, 0]), relay: false });
const same = (a, b) => a.relay === b.relay && a.lv.every((v, i) => v === b.lv[i]);

// What changed from `prev` to `cur`: levels per category and the relay.
export function diffState(prev, cur) {
  const levels = [];
  for (let i = 0; i < CATS.length; i += 1)
    if (prev.lv[i] !== cur.lv[i]) levels.push({ cat: i, from: prev.lv[i], to: cur.lv[i] });
  const relay = prev.relay === cur.relay ? null : cur.relay;
  return {
    levels, relay,
    any: levels.length > 0 || relay !== null,
    // something got worse: said at once (a recovery waits to be stable)
    worse: levels.some((c) => c.to > c.from) || relay === true,
  };
}

const br = (v, d) => v.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });

function readings(s) {
  const p = [];
  if (s.gas != null) p.push(`gás ${br(s.gas, 2)} V`);
  if (s.temp != null) p.push(`${br(s.temp, 1)} °C`);
  if (s.rh != null) p.push(`${br(s.rh, 0)} %`);
  return p.join(' · ');
}

function systemDetail(flags) {
  const what = SYSTEM_FLAGS.filter(([bit]) => flags & bit).map(([, text]) => text);
  return what.length ? ` (${what.join('; ')})` : '';
}

function delay(ms) {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h} h ${String(min % 60).padStart(2, '0')} min`;
}

// The WhatsApp text for one change. cur = the node's state now (readings,
// flags); lateMs = how long ago it happened, when the message could not go out
// at once.
export function alertText(diff, cur, { device = '', lateMs = 0 } = {}) {
  const worst = Math.max(0, ...diff.levels.map((c) => c.to));
  const alert = diff.levels.some((c) => c.to > 0);
  let title;
  if (alert) title = `${ICON[worst]} *AirGuard: ALERTA*`;
  else if (diff.levels.length) title = '✅ *AirGuard: NORMALIZADO*';
  else title = diff.relay ? '⚡ *AirGuard: ENERGIA DESLIGADA*' : '🔌 *AirGuard: ENERGIA RELIGADA*';

  const lines = [title];
  for (const c of diff.levels) {
    const name = CATS[c.cat].label;
    const detail = c.cat === 3 && c.to > 0 ? systemDetail(cur.flags) : '';
    if (c.to === 0) {
      lines.push(`*Alerta:* ${name} voltou ao normal (estava em gravidade ${GRAVITY[c.from]})`);
    } else {
      lines.push(`*Alerta:* ${name}${detail}`);
      const before = c.from === 0 ? '' : c.to > c.from ? ` (subiu, antes ${GRAVITY[c.from]})` : ` (baixou, antes ${GRAVITY[c.from]})`;
      lines.push(`*Gravidade:* ${GRAVITY[c.to]}${before}`);
    }
  }
  if (diff.relay === true) lines.push('⚡ *Relé:* desligou a energia da residência');
  if (diff.relay === false) lines.push('🔌 *Relé:* religou a energia da residência');

  // other categories still in alert, so "normalizado" is not read as "all clear"
  const changed = new Set(diff.levels.map((c) => c.cat));
  const still = cur.lv.map((v, i) => ({ v, i })).filter((x) => x.v > 0 && !changed.has(x.i))
    .map((x) => `${CATS[x.i].label} ${GRAVITY[x.v]}`);
  if (still.length) lines.push(`*Continua em alerta:* ${still.join(', ')}`);
  if (diff.relay === null && cur.relay && diff.levels.length) lines.push('*Relé:* a energia da residência continua desligada');

  const r = readings(cur);
  if (r) lines.push(`*Leituras:* ${r}`);
  const foot = [device, cur.sim ? 'SIMULAÇÃO' : '', lateMs >= 60_000 ? `ocorrido há ${delay(lateMs)}` : ''].filter(Boolean);
  if (foot.length) lines.push(`_${foot.join(' · ')}_`);
  return lines.join('\n');
}

export class Notifier {
  // saved: { <device>: { lv: [..4], relay } } = what was already reported (survives restarts).
  constructor({ saved = {}, minGapMs = 5000, recoveryDelayMs = 3000, settleS = 60 } = {}) {
    this.minGapMs = minGapMs;
    this.recoveryDelayMs = recoveryDelayMs;
    this.settleS = settleS;
    this.dev = new Map();
    for (const [id, s] of Object.entries(saved || {})) {
      if (Array.isArray(s?.lv) && s.lv.length === 4 && s.lv.every((v) => Number.isInteger(v) && v >= 0 && v <= 3))
        this.dev.set(id, { reported: { lv: [...s.lv], relay: s.relay === true }, cur: null, dueAt: null, lastSentAt: null });
    }
  }

  entry(device) {
    let d = this.dev.get(device);
    if (!d) {
      d = { reported: { lv: [...NORMAL.lv], relay: false }, cur: null, dueAt: null, lastSentAt: null };
      this.dev.set(device, d);
    }
    return d;
  }

  // The state to compare with what was reported. Right after a boot the node
  // has not confirmed its readings yet (every level restarts at normal), so
  // for `settleS` seconds only what got WORSE counts: no false "normalizado".
  target(d) {
    const c = d.cur;
    if (c.up == null || c.up >= this.settleS) return { lv: [...c.lv], relay: c.relay };
    return { lv: c.lv.map((v, i) => Math.max(v, d.reported.lv[i])), relay: c.relay || d.reported.relay };
  }

  // A state arrived from the node.
  onState(device, state, now) {
    const d = this.entry(device);
    d.cur = state;
    const target = this.target(d);
    const diff = diffState(d.reported, target);
    if (!diff.any) { d.dueAt = null; d.pending = null; return; }  // back to what was already reported
    // worse: now. Only better: after it stays so for recoveryDelayMs (a level
    // flapping around a threshold does not produce a message per flap). The
    // node repeats its state every 30 s: the same pending state keeps its time.
    const key = target.lv.join('') + (target.relay ? 'R' : '-');
    if (diff.worse) d.dueAt = d.dueAt == null ? now : Math.min(d.dueAt, now);
    else if (d.dueAt == null || d.pending !== key) d.dueAt = now + this.recoveryDelayMs;
    d.pending = key;
  }

  // Changes whose time has come: [{ device, t, kind, diff, state }] (the text
  // is written by alertText when the message is really sent).
  poll(now) {
    const out = [];
    for (const [device, d] of this.dev) {
      if (d.dueAt == null || !d.cur) continue;
      if (now < d.dueAt || (d.lastSentAt != null && now - d.lastSentAt < this.minGapMs)) continue;
      const target = this.target(d);
      const diff = diffState(d.reported, target);
      d.dueAt = null;
      d.pending = null;
      if (!diff.any) continue;
      d.reported = target;
      d.lastSentAt = now;
      const kind = diff.levels.some((c) => c.to > 0) ? 'alert' : diff.levels.length ? 'recovery' : 'relay';
      out.push({ device, t: now, kind, diff, state: { ...d.cur, lv: [...target.lv], relay: target.relay } });
    }
    return out;
  }

  // What to persist.
  snapshot() {
    const o = {};
    for (const [id, d] of this.dev) o[id] = { lv: [...d.reported.lv], relay: d.reported.relay };
    return o;
  }

  reportedIsNormal(device) {
    const d = this.dev.get(device);
    return !d || same(d.reported, NORMAL);
  }
}
