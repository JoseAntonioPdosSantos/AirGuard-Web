// The WhatsApp session of AirGuard Web (library: Baileys, the unofficial
// WhatsApp Web client; no browser involved).
//
//   idle        no session, or the pairing was not finished in time
//   connecting  opening the socket / logging in
//   code        waiting for the 8-character pairing code to be typed on the
//               phone ("Conectar com numero de telefone"). Needs the number of
//               the account; this is what the AirGuard OLED shows.
//   qr          waiting for the phone to scan the pairing QR (the first one
//               lives 60 s, the next ones 20 s). Shown on the page only: the
//               OLED cannot draw it sharp enough for a camera.
//   open        linked and online: messages arrive, alerts can be sent
//
// Either way WhatsApp ends an attempt nobody completes (-> idle) after six QR
// periods, 60 + 5 x 20 s.
//
// Emits 'state' (status changed) and 'message' (one message received).
// The session keys live in <dir>/auth: whoever reads that folder controls the
// linked WhatsApp account, so it stays inside data/ (never in git).
//
// Names: a message only carries the name its sender chose for the own profile.
// The names the user gave the contacts on the phone are part of the account's
// "app state", which WhatsApp shares with the linked devices: they are read
// once after linking, kept up to date by the library, and stored in
// <dir>/names.json (the phone's address book: same care as the keys).
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describeMessage, phoneKey, plainLine, qrMatrix } from './wa_text.js';

const QR_FIRST_MS = 60_000;   // Baileys: the first QR lives 60 s, the next ones 20 s
const QR_NEXT_MS = 20_000;
const QR_MARGIN_S = 5;        // the displays keep a QR this much longer (next one is on its way)
// A pairing code lives as long as the attempt: measured here twice, 160 s from
// the first QR to "QR refs attempts ended" (the count of periods is WhatsApp's).
const PAIR_TOTAL_MS = QR_FIRST_MS + 5 * QR_NEXT_MS;
const CODE_RE = /^[0-9A-Z]{8}$/;
const NUMBER_RE = /^[1-9]\d{7,14}$/;   // country code + number, digits only
const CONTACTS_COLLECTION = 'critical_unblock_low';   // the app state collection with the address book
const NAMES_SAVE_MS = 1_500;           // a first sync brings hundreds of names: one write
const NAMES_MAX = 20_000;
const SAVED_NAME_MAX = 60;
const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;

// Close codes (Baileys DisconnectReason).
const CODE = { loggedOut: 401, forbidden: 403, timedOut: 408, multideviceMismatch: 411, connectionReplaced: 440,
  badSession: 500, restartRequired: 515 };

const quiet = (onError) => {
  const l = {
    level: 'error',
    child: () => l,
    trace() {}, debug() {}, info() {}, warn() {},
    error(obj, msg) { onError(typeof obj === 'string' ? obj : msg || obj?.err?.message || obj?.msg || 'error'); },
  };
  return l;
};

const seconds = (ts) => (ts && typeof ts === 'object' && typeof ts.toNumber === 'function' ? ts.toNumber() : Number(ts) || 0);

export class WhatsApp extends EventEmitter {
  // lib: the Baileys module (injected by the tests); groups: also take group messages.
  constructor({ dir, log = () => {}, lib = null, groups = false, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
    super();
    this.dir = dir;
    this.authDir = join(dir, 'auth');
    this.numberFile = join(dir, 'pairing.json');
    this.namesFile = join(dir, 'names.json');
    this.log = log;
    this.lib = lib;
    this.groups = groups;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;

    this.state = 'idle';
    this.linked = false;      // a session is saved (the phone lists this device)
    this.me = null;           // { number, name }
    this.qr = null;           // { n, bits, ttl, expiresAt }
    this.code = null;         // { code, ttl, expiresAt }: pairing code to type on the phone
    this.mode = 'qr';         // how the current / last attempt pairs: 'code' | 'qr'
    this.pairNumber = '';     // number of the account to link (digits), for the pairing code
    this.since = null;        // when the session opened
    this.error = null;        // why it is not connected, for the page
    this.sock = null;
    this.auth = null;         // session keys, kept in memory between reconnections
    this.pairing = false;     // a pairing was asked for
    this.qrCount = 0;
    this.attempt = 0;
    this.retry = null;
    this.stopped = false;
    this.lastEmitted = '';
    this.lastLibError = '';
    // names from the phone's address book, by number (phoneKey) and by WhatsApp's opaque id (@lid)
    this.names = { pn: new Map(), lid: new Map() };
    this.namesSynced = false; // the whole address book was read once for this session
    this.namesTimer = null;
  }

  async load() {
    if (!this.lib) this.lib = await import('baileys');
    return this.lib;
  }

  // Server start: reconnect a saved session; without one, wait to be asked.
  async start() {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try {
      const n = JSON.parse(readFileSync(this.numberFile, 'utf8'))?.number;
      if (typeof n === 'string' && NUMBER_RE.test(n)) this.pairNumber = n;
    } catch { /* no number saved yet */ }
    this.linked = existsSync(join(this.authDir, 'creds.json')) && await this.savedSession();
    if (this.linked) { this.loadNames(); await this.open(); }
    else { this.clearNames(); this.set('idle'); }
  }

  async savedSession() {
    try {
      const { useMultiFileAuthState } = await this.load();
      this.auth = await useMultiFileAuthState(this.authDir);
      const creds = this.auth.state.creds;
      // Asking for a pairing code already writes "me" (the number typed), before
      // anything is linked: keys of an attempt that never finished are useless.
      if (creds?.me && creds.pairingCode && !creds.account) { this.forget(); return false; }
      return !!creds?.me;
    } catch { this.auth = null; return false; }
  }

  // The number of the WhatsApp account to link, digits only with the country
  // code (5567999998888). Kept so a node that is switched on can get a code.
  setPairNumber(number) {
    const n = String(number ?? '').replace(/\D/g, '');
    if (!NUMBER_RE.test(n)) throw new Error('invalid_number');
    if (n === this.pairNumber) return;
    this.pairNumber = n;
    try {
      const tmp = `${this.numberFile}.tmp`;
      writeFileSync(tmp, JSON.stringify({ number: n }), { mode: 0o600 });
      renameSync(tmp, this.numberFile);
    } catch (e) { this.log(`whatsapp: could not save the number: ${e.message}`); }
  }

  // Asked by the page or by a node that was just switched on: start a pairing.
  //   mode    'code' (needs the number), 'qr', or 'auto' = code when a number is saved
  //   restart drop an attempt that is already running and start again
  // Nothing to do when a session exists or (without restart) one is on its way.
  async pair({ mode = 'auto', restart = false } = {}) {
    if (this.linked) {
      // a saved session that stopped trying (WhatsApp refused it): try once more
      if (!this.sock && !this.retry && this.state === 'idle') { this.error = null; await this.open(); return 'reconnecting'; }
      return 'linked';
    }
    const want = mode === 'auto' ? (this.pairNumber ? 'code' : 'qr') : mode;
    if (want === 'code' && !this.pairNumber) return 'no_number';
    if (this.sock || this.state === 'qr' || this.state === 'code' || this.state === 'connecting') {
      if (!restart) return 'pairing';
      this.abandon();
    }
    this.mode = want;
    this.pairing = true;
    this.error = null;
    await this.open();
    return 'started';
  }

  // Ends a pairing attempt that did not finish. Its keys go too: once a code
  // was asked for they carry the typed number as "me", and the library would
  // try to log in with them instead of pairing.
  abandon() {
    const sock = this.sock;
    this.sock = null;
    try { sock?.end(undefined); } catch { /* already closed */ }
    this.pairing = false;
    this.forget();
  }

  // Unlink: tells WhatsApp to remove this device and deletes the session keys.
  async logout() {
    this.cancelRetry();
    this.pairing = false;
    const sock = this.sock;
    this.sock = null;
    if (sock) {
      try { if (this.state === 'open') await sock.logout(); else sock.end(undefined); }
      catch (e) { this.log(`whatsapp: logout: ${e.message}`); try { sock.end(undefined); } catch { /* closed */ } }
    }
    this.forget();
    this.error = null;
    this.set('idle');
  }

  forget() {
    try { rmSync(this.authDir, { recursive: true, force: true }); } catch (e) { this.log(`whatsapp: could not delete the session: ${e.message}`); }
    this.auth = null;
    this.linked = false;
    this.me = null;
    this.since = null;
    this.clearNames();   // the address book belongs to the account that is going away
  }

  stop() {
    this.stopped = true;
    this.cancelRetry();
    if (this.namesTimer) this.writeNames();
    const sock = this.sock;
    this.sock = null;
    try { sock?.end(undefined); } catch { /* already closed */ }
  }

  cancelRetry() {
    if (this.retry) this.clearTimer(this.retry);
    this.retry = null;
  }

  set(state) {
    if (state !== 'qr') this.qr = null;
    if (state !== 'code') this.code = null;
    this.state = state;
    const st = this.status();
    const key = JSON.stringify(st);
    if (key === this.lastEmitted) return;  // nothing new to tell (the library repeats "connecting")
    this.lastEmitted = key;
    this.emit('state', st);
  }

  status() {
    return {
      state: this.state,
      linked: this.linked,
      me: this.me,
      since: this.since,
      error: this.error,
      qr: this.qr ? { n: this.qr.n, bits: this.qr.bits.toString('base64'), ttl: this.qr.ttl, expiresAt: this.qr.expiresAt } : null,
      code: this.code ? { ...this.code } : null,
      pairNumber: this.pairNumber || null,
    };
  }

  async open() {
    if (this.sock || this.stopped) return;
    this.cancelRetry();
    let B, auth;
    try {
      B = await this.load();
      // The same object across reconnections: right after pairing WhatsApp asks
      // for a restart, and the new keys may not be on disk yet.
      this.auth ??= await B.useMultiFileAuthState(this.authDir);
      auth = this.auth;
    } catch (e) {
      this.error = 'library';
      this.log(`whatsapp: cannot start: ${e.message}`);
      this.set('idle');
      return;
    }
    if (this.sock || this.stopped) return;  // someone else opened it meanwhile
    this.qrCount = 0;
    this.set('connecting');
    const sock = B.makeWASocket({
      auth: auth.state,
      logger: quiet((m) => { if (m !== this.lastLibError) { this.lastLibError = m; this.log(`whatsapp: ${m}`); } }),
      browser: B.Browsers.ubuntu('Chrome'),
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      markOnlineOnConnect: false,          // the phone keeps ringing for new messages
      generateHighQualityLinkPreview: false,
    });
    this.sock = sock;
    sock.ev.on('creds.update', auth.saveCreds);
    sock.ev.on('connection.update', (u) => { if (this.sock === sock) this.onConnection(sock, u); });
    sock.ev.on('messages.upsert', (up) => { if (this.sock === sock) this.onMessages(up); });
    sock.ev.on('contacts.upsert', (list) => { if (this.sock === sock) this.onContacts(list); });
  }

  // ---- names from the phone's address book -------------------------------------
  loadNames() {
    this.names = { pn: new Map(), lid: new Map() };
    this.namesSynced = false;
    try {
      const o = JSON.parse(readFileSync(this.namesFile, 'utf8'));
      for (const kind of ['pn', 'lid']) {
        for (const [k, v] of Object.entries(o?.[kind] || {})) if (typeof v === 'string' && v) this.names[kind].set(k, v);
      }
      this.namesSynced = o?.synced === true;
    } catch { /* nothing saved yet */ }
  }

  writeNames() {
    if (this.namesTimer) this.clearTimer(this.namesTimer);
    this.namesTimer = null;
    if (!this.linked) return;
    try {
      const tmp = `${this.namesFile}.tmp`;
      writeFileSync(tmp, JSON.stringify({ synced: this.namesSynced, pn: Object.fromEntries(this.names.pn), lid: Object.fromEntries(this.names.lid) }), { mode: 0o600 });
      renameSync(tmp, this.namesFile);
      this.log(`whatsapp: address book: ${this.names.pn.size} names by number, ${this.names.lid.size} by id`);
    } catch (e) { this.log(`whatsapp: could not save the names: ${e.message}`); }
  }

  saveNames() {
    if (this.namesTimer) return;
    this.namesTimer = this.setTimer(() => { this.namesTimer = null; this.writeNames(); }, NAMES_SAVE_MS);
    this.namesTimer?.unref?.();
  }

  clearNames() {
    if (this.namesTimer) this.clearTimer(this.namesTimer);
    this.namesTimer = null;
    this.names = { pn: new Map(), lid: new Map() };
    this.namesSynced = false;
    try { rmSync(this.namesFile, { force: true }); } catch { /* nothing to delete */ }
  }

  // Where a WhatsApp id goes in the names: by number or by opaque id.
  nameSlot(jid) {
    if (typeof jid !== 'string' || !jid || !this.lib) return null;
    const user = this.lib.jidDecode(jid)?.user;
    if (!user) return null;
    if (this.lib.isPnUser(jid)) return { map: this.names.pn, key: phoneKey(user) };
    if (jid.endsWith('@lid')) return { map: this.names.lid, key: user };
    return null;
  }

  // The library read contacts from the account's app state: { id, name, lid,
  // phoneNumber }, name = the one saved on the phone. No name = contact removed.
  onContacts(list) {
    if (!Array.isArray(list)) return;
    let changed = false;
    for (const c of list) {
      const raw = typeof c?.name === 'string' ? plainLine(c.name) : '';
      const name = /[\p{L}\p{N}]/u.test(raw) ? [...raw].slice(0, SAVED_NAME_MAX).join('') : '';
      for (const jid of [c?.id, c?.lid, c?.phoneNumber]) {
        const slot = this.nameSlot(jid);
        if (!slot || !slot.key) continue;
        if (name) {
          if (slot.map.get(slot.key) === name || (!slot.map.has(slot.key) && slot.map.size >= NAMES_MAX)) continue;
          slot.map.set(slot.key, name);
          changed = true;
        } else if (slot.map.delete(slot.key)) changed = true;
      }
    }
    if (changed) this.saveNames();
  }

  // Name saved on the phone for one of these WhatsApp ids / numbers, or ''.
  savedName(jids = [], number = '') {
    for (const jid of jids) {
      const slot = this.nameSlot(jid);
      const name = slot && slot.map.get(slot.key);
      if (name) return name;
    }
    return (number && this.names.pn.get(phoneKey(number))) || '';
  }

  // After each login: the first time the whole address book, later only what
  // changed while we were away (the library follows the changes while online).
  async syncNames(sock) {
    if (typeof sock.resyncAppState !== 'function') return;
    const first = !this.namesSynced;
    try {
      // from scratch: the library only reports what is newer than the version it holds
      if (first) await this.auth?.state?.keys?.set?.({ 'app-state-sync-version': { [CONTACTS_COLLECTION]: null } });
      await sock.resyncAppState([CONTACTS_COLLECTION], first);
      if (this.sock !== sock || !first) return;
      this.namesSynced = true;
      this.saveNames();
    } catch (e) {
      if (this.sock === sock) this.log(`whatsapp: address book: ${e.message}`);
    }
  }

  // The first QR of an attempt means "WhatsApp is ready to pair": in code mode
  // that is when the code can be asked for (the QRs themselves are not shown).
  async askCode(sock) {
    try {
      const code = String(await sock.requestPairingCode(this.pairNumber) ?? '').toUpperCase();
      if (this.sock !== sock) return;  // cancelled meanwhile
      if (!CODE_RE.test(code)) throw new Error('unexpected code format');
      this.code = { code, ttl: PAIR_TOTAL_MS / 1000 + QR_MARGIN_S, expiresAt: this.now() + PAIR_TOTAL_MS };
      this.log(`whatsapp: pairing code ready for the number ending in ${this.pairNumber.slice(-4)}`);
      this.set('code');
    } catch (e) {
      if (this.sock !== sock) return;
      this.log(`whatsapp: pairing code: ${e.message}`);
      this.abandon();
      this.error = 'code_failed';
      this.set('idle');
    }
  }

  onConnection(sock, u) {
    if (u.qr) {
      const first = this.qrCount === 0;
      this.qrCount += 1;
      if (this.mode === 'code') {
        if (first) void this.askCode(sock);
      } else {
        const lifeMs = first ? QR_FIRST_MS : QR_NEXT_MS;
        try {
          const { n, bits } = qrMatrix(u.qr);
          this.qr = { n, bits, ttl: lifeMs / 1000 + QR_MARGIN_S, expiresAt: this.now() + lifeMs };
          if (first) this.log(`whatsapp: pairing QR ready (${n}x${n} modules)`);
          this.set('qr');
        } catch (e) { this.log(`whatsapp: QR: ${e.message}`); }
      }
    }
    if (u.isNewLogin) this.log('whatsapp: paired, restarting the connection');
    if (u.connection === 'connecting' && this.state !== 'qr' && this.state !== 'code') this.set('connecting');
    if (u.connection === 'open') {
      const B = this.lib;
      const id = sock.user?.id || '';
      this.linked = true;
      this.pairing = false;
      this.attempt = 0;
      this.error = null;
      this.since = this.now();
      this.me = { number: B.jidDecode(id)?.user || '', name: sock.user?.name || sock.user?.verifiedName || '' };
      this.log(`whatsapp: connected as ${this.me.number}`);
      this.set('open');
      void this.syncNames(sock);
    }
    if (u.connection === 'close') this.onClose(u.lastDisconnect?.error);
  }

  onClose(err) {
    const code = err?.output?.statusCode ?? 0;
    this.sock = null;
    if (this.stopped) return;
    if (code === CODE.restartRequired) {   // normal right after pairing
      void this.open();
      return;
    }
    if (code === CODE.loggedOut || code === CODE.badSession || code === CODE.multideviceMismatch) {
      // removed on the phone ("Dispositivos conectados"), or the keys are no longer valid
      this.log(`whatsapp: session ended (${code}), a new pairing is needed`);
      this.forget();
      this.pairing = false;
      this.error = code === CODE.loggedOut ? 'logged_out' : 'bad_session';
      this.set('idle');
      return;
    }
    if (!this.linked) {                    // a pairing attempt that did not finish
      this.pairing = false;
      this.forget();                       // its keys cannot be used again (see abandon)
      this.error = code !== CODE.timedOut ? 'connection_failed' : this.mode === 'code' ? 'code_timeout' : 'qr_timeout';
      this.log(`whatsapp: pairing ended (${code || err?.message || 'closed'})`);
      this.set('idle');
      return;
    }
    if (code === CODE.forbidden) {         // WhatsApp refuses this account: do not insist
      this.error = 'forbidden';
      this.log('whatsapp: connection refused by WhatsApp (403)');
      this.set('idle');
      return;
    }
    // linked and the connection dropped: come back by ourselves
    this.error = code === CODE.connectionReplaced ? 'replaced' : 'connection_lost';
    const base = code === CODE.connectionReplaced ? 30_000 : RECONNECT_MIN_MS;
    const wait = Math.min(RECONNECT_MAX_MS, base * 2 ** Math.min(this.attempt, 5));
    this.attempt += 1;
    this.log(`whatsapp: connection closed (${code || err?.message || '?'}), retrying in ${Math.round(wait / 1000)} s`);
    this.set('connecting');
    this.retry = this.setTimer(() => { this.retry = null; void this.open(); }, wait);
    this.retry?.unref?.();
  }

  onMessages(up) {
    if (up?.type !== 'notify' || !Array.isArray(up.messages)) return;  // 'append' = history
    const B = this.lib;
    for (const m of up.messages) {
      try {
        const key = m?.key;
        const jid = key?.remoteJid;
        if (!jid || key.fromMe) continue;
        if (B.isJidStatusBroadcast(jid) || B.isJidBroadcast(jid) || B.isJidNewsletter(jid)) continue;
        const group = !!B.isJidGroup(jid);
        if (group && !this.groups) continue;
        const what = describeMessage(m.message);
        if (!what) continue;
        // the sender's phone number: WhatsApp may address the chat by an opaque id (@lid)
        const ids = group ? [key.participantAlt, key.participant] : [key.remoteJidAlt, jid];
        const pn = ids.find((j) => typeof j === 'string' && B.isPnUser(j));
        this.emit('message', {
          waId: String(key.id || ''),
          chat: jid,
          group,
          number: pn ? B.jidDecode(pn)?.user || '' : '',
          saved: this.savedName(ids),                             // the contact's name on the phone
          name: typeof m.pushName === 'string' ? m.pushName : '', // the name the sender chose
          kind: what.kind,
          text: what.text,
          t: seconds(m.messageTimestamp) * 1000 || this.now(),
        });
      } catch (e) { this.log(`whatsapp: message skipped: ${e.message}`); }
    }
  }

  // Sends a text to the linked account's own number ("message yourself").
  async sendToSelf(text) {
    if (this.state !== 'open' || !this.sock) throw new Error('not_connected');
    const jid = this.lib.jidNormalizedUser(this.sock.user?.id);
    if (!jid) throw new Error('no_own_number');
    await this.sock.sendMessage(jid, { text });
  }
}
