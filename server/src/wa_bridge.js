// WhatsApp <-> MQTT <-> AirGuard node. This module is the only one that knows
// both sides (docs: AirGuard-IoT/docs/12_whatsapp.md):
//
//   node -> here   airguard/<device>/state  (retained) alert levels, relay, readings
//                  airguard/<device>/event             {"k":"hello"} after boot,
//                                                      {"k":"wa","id":7,"res":"shown"}
//   here -> node   airguard/whatsapp/link   (retained) session state / pairing code
//                  airguard/whatsapp/inbox             one message received
//
//   * a change in the node's state becomes a WhatsApp message to the linked
//     account's own number (which alert, how severe, back to normal, relay);
//   * a message received on WhatsApp goes to the node, which shows it on the
//     OLED and relays it to the LCD, unless an alert is active there;
//   * a node that was just switched on gets the pairing code when no account
//     is linked and the number of the account is known (typed once on the
//     page); without a number the page offers a QR code.
//
// It keeps what the monitoring page shows: the messages received and the
// alert messages sent (data/whatsapp/*.ndjson).
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { Notifier, alertText, parseNodeState } from './wa_notify.js';
import { STORED_TEXT_MAX, displayMessage, formatNumber, phoneKey, plainLine, shorten } from './wa_text.js';

export const TOPIC_LINK = 'airguard/whatsapp/link';
export const TOPIC_INBOX = 'airguard/whatsapp/inbox';
export const TOPICS_NODE = ['airguard/+/state', 'airguard/+/event'];
const NODE_TOPIC_RE = /^airguard\/([A-Za-z0-9_-]{1,32})\/(state|event)$/;
export const OFFLINE_LINK = JSON.stringify({ state: 'offline' });

export const KEEP_MESSAGES = 500;
export const KEEP_NOTICES = 100;
export const NODE_ONLINE_MS = 75_000;   // the node repeats its state every 30 s
const FRESH_MS = 120_000;               // older messages (delivered after a reconnection) are not sent to the displays
const OUTBOX_MAX = 20;
const OUTBOX_MAX_AGE_MS = 6 * 3_600_000;
const MAX_PAYLOAD = 4096;

// Append-only list in a .ndjson file, newest last, rewritten when it grows.
class JsonLog {
  constructor(file, keep, persist) {
    this.file = file; this.keep = keep; this.persist = persist;
    this.items = []; this.lines = 0;
    if (!persist || !existsSync(file)) return;
    const byId = new Map();
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue;
      this.lines += 1;
      try {
        const o = JSON.parse(line);
        if (o && Number.isInteger(o.id)) byId.set(o.id, { ...(byId.get(o.id) || {}), ...o });
      } catch { /* torn last line */ }
    }
    this.items = [...byId.values()].sort((a, b) => a.id - b.id).slice(-keep);
  }
  get nextId() { return (this.items.at(-1)?.id || 0) + 1; }
  add(item) {
    this.items.push(item);
    if (this.items.length > this.keep) this.items.splice(0, this.items.length - this.keep);
    this.write(item);
    return item;
  }
  // changes fields of an item already stored (written as a second line with the same id)
  update(id, fields) {
    const it = this.items.find((x) => x.id === id);
    if (!it) return null;
    Object.assign(it, fields);
    this.write({ id, ...fields });
    return it;
  }
  write(o) {
    if (!this.persist) return;
    try {
      if (this.lines > this.keep * 4) {  // compact: one line per item kept
        const tmp = `${this.file}.tmp`;
        writeFileSync(tmp, this.items.map((x) => JSON.stringify(x)).join('\n') + '\n', { mode: 0o600 });
        renameSync(tmp, this.file);
        this.lines = this.items.length;
        return;
      }
      appendFileSync(this.file, JSON.stringify(o) + '\n', { mode: 0o600 });
      this.lines += 1;
    } catch (e) { console.error(`whatsapp log write failed: ${e.message}`); }
  }
}

export class WaBridge {
  // wa: WhatsApp service; publish(topic, payload, opts): MQTT; contacts(): [{ name, phone }]
  constructor({ wa, dir, publish = () => {}, contacts = () => [], log = () => {}, now = () => Date.now(), persist = true }) {
    this.wa = wa;
    this.dir = dir;
    this.publish = publish;
    this.contacts = contacts;
    this.log = log;
    this.now = now;
    this.persist = persist;
    if (persist) mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.messages = new JsonLog(join(dir, 'messages.ndjson'), KEEP_MESSAGES, persist);
    this.notices = new JsonLog(join(dir, 'notices.ndjson'), KEEP_NOTICES, persist);
    this.reportedFile = join(dir, 'reported.json');
    let saved = {};
    if (persist && existsSync(this.reportedFile)) {
      try { saved = JSON.parse(readFileSync(this.reportedFile, 'utf8')); } catch { saved = {}; }
    }
    this.notifier = new Notifier({ saved });
    this.nodes = new Map();     // device -> { lastSeen, state }
    this.outbox = [];           // alert messages waiting for the WhatsApp session
    this.sending = false;
    this.subs = new Set();
    this.seenWa = new Set();    // WhatsApp ids already handled (a message can be delivered twice)
    for (const m of this.messages.items) if (m.waId) this.seenWa.add(m.waId);
    // an alert message that was waiting when the server stopped cannot be sent any more
    for (const n of this.notices.items) if (n.status === 'queued') this.notices.update(n.id, { status: 'dropped', reason: 'restart' });

    wa.on('state', (st) => {
      this.publishLink();
      this.emit('link', st);
      if (st.state === 'open') void this.flush();
    });
    wa.on('message', (m) => this.onWhatsAppMessage(m));
  }

  // ---- live updates for the page ---------------------------------------------
  subscribe(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }
  emit(type, data) { for (const fn of this.subs) { try { fn(type, data); } catch { /* a closed client */ } } }

  // ---- MQTT -------------------------------------------------------------------
  // What the node needs to know about the session (retained).
  linkPayload() {
    const s = this.wa.status();
    if (s.state === 'code' && s.code) return { state: 'code', code: s.code.code, ttl: s.code.ttl };
    if (s.state === 'qr') return { state: 'qr' };  // the QR itself is for the page only
    if (s.state === 'open') return { state: 'open', me: s.me?.number || '' };
    if (s.state === 'connecting') return { state: 'connecting' };
    return { state: 'idle' };
  }
  publishLink() { this.publish(TOPIC_LINK, JSON.stringify(this.linkPayload()), { qos: 1, retain: true }); }

  // One MQTT message from a node. retained = delivered from the broker's
  // memory when we subscribed (the node may not be there any more).
  onMqtt(topic, payload, retained = false) {
    const m = NODE_TOPIC_RE.exec(topic);
    if (!m || m[1] === 'whatsapp') return { ignored: 'topic' };
    if (payload.length === 0) return { ignored: 'empty' };  // a retained message being cleared
    if (payload.length > MAX_PAYLOAD) return { error: 'too_large' };
    let o;
    try { o = JSON.parse(payload.toString('utf8')); } catch { return { error: 'json' }; }
    const device = m[1];
    if (m[2] === 'state') {
      const st = parseNodeState(o);
      if (!st) return { error: 'state' };
      const now = this.now();
      const n = this.nodes.get(device) || { lastSeen: 0, state: null };
      n.state = st;
      if (!retained) n.lastSeen = now;
      this.nodes.set(device, n);
      this.notifier.onState(device, st, now);
      this.emit('node', this.nodeView());
      return { device, state: true };
    }
    if (!o || typeof o !== 'object') return { error: 'event' };
    if (o.k === 'hello') {
      // "the node was just switched on": no linked account -> pairing code for
      // its OLED (or, with no number saved, a QR on the page)
      this.log(`whatsapp: node ${device} started (boot ${Number.isInteger(o.boot) ? o.boot : '?'})`);
      if (!retained) void this.wa.pair().then((r) => { if (r === 'started') this.log('whatsapp: no account linked, pairing started for the node'); })
        .catch((e) => this.log(`whatsapp: pairing: ${e.message}`));
      return { device, hello: true };
    }
    if (o.k === 'wa' && Number.isInteger(o.id) && typeof o.res === 'string') {
      // what the node did with a message: shown | queued | ignored (alert) | full | empty
      const it = this.messages.update(o.id, { result: o.res.slice(0, 12) });
      if (it) this.emit('message', this.named(it));
      return { device, result: !!it };
    }
    return { ignored: 'event' };
  }

  nodeOnline() {
    const now = this.now();
    for (const n of this.nodes.values()) if (now - n.lastSeen < NODE_ONLINE_MS) return true;
    return false;
  }

  nodeView() {
    const now = this.now();
    return [...this.nodes.entries()].map(([device, n]) => ({
      device, online: now - n.lastSeen < NODE_ONLINE_MS, lastSeen: n.lastSeen || null,
      levels: n.state?.lv ?? null, relay: !!n.state?.relay, alert: !!n.state && n.state.lv.some((v) => v > 0),
    }));
  }

  // ---- WhatsApp -> node --------------------------------------------------------
  // Who a sender is, { name, nameFrom }:
  //   airguard  the contact registered in AirGuard (any user) with this number
  //   phone     the name saved in the address book of the phone
  //   profile   the name the sender chose on WhatsApp (not a contact of ours)
  //   number    no name at all: the number
  nameFor(number, pushName, saved = '') {
    if (number) {
      const k = phoneKey(number);
      const c = this.contacts().find((x) => phoneKey(x.phone) === k);
      if (c) return { name: c.name, nameFrom: 'airguard' };
    }
    if (saved) return { name: saved, nameFrom: 'phone' };
    const profile = plainLine(pushName);
    if (/[\p{L}\p{N}]/u.test(profile)) return { name: profile, nameFrom: 'profile' };  // "~" or only symbols is no name
    return { name: formatNumber(number) || 'Desconhecido', nameFrom: 'number' };
  }

  // A stored message with the name its sender has today: a contact saved (or
  // renamed) after the message arrived shows up in the list as well.
  named(item) {
    const saved = this.wa.savedName?.(item.group ? [] : [item.chat], item.number) || '';
    const who = this.nameFor(item.number, item.profile ?? (item.nameFrom === 'profile' ? item.name : ''), saved);
    return who.name === item.name && who.nameFrom === item.nameFrom ? item : { ...item, ...who };
  }

  onWhatsAppMessage(m) {
    if (m.waId) {
      if (this.seenWa.has(m.waId)) return null;
      this.seenWa.add(m.waId);
      if (this.seenWa.size > 4 * KEEP_MESSAGES) this.seenWa = new Set([...this.seenWa].slice(-2 * KEEP_MESSAGES));
    }
    const now = this.now();
    const { name, nameFrom } = this.nameFor(m.number, m.name, m.saved);
    const item = {
      id: this.messages.nextId, t: m.t || now, at: now, waId: m.waId || '',
      chat: m.chat, group: !!m.group, number: m.number || '', numberDisplay: formatNumber(m.number), name, nameFrom,
      profile: shorten(plainLine(m.name), 40),
      kind: m.kind, text: shorten(String(m.text ?? ''), STORED_TEXT_MAX),
      node: 'none', result: null,
    };
    const disp = displayMessage(name, item.text);
    if (now - item.t > FRESH_MS) item.node = 'old';           // arrived while we were offline
    else if (!disp) item.node = 'empty';                       // only emoji / nothing printable
    else if (!this.nodeOnline()) item.node = 'offline';
    else {
      this.publish(TOPIC_INBOX, JSON.stringify({ id: item.id, from: disp.from, text: disp.text }), { qos: 0, retain: false });
      item.node = 'sent';
    }
    this.messages.add(item);
    // no content in the server log: only that something arrived
    this.log(`whatsapp: message #${item.id} received (${item.group ? 'group' : 'direct'}, ${item.kind}, ${[...item.text].length} chars) -> node: ${item.node}`);
    this.emit('message', item);
    return item;
  }

  // ---- node state -> WhatsApp ------------------------------------------------------
  // Call often (the server does it twice a second).
  tick() {
    const now = this.now();
    for (const n of this.notifier.poll(now)) {
      this.saveReported();
      const base = { id: this.notices.nextId, t: n.t, device: n.device, kind: n.kind,
        text: alertText(n.diff, n.state, { device: n.device }), status: 'queued', sentAt: null, reason: null };
      if (!this.wa.status().linked) {
        // nobody to tell: recorded for the page, not kept for later
        this.emit('notice', this.notices.add({ ...base, status: 'dropped', reason: 'not_linked' }));
        this.log(`whatsapp: ${n.kind} of ${n.device} not sent (no account linked)`);
        continue;
      }
      const item = this.notices.add(base);
      this.outbox.push({ id: item.id, n });
      while (this.outbox.length > OUTBOX_MAX) this.drop(this.outbox.shift(), 'overflow');
      this.emit('notice', item);
    }
    if (this.outbox.length) void this.flush();
  }

  drop(entry, reason) {
    const it = this.notices.update(entry.id, { status: 'dropped', reason });
    if (it) this.emit('notice', it);
  }

  // Sends what is waiting, oldest first, while the session is open.
  async flush() {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.outbox.length && this.wa.status().state === 'open') {
        const entry = this.outbox[0];
        const now = this.now();
        if (now - entry.n.t > OUTBOX_MAX_AGE_MS) { this.outbox.shift(); this.drop(entry, 'too_old'); continue; }
        const text = alertText(entry.n.diff, entry.n.state, { device: entry.n.device, lateMs: now - entry.n.t });
        try {
          await this.wa.sendToSelf(text);
        } catch (e) {
          this.log(`whatsapp: alert message not sent yet (${e.message})`);
          break;  // stays first in the queue; tried again on the next tick
        }
        this.outbox.shift();
        const it = this.notices.update(entry.id, { status: 'sent', sentAt: this.now(), text });
        if (it) this.emit('notice', it);
        this.log(`whatsapp: ${entry.n.kind} of ${entry.n.device} sent to the own number`);
      }
    } finally { this.sending = false; }
  }

  saveReported() {
    if (!this.persist) return;
    try {
      const tmp = `${this.reportedFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.notifier.snapshot()), { mode: 0o600 });
      renameSync(tmp, this.reportedFile);
    } catch (e) { console.error(`whatsapp state write failed: ${e.message}`); }
  }

  // ---- page ---------------------------------------------------------------------
  view() {
    return {
      now: this.now(),
      link: this.wa.status(),
      groups: !!this.wa.groups,
      nodes: this.nodeView(),
      messages: this.messages.items.slice(-200).map((m) => this.named(m)),
      notices: this.notices.items.slice(-30),
    };
  }

  // Asked on the page. number (digits, with country code): pair with the
  // 8-character code, shown on the page and on the node's OLED; without it,
  // with a QR code on the page. An attempt already running starts again.
  async connect({ number = null } = {}) {
    if (number) {
      this.wa.setPairNumber(number);
      return this.wa.pair({ mode: 'code', restart: true });
    }
    return this.wa.pair({ mode: 'qr', restart: true });
  }
  async disconnect() {
    for (const e of this.outbox.splice(0)) this.drop(e, 'unlinked');
    await this.wa.logout();
  }
}

// Wires the bridge to the broker with its own MQTT connection (the telemetry
// subscriber keeps its own). The broker publishes {"state":"offline"} for us
// if this server dies, so a node never keeps showing a stale QR.
export function startWaBridge(mqttLib, { wa, dir, url, username, password, contacts, log = () => {} }) {
  const client = mqttLib.connect(url, {
    username: username || undefined,
    password: password || undefined,
    clientId: `airguard-web-wa-${process.pid}`,
    reconnectPeriod: 5000,
    connectTimeout: 10_000,
    keepalive: 30,
    will: { topic: TOPIC_LINK, payload: OFFLINE_LINK, qos: 1, retain: true },
  });
  const bridge = new WaBridge({
    wa, dir, contacts, log,
    publish: (topic, payload, opts) => { if (client.connected) client.publish(topic, payload, opts); },
  });
  bridge.mqtt = { connected: false, error: null };
  client.on('connect', () => {
    bridge.mqtt = { connected: true, error: null };
    log(`whatsapp: MQTT connected, subscribing ${TOPICS_NODE.join(', ')}`);
    client.subscribe(TOPICS_NODE, { qos: 0 }, (err) => { if (err) log(`whatsapp: MQTT subscribe failed: ${err.message}`); });
    bridge.publishLink();
  });
  client.on('close', () => { bridge.mqtt.connected = false; });
  client.on('error', (err) => {
    if (bridge.mqtt.error !== err.message) log(`whatsapp: MQTT error: ${err.message}`);
    bridge.mqtt.error = err.message;
  });
  client.on('message', (topic, payload, packet) => {
    const r = bridge.onMqtt(topic, payload, !!packet?.retain);
    if (r.error) log(`whatsapp: MQTT ${topic}: ignored (${r.error})`);
  });
  const timer = setInterval(() => bridge.tick(), 500);
  timer.unref();
  // Clean stop: tell the nodes before leaving (the will only covers a crash).
  bridge.stop = () => new Promise((resolve) => {
    clearInterval(timer);
    wa.stop();
    const done = () => client.end(false, {}, resolve);
    if (client.connected) client.publish(TOPIC_LINK, OFFLINE_LINK, { qos: 1, retain: true }, done);
    else done();
    setTimeout(resolve, 1500).unref();
  });
  return bridge;
}
