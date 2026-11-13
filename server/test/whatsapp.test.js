// WhatsApp link: texts, alert messages, the session (with a fake Baileys), the
// MQTT bridge and the HTTP routes. Nothing here talks to WhatsApp or a broker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import qrcode from 'qrcode-generator';
import { createApp, FailLimiter } from '../src/app.js';
import { Store } from '../src/store.js';
import { newToken, hashToken } from '../src/tokens.js';
import { hashPassword } from '../src/passwords.js';
import { WhatsApp } from '../src/whatsapp.js';
import { WaBridge, TOPIC_INBOX, TOPIC_LINK } from '../src/wa_bridge.js';
import { Notifier, alertText, diffState, parseNodeState } from '../src/wa_notify.js';
import { describeMessage, displayMessage, formatNumber, phoneKey, plainLine, qrMatrix, shorten } from '../src/wa_text.js';

const T0 = 1_800_000_000_000;
const tmp = () => mkdtempSync(join(tmpdir(), 'agwa-'));
const tick = () => new Promise((r) => setImmediate(r));

// ---- texts --------------------------------------------------------------------
test('qr: the matrix of WhatsApp pairing data matches the library', () => {
  // same shape and length (277 chars) as the code WhatsApp gives today
  const data = `https://wa.me/settings/linked_devices#2@${'A'.repeat(100)},${'b'.repeat(43)}=,${'c'.repeat(43)}=,${'d'.repeat(43)}=,1`;
  assert.equal(data.length, 277);
  const { n, bits } = qrMatrix(data);
  assert.equal(n, 61);
  assert.ok(n <= 64);
  assert.equal(bits.length, Math.ceil((61 * 61) / 8));
  const q = qrcode(0, 'L'); q.addData(data, 'Byte'); q.make();
  for (const [r, c] of [[0, 0], [0, 7], [6, 6], [30, 30], [60, 60], [13, 47]]) {
    const i = r * n + c;
    assert.equal(!!(bits[i >> 3] & (0x80 >> (i & 7))), q.isDark(r, c), `module ${r},${c}`);
  }
  assert.equal(qrMatrix('oi').n, 21);
});

test('text for the displays: no emoji, one line, shortened with "..."', () => {
  assert.equal(plainLine('  Oi \u{1F600}\u{1F44D}\u{1F3FD} tudo\n\tbem?​ '), 'Oi tudo bem?');
  assert.equal(plainLine('\u{1F1E7}\u{1F1F7} ❤️'), '');
  assert.equal(plainLine('Atenção: café às 10h'), 'Atenção: café às 10h');   // accents stay (the node transliterates)
  assert.equal(plainLine(42), '');
  assert.equal(shorten('abcdef', 6), 'abcdef');
  assert.equal(shorten('abcdefg', 6), 'abc...');
  assert.equal([...shorten('ção'.repeat(50), 96)].length, 96);
  assert.deepEqual(displayMessage('Maria \u{1F338}', 'Chego em 10 min \u{1F697}'), { from: 'Maria', text: 'Chego em 10 min' });
  assert.equal(displayMessage('Maria', '\u{1F602}\u{1F602}'), null);
  assert.equal(displayMessage('', 'oi').from, 'WhatsApp');
  const long = displayMessage('Um Nome Muito Comprido Mesmo', 'x'.repeat(300));
  assert.equal(long.from.length, 20);
  assert.equal(long.text.length, 96);
  assert.ok(long.text.endsWith('...'));
});

test('what a received message says', () => {
  assert.deepEqual(describeMessage({ conversation: 'oi' }), { kind: 'text', text: 'oi' });
  assert.deepEqual(describeMessage({ extendedTextMessage: { text: 'veja https://x.y' } }), { kind: 'text', text: 'veja https://x.y' });
  assert.deepEqual(describeMessage({ ephemeralMessage: { message: { conversation: 'some' } } }), { kind: 'text', text: 'some' });
  assert.deepEqual(describeMessage({ viewOnceMessageV2: { message: { imageMessage: { caption: 'olha' } } } }), { kind: 'image', text: '[imagem] olha' });
  assert.deepEqual(describeMessage({ imageMessage: {} }), { kind: 'image', text: '[imagem]' });
  assert.deepEqual(describeMessage({ audioMessage: { ptt: true } }), { kind: 'audio', text: '[mensagem de voz]' });
  assert.deepEqual(describeMessage({ documentWithCaptionMessage: { message: { documentMessage: { fileName: 'conta.pdf' } } } }),
    { kind: 'document', text: '[documento] conta.pdf' });
  assert.equal(describeMessage({ stickerMessage: {} }).text, '[figurinha]');
  assert.equal(describeMessage({ locationMessage: {} }).kind, 'location');
  // not content: never shown
  for (const m of [null, {}, { reactionMessage: { text: '\u{1F44D}' } }, { protocolMessage: { type: 0 } },
    { senderKeyDistributionMessage: {} }, { pollUpdateMessage: {} }, { conversation: '' }])
    assert.equal(describeMessage(m), null);
});

test('phone numbers: Brazilian 9th digit and display form', () => {
  assert.equal(phoneKey('+5511988887777'), phoneKey('551188887777'));
  assert.equal(phoneKey('5511988887777@x'), '551188887777');
  assert.notEqual(phoneKey('5511988887777'), phoneKey('5521988887777'));
  assert.equal(phoneKey('14155550100'), '14155550100');
  assert.equal(formatNumber('5511988887777'), '+55 (11) 98888-7777');
  assert.equal(formatNumber('14155550100'), '+14155550100');
  assert.equal(formatNumber(''), '');
});

// ---- alert messages -----------------------------------------------------------
const st = (lv, extra = {}) => parseNodeState({ boot: 3, up: 600, lv, relay: false, flags: 0, temp: 27.46, rh: 61, gas: 1.823, ...extra });

test('node state: validated', () => {
  assert.deepEqual(st('NLMH').lv, [0, 1, 2, 3]);
  assert.equal(st('NNNN', { relay: true }).relay, true);
  for (const bad of [null, [], {}, { lv: 'NNN' }, { lv: 'NNNX' }, { lv: 1234 }]) assert.equal(parseNodeState(bad), null);
  assert.equal(parseNodeState({ lv: 'NNNN', relay: 'yes', flags: -1, temp: 'x' }).relay, false);
});

test('alert text: which alert, how severe, relay, readings', () => {
  const cur = st('HNNN', { relay: true });
  const t = alertText(diffState(st('NNNN'), cur), cur, { device: 'KITCHEN_01' });
  assert.match(t, /^🚨 \*AirGuard: ALERTA\*\n/);
  assert.match(t, /\*Alerta:\* Gás\n\*Gravidade:\* ALTA\n/);
  assert.match(t, /⚡ \*Relé:\* desligou a energia da residência/);
  assert.match(t, /\*Leituras:\* gás 1,82 V · 27,5 °C · 61 %/);
  assert.match(t, /_KITCHEN_01_$/);

  const up = alertText(diffState(st('MNNN'), st('HNNN')), st('HNNN'));
  assert.match(up, /\*Gravidade:\* ALTA \(subiu, antes MÉDIA\)/);
  const down = alertText(diffState(st('HNNN'), st('MNNN')), st('MNNN'));
  assert.match(down, /^🟠 \*AirGuard: ALERTA\*/);
  assert.match(down, /\*Gravidade:\* MÉDIA \(baixou, antes ALTA\)/);
});

test('alert text: back to normal, relay only, system detail, late message', () => {
  const back = alertText(diffState(st('HNLN', { relay: true }), st('NNLN')), st('NNLN'), { device: 'KITCHEN_01', lateMs: 12 * 60_000 });
  assert.match(back, /^✅ \*AirGuard: NORMALIZADO\*/);
  assert.match(back, /Gás voltou ao normal \(estava em gravidade ALTA\)/);
  assert.match(back, /🔌 \*Relé:\* religou a energia da residência/);
  assert.match(back, /\*Continua em alerta:\* Umidade BAIXA/);
  assert.match(back, /_KITCHEN_01 · ocorrido há 12 min_$/);

  const relayOnly = alertText(diffState(st('HNNN'), st('HNNN', { relay: true })), st('HNNN', { relay: true }));
  assert.match(relayOnly, /^⚡ \*AirGuard: ENERGIA DESLIGADA\*/);
  assert.match(relayOnly, /\*Continua em alerta:\* Gás ALTA/);

  const sys = alertText(diffState(st('NNNN'), st('NNNL', { flags: 16 | 1 })), st('NNNL', { flags: 17 }));
  assert.match(sys, /\*Alerta:\* Sistema \(sensor de temperatura\/umidade sem leitura; o receptor não confirma os alertas \(LoRa\)\)/);
  assert.match(sys, /\*Gravidade:\* BAIXA/);

  const stillOff = alertText(diffState(st('HNNN', { relay: true }), st('HMNN', { relay: true })), st('HMNN', { relay: true }));
  assert.match(stillOff, /a energia da residência continua desligada/);
  assert.match(alertText(diffState(st('NNNN'), st('LNNN', { sim: true })), st('LNNN', { sim: true })), /SIMULAÇÃO/);
});

test('notifier: worse at once, better only when stable, never twice', () => {
  const n = new Notifier({ minGapMs: 5000, recoveryDelayMs: 3000 });
  n.onState('K', st('NNNN'), 0);
  assert.deepEqual(n.poll(0), []);                       // normal from the start: nothing to say
  n.onState('K', st('HNNN', { relay: true }), 1000);
  const a = n.poll(1000);
  assert.equal(a.length, 1);
  assert.equal(a[0].kind, 'alert');
  assert.equal(a[0].diff.relay, true);                   // alert + relay in ONE message
  n.onState('K', st('HNNN', { relay: true }), 31_000);   // the node repeats its state every 30 s
  assert.deepEqual(n.poll(31_000), []);

  n.onState('K', st('NNNN'), 40_000);                    // back to normal...
  assert.deepEqual(n.poll(42_999), []);                  // ...not said before it lasts 3 s
  const r = n.poll(43_000);
  assert.equal(r.length, 1);
  assert.equal(r[0].kind, 'recovery');
  assert.equal(r[0].diff.relay, false);
  assert.ok(n.reportedIsNormal('K'));
});

test('notifier: a level flapping around its threshold does not flood', () => {
  const n = new Notifier({ minGapMs: 5000, recoveryDelayMs: 3000 });
  n.onState('K', st('MNNN'), 0);
  assert.equal(n.poll(0).length, 1);
  let sent = 0;
  for (let t = 1000; t <= 20_000; t += 1000) {           // normal / medium every second
    n.onState('K', st(t % 2000 ? 'NNNN' : 'MNNN'), t);
    sent += n.poll(t).length;
  }
  assert.equal(sent, 0);
  n.onState('K', st('NNNN'), 21_000);
  assert.equal(n.poll(23_999).length, 0);
  assert.equal(n.poll(24_000).length, 1);
});

test('notifier: minimum gap between messages, net change only', () => {
  const n = new Notifier({ minGapMs: 5000, recoveryDelayMs: 3000 });
  n.onState('K', st('LNNN'), 0);
  assert.equal(n.poll(0).length, 1);
  n.onState('K', st('MNNN'), 1000);                      // worse, 1 s later: waits for the gap
  assert.equal(n.poll(1000).length, 0);
  n.onState('K', st('HNNN'), 2000);
  const m = n.poll(5000);
  assert.equal(m.length, 1);
  assert.deepEqual(m[0].diff.levels, [{ cat: 0, from: 1, to: 3 }]);   // low -> high, the step in between is not a message
});

test('notifier: after a node reboot only what got worse counts for the first minute', () => {
  const n = new Notifier({ saved: { K: { lv: [0, 2, 0, 0], relay: false } }, settleS: 60 });
  n.onState('K', st('NNNN', { up: 5 }), 0);              // levels restart at normal after the boot
  assert.deepEqual(n.poll(10_000), []);                  // no false "normalizado"
  n.onState('K', st('HNNN', { up: 8, relay: true }), 11_000);
  const a = n.poll(11_000);
  assert.equal(a.length, 1);                             // a new alert is still immediate
  assert.deepEqual(a[0].state.lv, [3, 2, 0, 0]);
  n.onState('K', st('HNNN', { up: 65, relay: true }), 70_000);   // settled: temperature really is normal
  const r = n.poll(73_000);
  assert.equal(r.length, 1);
  assert.deepEqual(r[0].diff.levels, [{ cat: 1, from: 2, to: 0 }]);
  assert.deepEqual(n.snapshot(), { K: { lv: [3, 0, 0, 0], relay: true } });
});

// ---- session (fake Baileys) -----------------------------------------------------
function fakeLib() {
  const lib = {
    socks: [], creds: {}, nextCode: 'ABCD1234', codeError: null, keysSet: [], book: [],
    useMultiFileAuthState: async (dir) => {
      mkdirSync(dir, { recursive: true });
      return { state: { creds: lib.creds, keys: { set: async (o) => { lib.keysSet.push(o); } } }, saveCreds: async () => {} };
    },
    Browsers: { ubuntu: (b) => ['Ubuntu', b, '22.04'] },
    jidDecode: (j) => { const m = /^(\d+)(?::\d+)?@/.exec(j || ''); return m ? { user: m[1] } : undefined; },
    jidNormalizedUser: (j) => (j || '').replace(/:\d+@/, '@'),
    isJidGroup: (j) => j.endsWith('@g.us'),
    isJidBroadcast: (j) => j.endsWith('@broadcast'),
    isJidStatusBroadcast: (j) => j === 'status@broadcast',
    isJidNewsletter: (j) => j.endsWith('@newsletter'),
    isPnUser: (j) => j.endsWith('@s.whatsapp.net'),
    makeWASocket: (cfg) => {
      const h = {};
      const sock = { cfg, user: null, sent: [], ended: false, loggedOut: false, codeFor: null, resyncs: [],
        ev: { on: (name, fn) => { h[name] = fn; } },
        fire: (name, data) => h[name]?.(data),
        // like Baileys: reads a collection of the account's app state and reports the contacts in it
        resyncAppState: async (collections, initial) => { sock.resyncs.push([collections, initial]); if (lib.book.length) h['contacts.upsert']?.(lib.book); },
        end: () => { sock.ended = true; },
        logout: async () => { sock.loggedOut = true; },
        // like Baileys: the typed number becomes "me" before anything is linked
        requestPairingCode: async (number) => {
          if (lib.codeError) throw new Error(lib.codeError);
          sock.codeFor = number;
          lib.creds.me = { id: `${number}@s.whatsapp.net`, name: '~' };
          lib.creds.pairingCode = lib.nextCode;
          return lib.nextCode;
        },
        sendMessage: async (jid, content) => { sock.sent.push({ jid, content }); } };
      lib.socks.push(sock);
      return sock;
    },
  };
  return lib;
}
const closed = (code) => ({ connection: 'close', lastDisconnect: { error: { output: { statusCode: code }, message: `code ${code}` } } });

function session(opts = {}) {
  const dir = tmp();
  const lib = fakeLib();
  const timers = [];
  let now = T0;
  const wa = new WhatsApp({ dir, lib, now: () => now, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {}, ...opts });
  const states = [];
  wa.on('state', (s) => states.push(s.state));
  return { wa, lib, dir, timers, states, advance: (ms) => { now += ms; }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('session: no saved account -> idle until a QR is asked for', async () => {
  const s = session();
  await s.wa.start();
  assert.equal(s.wa.status().state, 'idle');
  assert.equal(s.lib.socks.length, 0);                   // WhatsApp is not contacted by itself

  assert.equal(await s.wa.pair(), 'started');
  assert.equal(s.lib.socks.length, 1);
  assert.equal(s.lib.socks[0].cfg.markOnlineOnConnect, false);
  s.lib.socks[0].fire('connection.update', { connection: 'connecting' });   // repeated by the library
  assert.deepEqual(s.states, ['idle', 'connecting']);    // told once
  assert.equal(await s.wa.pair(), 'pairing');            // asking twice does not open a second socket
  assert.equal(s.lib.socks.length, 1);

  s.lib.socks[0].fire('connection.update', { qr: 'https://wa.me/settings/linked_devices#first' });
  let q = s.wa.status();
  assert.equal(q.state, 'qr');
  assert.ok(q.qr.n >= 21 && q.qr.n <= 64);
  assert.equal(q.qr.ttl, 65);                            // first code: 60 s (+ margin)
  assert.equal(q.qr.expiresAt, T0 + 60_000);
  assert.equal(Buffer.from(q.qr.bits, 'base64').length, Math.ceil((q.qr.n * q.qr.n) / 8));
  s.lib.socks[0].fire('connection.update', { qr: 'https://wa.me/settings/linked_devices#second' });
  q = s.wa.status();
  assert.equal(q.qr.ttl, 25);                            // the next ones: 20 s

  s.lib.socks[0].fire('connection.update', closed(408)); // nobody scanned: WhatsApp gives up
  assert.equal(s.wa.status().state, 'idle');
  assert.equal(s.wa.status().error, 'qr_timeout');
  assert.equal(s.wa.status().qr, null);
  assert.equal(s.timers.length, 0);                      // and we do not insist
  assert.equal(await s.wa.pair(), 'started');            // until asked again
  s.cleanup();
});

test('session: pairing with the 8-character code (number typed on the page)', async () => {
  const s = session();
  await s.wa.start();
  assert.equal(s.wa.status().pairNumber, null);
  assert.equal(await s.wa.pair({ mode: 'code' }), 'no_number');      // a code needs the number
  assert.equal(s.lib.socks.length, 0);
  assert.throws(() => s.wa.setPairNumber('123'), /invalid_number/);
  s.wa.setPairNumber('5567999998888');
  assert.deepEqual(JSON.parse(readFileSync(join(s.dir, 'pairing.json'), 'utf8')), { number: '5567999998888' });

  assert.equal(await s.wa.pair(), 'started');                         // auto: a number is saved -> code
  const a = s.lib.socks[0];
  assert.equal(a.codeFor, null);                                      // not before WhatsApp is ready
  a.fire('connection.update', { qr: 'first' });
  await tick();
  assert.equal(a.codeFor, '5567999998888');
  let st = s.wa.status();
  assert.equal(st.state, 'code');
  assert.deepEqual(st.code, { code: 'ABCD1234', ttl: 165, expiresAt: T0 + 160_000 });
  assert.equal(st.qr, null);                                          // no QR in this mode
  assert.equal(st.pairNumber, '5567999998888');
  a.fire('connection.update', { qr: 'second' });                      // the QRs keep coming: same code
  a.fire('connection.update', { connection: 'connecting' });
  await tick();
  assert.equal(s.wa.status().state, 'code');
  assert.deepEqual(s.states, ['idle', 'connecting', 'code']);
  assert.equal(await s.wa.pair(), 'pairing');                         // a node switched on meanwhile: same attempt

  // asked again on the page: the attempt starts over, with new keys and a new code
  s.lib.creds = {};
  s.lib.nextCode = 'WXYZ5678';
  assert.equal(await s.wa.pair({ mode: 'code', restart: true }), 'started');
  assert.equal(a.ended, true);
  const b = s.lib.socks[1];
  a.fire('connection.update', closed(408));                           // the old socket closing changes nothing
  assert.equal(s.wa.status().state, 'connecting');
  b.fire('connection.update', { qr: 'x' });
  await tick();
  assert.equal(s.wa.status().code.code, 'WXYZ5678');

  // nobody typed it: WhatsApp gives up, the half-made keys are deleted
  b.fire('connection.update', closed(408));
  st = s.wa.status();
  assert.equal(st.state, 'idle');
  assert.equal(st.error, 'code_timeout');
  assert.equal(st.code, null);
  assert.equal(st.linked, false);
  assert.ok(!existsSync(join(s.dir, 'auth')));

  // typed on the phone: paired like with a QR
  s.lib.creds = {};
  await s.wa.pair();
  const c = s.lib.socks[2];
  c.fire('connection.update', { qr: 'x' });
  await tick();
  s.lib.creds.me = { id: '556799998888:7@s.whatsapp.net' };
  s.lib.creds.account = {};
  c.fire('connection.update', { isNewLogin: true });
  c.fire('connection.update', closed(515));
  await tick();
  const d = s.lib.socks[3];
  d.user = { id: '556799998888:7@s.whatsapp.net', name: 'Davi' };
  d.fire('connection.update', { connection: 'open' });
  st = s.wa.status();
  assert.equal(st.state, 'open');
  assert.equal(st.code, null);
  assert.deepEqual(st.me, { number: '556799998888', name: 'Davi' });
  s.cleanup();
});

test('session: WhatsApp refuses the code request; keys of an unfinished code pairing are not a session', async () => {
  const s = session();
  await s.wa.start();
  s.wa.setPairNumber('5567999998888');
  s.lib.codeError = 'rate-overlimit';
  await s.wa.pair();
  s.lib.socks[0].fire('connection.update', { qr: 'x' });
  await tick();
  assert.equal(s.wa.status().state, 'idle');
  assert.equal(s.wa.status().error, 'code_failed');
  assert.equal(s.lib.socks[0].ended, true);
  s.cleanup();

  // server stopped in the middle of a code pairing: "me" is on disk, nothing is linked
  const t = session();
  mkdirSync(join(t.dir, 'auth'), { recursive: true });
  writeFileSync(join(t.dir, 'auth', 'creds.json'), '{}');
  writeFileSync(join(t.dir, 'pairing.json'), '{"number":"5567999998888"}');
  t.lib.creds.me = { id: '5567999998888@s.whatsapp.net', name: '~' };
  t.lib.creds.pairingCode = 'ABCD1234';
  await t.wa.start();
  assert.equal(t.wa.status().linked, false);
  assert.equal(t.wa.status().state, 'idle');
  assert.equal(t.wa.status().pairNumber, '5567999998888');             // the number is remembered
  assert.equal(t.lib.socks.length, 0);
  assert.ok(!existsSync(join(t.dir, 'auth')));
  t.cleanup();
});

test('session: pairing, restart asked by WhatsApp, messages, own number', async () => {
  const s = session();
  await s.wa.start();
  await s.wa.pair();
  const a = s.lib.socks[0];
  a.fire('connection.update', { qr: 'x' });
  s.lib.creds.me = { id: '5511988887777:4@s.whatsapp.net' };  // scanned
  a.fire('connection.update', { isNewLogin: true });
  a.fire('connection.update', closed(515));
  await tick();
  assert.equal(s.lib.socks.length, 2);                   // reconnects at once, same keys
  const b = s.lib.socks[1];
  assert.equal(b.cfg.auth, a.cfg.auth);
  a.fire('connection.update', { qr: 'late event of the old socket' });
  assert.notEqual(s.wa.status().state, 'qr');
  b.user = { id: '5511988887777:4@s.whatsapp.net', name: 'Davi' };
  b.fire('connection.update', { connection: 'open' });
  const st2 = s.wa.status();
  assert.equal(st2.state, 'open');
  assert.equal(st2.linked, true);
  assert.deepEqual(st2.me, { number: '5511988887777', name: 'Davi' });
  assert.equal(await s.wa.pair(), 'linked');
  assert.deepEqual(s.states, ['idle', 'connecting', 'qr', 'connecting', 'open']);

  const got = [];
  s.wa.on('message', (m) => got.push(m));
  const msg = (key, message, extra = {}) => ({ key: { id: `W${got.length}${Math.random()}`, ...key }, message, messageTimestamp: T0 / 1000, pushName: 'Maria', ...extra });
  b.fire('messages.upsert', { type: 'notify', messages: [
    msg({ remoteJid: '5521977776666@s.whatsapp.net' }, { conversation: 'oi' }),
    msg({ remoteJid: '5521977776666@s.whatsapp.net', fromMe: true }, { conversation: 'eu mesmo' }),
    msg({ remoteJid: '123@g.us', participant: '5521977776666@s.whatsapp.net' }, { conversation: 'grupo' }),
    msg({ remoteJid: 'status@broadcast', participant: '5521977776666@s.whatsapp.net' }, { conversation: 'status' }),
    msg({ remoteJid: '999@newsletter' }, { conversation: 'canal' }),
    msg({ remoteJid: '5521977776666@s.whatsapp.net' }, { reactionMessage: { text: '+' } }),
    msg({ remoteJid: '77788899@lid', remoteJidAlt: '5531966665555@s.whatsapp.net' }, { extendedTextMessage: { text: 'via lid' } }, { messageTimestamp: { toNumber: () => 1_700_000_000 } }),
    msg({ remoteJid: '77788899@lid' }, { imageMessage: {} }, { pushName: undefined }),
  ] });
  b.fire('messages.upsert', { type: 'append', messages: [msg({ remoteJid: '5521977776666@s.whatsapp.net' }, { conversation: 'history' })] });
  assert.deepEqual(got.map((m) => [m.number, m.name, m.kind, m.text, m.group]), [
    ['5521977776666', 'Maria', 'text', 'oi', false],
    ['5531966665555', 'Maria', 'text', 'via lid', false],
    ['', '', 'image', '[imagem]', false],
  ]);
  assert.equal(got[0].t, T0);
  assert.equal(got[1].t, 1_700_000_000_000);

  await s.wa.sendToSelf('teste');
  assert.deepEqual(b.sent, [{ jid: '5511988887777@s.whatsapp.net', content: { text: 'teste' } }]);
  s.cleanup();
});

test('session: names of the phone address book, read once after linking and kept', async () => {
  const s = session();
  const link = async () => {
    const k = s.lib.socks.at(-1);
    k.user = { id: '5511988887777:4@s.whatsapp.net' };
    k.fire('connection.update', { connection: 'open' });
    await tick();
    return k;
  };
  const from = (k, key, pushName = 'Perfil') => {
    const got = [];
    const on = (m) => got.push(m);
    s.wa.on('message', on);
    k.fire('messages.upsert', { type: 'notify', messages: [{ key: { id: `N${Math.random()}`, ...key }, message: { conversation: 'oi' }, pushName }] });
    s.wa.off('message', on);
    return got[0];
  };
  s.lib.book = [
    { id: '5521977776666@s.whatsapp.net', name: 'Tia Lúcia', lid: '111222@lid' },   // saved on the phone
    { id: '333444@lid', name: 'Dr. Paulo \u{1F489}' },                               // known by the opaque id only
    { id: '5531955554444@s.whatsapp.net', name: undefined },                         // not a saved contact
    { id: '123@g.us', name: 'Família' },                                             // not a person
  ];
  await s.wa.pair();
  s.lib.socks[0].fire('connection.update', { qr: 'x' });
  const a = await link();
  // the whole collection, from scratch (the library only reports what is newer than its version)
  assert.deepEqual(s.lib.keysSet, [{ 'app-state-sync-version': { critical_unblock_low: null } }]);
  assert.deepEqual(a.resyncs, [[['critical_unblock_low'], true]]);

  assert.equal(from(a, { remoteJid: '5521977776666@s.whatsapp.net' }).saved, 'Tia Lúcia');
  assert.equal(from(a, { remoteJid: '552177776666@s.whatsapp.net' }).saved, 'Tia Lúcia');                     // without the 9th digit
  assert.equal(from(a, { remoteJid: '111222@lid' }).saved, 'Tia Lúcia');                                      // chat addressed by the opaque id
  assert.equal(from(a, { remoteJid: '999@lid', remoteJidAlt: '5521977776666@s.whatsapp.net' }).saved, 'Tia Lúcia');
  assert.equal(from(a, { remoteJid: '333444@lid' }).saved, 'Dr. Paulo');
  const other = from(a, { remoteJid: '5531955554444@s.whatsapp.net' }, 'Zé');
  assert.deepEqual([other.saved, other.name], ['', 'Zé']);                                                   // only the profile name
  assert.equal(s.wa.savedName([], '+55 (21) 97777-6666'), 'Tia Lúcia');

  // written once, a moment later; nothing else in the file
  assert.equal(existsSync(join(s.dir, 'names.json')), false);
  s.timers.at(-1).fn();
  assert.deepEqual(JSON.parse(readFileSync(join(s.dir, 'names.json'), 'utf8')),
    { synced: true, pn: { 552177776666: 'Tia Lúcia' }, lid: { 111222: 'Tia Lúcia', 333444: 'Dr. Paulo' } });

  // renamed and removed on the phone while online
  a.fire('contacts.upsert', [{ id: '5521977776666@s.whatsapp.net', name: 'Lúcia', lid: '111222@lid' }, { id: '333444@lid', name: undefined }]);
  assert.equal(from(a, { remoteJid: '111222@lid' }).saved, 'Lúcia');
  assert.equal(from(a, { remoteJid: '333444@lid' }).saved, '');
  s.wa.stop();                                                                                               // a pending write is not lost

  // server restarted: names come from the file, only the changes are asked for
  mkdirSync(join(s.dir, 'auth'), { recursive: true });
  writeFileSync(join(s.dir, 'auth', 'creds.json'), '{}');
  const lib2 = fakeLib();
  lib2.creds.me = { id: '5511988887777:4@s.whatsapp.net' };
  const wa2 = new WhatsApp({ dir: s.dir, lib: lib2, setTimer: () => 1, clearTimer: () => {} });
  await wa2.start();
  assert.equal(wa2.savedName(['5521977776666@s.whatsapp.net']), 'Lúcia');
  lib2.socks[0].user = { id: '5511988887777:4@s.whatsapp.net' };
  lib2.socks[0].fire('connection.update', { connection: 'open' });
  await tick();
  assert.deepEqual(lib2.socks[0].resyncs, [[['critical_unblock_low'], false]]);
  assert.deepEqual(lib2.keysSet, []);

  // unlinked: the address book of that account goes with the keys
  await wa2.logout();
  assert.equal(existsSync(join(s.dir, 'names.json')), false);
  assert.equal(wa2.savedName(['5521977776666@s.whatsapp.net']), '');
  s.cleanup();
});

test('session: groups only when enabled', async () => {
  const s = session({ groups: true });
  await s.wa.pair();
  const got = [];
  s.wa.on('message', (m) => got.push(m));
  s.lib.socks[0].fire('messages.upsert', { type: 'notify', messages: [
    { key: { id: 'G1', remoteJid: '123@g.us', participant: '99@lid', participantAlt: '5521977776666@s.whatsapp.net' }, message: { conversation: 'no grupo' }, pushName: 'Ana' }] });
  assert.equal(got.length, 1);
  assert.equal(got[0].group, true);
  assert.equal(got[0].number, '5521977776666');
  s.cleanup();
});

test('session: saved account reconnects by itself; removed on the phone -> forgotten', async () => {
  const s = session();
  mkdirSync(join(s.dir, 'auth'), { recursive: true });
  writeFileSync(join(s.dir, 'auth', 'creds.json'), '{}');
  s.lib.creds.me = { id: '5511988887777:4@s.whatsapp.net' };
  await s.wa.start();
  assert.equal(s.lib.socks.length, 1);                   // no QR needed
  const a = s.lib.socks[0];
  a.user = { id: '5511988887777:4@s.whatsapp.net' };
  a.fire('connection.update', { connection: 'open' });
  assert.equal(s.wa.status().state, 'open');

  a.fire('connection.update', closed(428));              // connection dropped
  assert.equal(s.wa.status().state, 'connecting');
  assert.equal(s.wa.status().linked, true);
  assert.equal(s.timers.length, 1);
  assert.equal(s.timers[0].ms, 2000);
  await assert.rejects(s.wa.sendToSelf('x'), /not_connected/);
  s.timers[0].fn();
  await tick();
  assert.equal(s.lib.socks.length, 2);
  const b = s.lib.socks[1];
  b.fire('connection.update', closed(428));
  assert.equal(s.timers[1].ms, 4000);                    // backs off
  s.timers[1].fn();
  await tick();
  const c = s.lib.socks[2];
  c.user = a.user;
  c.fire('connection.update', { connection: 'open' });
  c.fire('connection.update', closed(401));              // device removed in "Dispositivos conectados"
  const end = s.wa.status();
  assert.equal(end.state, 'idle');
  assert.equal(end.linked, false);
  assert.equal(end.me, null);
  assert.equal(end.error, 'logged_out');
  assert.ok(!existsSync(join(s.dir, 'auth')));
  assert.equal(s.timers.length, 2);                      // no retry: a new pairing is needed
  s.cleanup();
});

test('session: refused by WhatsApp -> stops insisting, tries again only when asked', async () => {
  const s = session();
  mkdirSync(join(s.dir, 'auth'), { recursive: true });
  writeFileSync(join(s.dir, 'auth', 'creds.json'), '{}');
  s.lib.creds.me = { id: '5511988887777:4@s.whatsapp.net' };
  await s.wa.start();
  s.lib.socks[0].fire('connection.update', closed(403));
  assert.equal(s.wa.status().state, 'idle');
  assert.equal(s.wa.status().error, 'forbidden');
  assert.equal(s.wa.status().linked, true);                // the keys are kept
  assert.equal(s.timers.length, 0);
  assert.equal(await s.wa.pair(), 'reconnecting');
  assert.equal(s.lib.socks.length, 2);
  assert.equal(s.wa.status().state, 'connecting');
  s.cleanup();
});

test('session: logout unlinks and deletes the keys; stop does not reconnect', async () => {
  const s = session();
  mkdirSync(join(s.dir, 'auth'), { recursive: true });
  writeFileSync(join(s.dir, 'auth', 'creds.json'), '{}');
  s.lib.creds.me = { id: '5511988887777:4@s.whatsapp.net' };
  await s.wa.start();
  const a = s.lib.socks[0];
  a.user = { id: '5511988887777:4@s.whatsapp.net' };
  a.fire('connection.update', { connection: 'open' });
  await s.wa.logout();
  assert.equal(a.loggedOut, true);
  assert.equal(s.wa.status().state, 'idle');
  assert.equal(s.wa.status().linked, false);
  assert.ok(!existsSync(join(s.dir, 'auth')));
  a.fire('connection.update', closed(401));              // the close that follows is from a socket we dropped
  assert.equal(s.timers.length, 0);

  s.lib.creds = {};
  await s.wa.pair();
  const b = s.lib.socks[1];
  s.wa.stop();
  assert.equal(b.ended, true);
  b.fire('connection.update', closed(428));
  assert.equal(s.lib.socks.length, 2);
  s.cleanup();
});

// ---- bridge --------------------------------------------------------------------
function fakeWa(initial = {}) {
  const wa = new EventEmitter();
  wa.s = { state: 'idle', linked: false, me: null, since: null, error: null, qr: null, code: null, pairNumber: null, ...initial };
  wa.groups = false;
  wa.sent = [];
  wa.pairs = 0;
  wa.asked = [];
  wa.failSend = false;
  wa.status = () => ({ ...wa.s });
  wa.pair = async (opts) => { wa.pairs += 1; wa.asked.push(opts); return wa.s.linked ? 'linked' : 'started'; };
  wa.setPairNumber = (n) => { wa.s.pairNumber = n; };
  wa.logout = async () => { wa.set({ state: 'idle', linked: false, me: null }); };
  wa.sendToSelf = async (text) => { if (wa.failSend || wa.s.state !== 'open') throw new Error('not_connected'); wa.sent.push(text); };
  wa.set = (s) => { Object.assign(wa.s, s); wa.emit('state', wa.status()); };
  return wa;
}

function bridge({ wa = fakeWa(), contacts = [], persist = false, dir = '/nonexistent' } = {}) {
  const pub = [];
  let now = T0;
  const b = new WaBridge({ wa, dir, persist, contacts: () => contacts, now: () => now, publish: (topic, payload, opts) => pub.push({ topic, payload: JSON.parse(payload), opts }) });
  const node = (lv, extra = {}, retained = false) => b.onMqtt('airguard/KITCHEN_01/state',
    Buffer.from(JSON.stringify({ boot: 3, up: 600, lv, relay: false, flags: 0, temp: 25, rh: 60, gas: 0.2, ...extra })), retained);
  return { b, wa, pub, node, advance: (ms) => { now += ms; }, at: () => now };
}

test('bridge: session state goes to the node (retained): the pairing code, never the QR', () => {
  const x = bridge();
  x.wa.set({ state: 'connecting' });
  x.wa.set({ state: 'code', code: { code: 'ABCD1234', ttl: 165, expiresAt: T0 + 160_000 } });
  x.wa.set({ state: 'qr', code: null, qr: { n: 61, bits: 'QUJD', ttl: 65, expiresAt: T0 + 60_000 } });
  x.wa.set({ state: 'open', linked: true, qr: null, me: { number: '5511988887777', name: 'Davi' } });
  x.wa.set({ state: 'idle', linked: false, me: null });
  assert.deepEqual(x.pub.map((p) => p.payload), [
    { state: 'connecting' },
    { state: 'code', code: 'ABCD1234', ttl: 165 },
    { state: 'qr' },                                  // the QR is for the page only
    { state: 'open', me: '5511988887777' },
    { state: 'idle' },
  ]);
  for (const p of x.pub) { assert.equal(p.topic, TOPIC_LINK); assert.deepEqual(p.opts, { qos: 1, retain: true }); }
});

test('bridge: the page pairs with a code (number given) or with a QR; both restart a running attempt', async () => {
  const x = bridge();
  assert.equal(await x.b.connect({ number: '5567999998888' }), 'started');
  assert.equal(x.wa.status().pairNumber, '5567999998888');
  assert.equal(await x.b.connect(), 'started');
  assert.deepEqual(x.wa.asked, [{ mode: 'code', restart: true }, { mode: 'qr', restart: true }]);
});

test('bridge: a node that was just switched on asks for a pairing', async () => {
  const x = bridge();
  assert.deepEqual(x.b.onMqtt('airguard/KITCHEN_01/event', Buffer.from('{"k":"hello","boot":12,"fw":"1.0.0"}')), { device: 'KITCHEN_01', hello: true });
  await tick();
  assert.equal(x.wa.pairs, 1);
  assert.equal(x.wa.asked[0], undefined);             // the session decides: code when a number is saved
  // other topics and garbage are not for us
  assert.equal(x.b.onMqtt('airguard/KITCHEN_01/telemetry', Buffer.from('{}')).ignored, 'topic');
  assert.equal(x.b.onMqtt('airguard/whatsapp/state', Buffer.from('{"lv":"NNNN"}')).ignored, 'topic');
  assert.equal(x.b.onMqtt('airguard/KITCHEN_01/state', Buffer.from('{oops')).error, 'json');
  assert.equal(x.b.onMqtt('airguard/KITCHEN_01/state', Buffer.alloc(0)).ignored, 'empty');
  assert.equal(x.b.onMqtt('airguard/KITCHEN_01/state', Buffer.from('{"lv":"NN"}')).error, 'state');
  assert.equal(x.b.onMqtt('airguard/KITCHEN_01/event', Buffer.from('{"k":"other"}')).ignored, 'event');
});

test('bridge: alert, relay and back to normal become WhatsApp messages to the own number', async () => {
  const x = bridge({ wa: fakeWa({ state: 'open', linked: true, me: { number: '5511988887777', name: '' } }) });
  const notices = [];
  x.b.subscribe((type, data) => { if (type === 'notice') notices.push({ ...data }); });
  x.node('NNNN');
  x.b.tick();
  await tick();
  assert.equal(x.wa.sent.length, 0);

  x.advance(1000);
  x.node('HNNN', { relay: true, gas: 1.82 });
  x.b.tick();
  await tick();
  assert.equal(x.wa.sent.length, 1);
  assert.match(x.wa.sent[0], /ALERTA/);
  assert.match(x.wa.sent[0], /\*Alerta:\* Gás\n\*Gravidade:\* ALTA/);
  assert.match(x.wa.sent[0], /desligou a energia da residência/);
  assert.match(x.wa.sent[0], /KITCHEN_01/);

  x.advance(30_000);
  x.node('HNNN', { relay: true, gas: 1.9 });             // periodic repeat: no new message
  x.b.tick();
  await tick();
  assert.equal(x.wa.sent.length, 1);

  x.advance(10_000);
  x.node('NNNN', { gas: 0.3 });
  x.b.tick();
  await tick();
  assert.equal(x.wa.sent.length, 1);                     // waits to be stable
  x.advance(3000);
  x.b.tick();
  await tick();
  assert.equal(x.wa.sent.length, 2);
  assert.match(x.wa.sent[1], /NORMALIZADO/);
  assert.match(x.wa.sent[1], /religou a energia da residência/);
  assert.deepEqual(x.b.view().notices.map((n) => [n.kind, n.status]), [['alert', 'sent'], ['recovery', 'sent']]);
  assert.deepEqual(notices.map((n) => n.status), ['queued', 'sent', 'queued', 'sent']);
});

test('bridge: alerts wait for the session to come back; without an account they are only recorded', async () => {
  const x = bridge({ wa: fakeWa({ state: 'connecting', linked: true }) });
  x.node('NMNN');
  x.b.tick();
  await tick();
  assert.equal(x.wa.sent.length, 0);
  assert.equal(x.b.view().notices[0].status, 'queued');
  x.advance(5 * 60_000);
  x.wa.set({ state: 'open' });                           // WhatsApp is back 5 min later
  await tick();
  assert.equal(x.wa.sent.length, 1);
  assert.match(x.wa.sent[0], /Temperatura/);
  assert.match(x.wa.sent[0], /ocorrido há 5 min/);
  assert.equal(x.b.view().notices[0].status, 'sent');

  const y = bridge();                                    // nobody linked
  y.node('HNNN');
  y.b.tick();
  await tick();
  assert.deepEqual(y.b.view().notices.map((n) => [n.status, n.reason]), [['dropped', 'not_linked']]);
  y.wa.set({ state: 'open', linked: true });
  await tick();
  assert.equal(y.wa.sent.length, 0);                     // an old alert is not sent to whoever links later
});

test('bridge: a failed send is retried, in order', async () => {
  const x = bridge({ wa: fakeWa({ state: 'open', linked: true }) });
  x.wa.failSend = true;
  x.node('LNNN');
  x.b.tick();
  await tick();
  assert.equal(x.b.view().notices[0].status, 'queued');
  x.wa.failSend = false;
  x.b.tick();
  await tick();
  assert.equal(x.wa.sent.length, 1);
  assert.equal(x.b.view().notices[0].status, 'sent');
});

test('bridge: a WhatsApp message goes to the node, shortened and without emoji', () => {
  const x = bridge({ contacts: [{ name: 'Farmácia do bairro', phone: '+5521977776666' }] });
  const m0 = x.b.onWhatsAppMessage({ waId: 'A', chat: 'c', number: '5531966665555', name: 'Maria \u{1F338}', kind: 'text', text: 'antes do AirGuard ligar', t: T0 });
  assert.equal(m0.node, 'offline');                      // no node heard yet
  assert.equal(x.pub.length, 0);

  x.node('NNNN');
  const m1 = x.b.onWhatsAppMessage({ waId: 'B', chat: 'c', number: '552177776666', name: 'Zé', kind: 'text', text: 'Chegou \u{1F600} o remédio\nque você pediu', t: T0 });
  assert.equal(m1.name, 'Farmácia do bairro');           // registered contact (9th digit or not) wins over the profile name
  assert.equal(m1.nameFrom, 'airguard');
  assert.equal(m1.node, 'sent');
  assert.equal(m1.numberDisplay, '+55 (21) 7777-6666');
  assert.deepEqual(x.pub.at(-1), { topic: TOPIC_INBOX, payload: { id: m1.id, from: 'Farmácia do bairro', text: 'Chegou o remédio que você pediu' }, opts: { qos: 0, retain: false } });

  assert.equal(x.b.onWhatsAppMessage({ waId: 'B', chat: 'c', number: '552177776666', kind: 'text', text: 'again', t: T0 }), null);  // same WhatsApp id twice
  const m2 = x.b.onWhatsAppMessage({ waId: 'C', chat: 'c', number: '', name: '', kind: 'text', text: '\u{1F602}\u{1F602}', t: T0 });
  assert.equal(m2.node, 'empty');
  assert.equal(m2.name, 'Desconhecido');
  const m3 = x.b.onWhatsAppMessage({ waId: 'D', chat: 'c', number: '5531966665555', name: '', kind: 'text', text: 'velha', t: T0 - 10 * 60_000 });
  assert.equal(m3.node, 'old');                          // delivered late by WhatsApp: listed, not shown
  assert.equal(m3.name, '+55 (31) 96666-5555');
  assert.equal(x.pub.filter((p) => p.topic === TOPIC_INBOX).length, 1);

  // what the node did with it
  assert.deepEqual(x.b.onMqtt('airguard/KITCHEN_01/event', Buffer.from(JSON.stringify({ k: 'wa', id: m1.id, res: 'ignored' }))), { device: 'KITCHEN_01', result: true });
  assert.equal(x.b.view().messages.find((m) => m.id === m1.id).result, 'ignored');
  assert.equal(x.b.onMqtt('airguard/KITCHEN_01/event', Buffer.from('{"k":"wa","id":990001,"res":"shown"}')).result, false);
  assert.deepEqual(x.b.view().messages.map((m) => m.id), [1, 2, 3, 4]);
});

test('bridge: sender shown by the contact name; the number only when there is no name', () => {
  const x = bridge({ contacts: [{ name: 'Farmácia', phone: '+5521977776666' }] });
  x.node('NNNN');
  const book = new Map([['5531966665555', 'Tia Lúcia']]);
  x.wa.savedName = (jids, number) => book.get(number) || '';
  let n = 0;
  const who = (m) => { const it = x.b.onWhatsAppMessage({ waId: `S${n += 1}`, chat: `${m.number}@s.whatsapp.net`, kind: 'text', text: 'oi', t: T0, ...m }); return [it.name, it.nameFrom, x.pub.at(-1).payload.from]; };
  // registered in AirGuard > saved on the phone > the name the sender chose > the number
  assert.deepEqual(who({ number: '5521977776666', saved: 'Farm. (agenda)', name: 'Perfil' }), ['Farmácia', 'airguard', 'Farmácia']);
  assert.deepEqual(who({ number: '5531966665555', saved: 'Tia Lúcia', name: 'Lu \u{1F338}' }), ['Tia Lúcia', 'phone', 'Tia Lúcia']);
  assert.deepEqual(who({ number: '5541955554444', saved: '', name: 'Zé \u{1F60E}' }), ['Zé', 'profile', 'Zé']);
  assert.deepEqual(who({ number: '5541955554444', saved: '', name: '~' }), ['+55 (41) 95555-4444', 'number', '+55 (41) 95555-4444']);  // not a name
  assert.deepEqual(who({ number: '5541955554444', saved: '', name: '\u{1F338}' }), ['+55 (41) 95555-4444', 'number', '+55 (41) 95555-4444']);

  // the list follows the address book: saved after the message arrived, renamed, removed
  const last = () => x.b.view().messages.filter((m) => m.number === '5541955554444').map((m) => [m.name, m.nameFrom]);
  book.set('5541955554444', 'Seu João');
  assert.deepEqual(last(), [['Seu João', 'phone'], ['Seu João', 'phone'], ['Seu João', 'phone']]);
  book.delete('5541955554444');
  assert.deepEqual(last(), [['Zé', 'profile'], ['+55 (41) 95555-4444', 'number'], ['+55 (41) 95555-4444', 'number']]);
  // a message stored before names were kept (no origin, "~" as the name)
  x.b.messages.add({ id: 99, t: T0, at: T0, waId: 'OLD', chat: '77@lid', group: false, number: '5531966665555', numberDisplay: '+55 (31) 96666-5555', name: '~', kind: 'text', text: 'oi', node: 'sent', result: null });
  assert.deepEqual([x.b.view().messages.at(-1).name, x.b.view().messages.at(-1).nameFrom], ['Tia Lúcia', 'phone']);
  book.clear();
  assert.deepEqual([x.b.view().messages.at(-1).name, x.b.view().messages.at(-1).nameFrom], ['+55 (31) 96666-5555', 'number']);
});

test('bridge: node online only while it keeps talking; a retained state does not count', () => {
  const x = bridge();
  x.node('NNNN', {}, true);                              // from the broker's memory at start-up
  assert.equal(x.b.nodeOnline(), false);
  assert.deepEqual(x.b.nodeView().map((n) => [n.device, n.online, n.alert]), [['KITCHEN_01', false, false]]);
  x.node('NLNN');
  assert.equal(x.b.nodeOnline(), true);
  assert.equal(x.b.nodeView()[0].alert, true);
  x.advance(76_000);
  assert.equal(x.b.nodeOnline(), false);
});

test('bridge: messages, alert messages and what was reported survive a restart', async () => {
  const dir = tmp();
  const a = bridge({ wa: fakeWa({ state: 'open', linked: true }), persist: true, dir });
  a.node('NNNN');
  const m = a.b.onWhatsAppMessage({ waId: 'A', chat: 'c', number: '5531966665555', name: 'Maria', kind: 'text', text: 'oi', t: T0 });
  a.b.onMqtt('airguard/KITCHEN_01/event', Buffer.from(JSON.stringify({ k: 'wa', id: m.id, res: 'shown' })));
  a.node('NNHN');
  a.b.tick();
  await tick();
  assert.equal(a.wa.sent.length, 1);

  const b = bridge({ wa: fakeWa({ state: 'open', linked: true }), persist: true, dir });
  assert.deepEqual(b.b.view().messages.map((x) => [x.id, x.text, x.result]), [[1, 'oi', 'shown']]);
  assert.deepEqual(b.b.view().notices.map((x) => [x.kind, x.status]), [['alert', 'sent']]);
  assert.equal(b.b.onWhatsAppMessage({ waId: 'A', chat: 'c', number: '1', kind: 'text', text: 'dup', t: T0 }), null);
  assert.equal(b.b.onWhatsAppMessage({ waId: 'B', chat: 'c', number: '1', kind: 'text', text: 'novo', t: T0 }).id, 2);
  b.node('NNHN', {}, true);                              // same state as already reported: silence
  b.b.tick();
  await tick();
  assert.equal(b.wa.sent.length, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'reported.json'), 'utf8')), { KITCHEN_01: { lv: [0, 0, 3, 0], relay: false } });
  rmSync(dir, { recursive: true, force: true });
});

test('bridge: disconnect drops what was waiting and unlinks', async () => {
  const x = bridge({ wa: fakeWa({ state: 'connecting', linked: true }) });
  x.node('HNNN');
  x.b.tick();
  await tick();
  await x.b.disconnect();
  assert.deepEqual(x.b.view().notices.map((n) => [n.status, n.reason]), [['dropped', 'unlinked']]);
  assert.equal(x.b.view().link.linked, false);
  assert.equal(await x.b.connect(), 'started');
});

// ---- HTTP -----------------------------------------------------------------------
test('http: WhatsApp routes need the access code; linking/unlinking also the edit password', async () => {
  const dir = tmp();
  const store = new Store(join(dir, 'db.json'));
  const tok = newToken();
  const u = store.addUser('Ana', hashToken(tok));
  store.setPassword(u.id, hashPassword('cozinha42'));
  const x = bridge({ wa: fakeWa({ state: 'open', linked: true, me: { number: '5511988887777', name: 'Ana' } }) });
  const server = createApp(store, { whatsapp: x.b, limiter: new FailLimiter({ max: 50 }) }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, init = {}) => fetch(base + path, { ...init, headers: { authorization: `Bearer ${tok}`, ...(init.headers || {}) } });
  try {
    assert.equal((await fetch(`${base}/api/whatsapp/state`)).status, 401);
    const view = await (await call('/api/whatsapp/state')).json();
    assert.equal(view.link.state, 'open');
    assert.equal(view.link.me.number, '5511988887777');
    assert.deepEqual(view.messages, []);

    assert.equal((await call('/api/whatsapp/disconnect', { method: 'POST' })).status, 403);
    assert.equal((await call('/api/whatsapp/connect', { method: 'POST', headers: { 'x-edit-password': 'errada' } })).status, 403);
    assert.equal(x.wa.pairs, 0);
    const c = await call('/api/whatsapp/connect', { method: 'POST', headers: { 'x-edit-password': 'cozinha42' } });
    assert.deepEqual(await c.json(), { result: 'linked' });
    assert.equal((await call('/api/whatsapp/disconnect', { method: 'POST', headers: { 'x-edit-password': 'cozinha42' } })).status, 204);
    assert.equal(x.wa.status().linked, false);

    // pairing with the code: the number of the account, typed as any Brazilian phone
    const json = (body) => ({ method: 'POST', headers: { 'x-edit-password': 'cozinha42', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const bad = await call('/api/whatsapp/connect', json({ phone: '12345' }));
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: 'invalid_phone' });
    assert.equal(x.wa.status().pairNumber, null);
    const ok = await call('/api/whatsapp/connect', json({ phone: '(67) 99999-8888' }));
    assert.deepEqual(await ok.json(), { result: 'started' });
    assert.equal(x.wa.status().pairNumber, '5567999998888');
    assert.deepEqual(x.wa.asked.at(-1), { mode: 'code', restart: true });
    assert.equal((await call('/api/whatsapp/connect', json({}))).status, 200);
    assert.deepEqual(x.wa.asked.at(-1), { mode: 'qr', restart: true });

    // live stream: starts with the whole picture, then one event per change
    const ctl = new AbortController();
    const r = await call('/api/whatsapp/stream', { signal: ctl.signal });
    assert.match(r.headers.get('content-type'), /^text\/event-stream/);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = dec.decode((await reader.read()).value);
    assert.match(buf, /^event: init\ndata: \{/);
    x.node('NNNN');
    x.b.onWhatsAppMessage({ waId: 'Z', chat: 'c', number: '5531966665555', name: 'Maria', kind: 'text', text: 'ao vivo', t: Date.now() });
    for (let i = 0; i < 5 && !buf.includes('event: message'); i += 1) buf += dec.decode((await reader.read()).value);
    assert.match(buf, /event: node\n/);
    assert.match(buf, /event: message\ndata: \{[^\n]*"text":"ao vivo"/);
    ctl.abort();
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('http: without the WhatsApp service the routes do not exist', async () => {
  const dir = tmp();
  const store = new Store(join(dir, 'db.json'));
  const tok = newToken();
  store.addUser('Ana', hashToken(tok));
  const server = createApp(store, {}).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/whatsapp/state`, { headers: { authorization: `Bearer ${tok}` } });
    assert.equal(r.status, 404);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
