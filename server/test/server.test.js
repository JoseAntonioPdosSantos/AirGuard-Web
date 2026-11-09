import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, FailLimiter } from '../src/app.js';
import { Store } from '../src/store.js';
import { newToken, hashToken, looksLikeToken } from '../src/tokens.js';
import { normalizePhone, formatPhone, cleanName } from '../src/phone.js';

// ---- pure helpers -----------------------------------------------------------
test('tokens: 256-bit, base64url, unique, hash only', () => {
  const a = newToken(), b = newToken();
  assert.equal(a.length, 43);
  assert.ok(looksLikeToken(a));
  assert.notEqual(a, b);
  assert.equal(Buffer.from(a, 'base64url').length, 32);
  assert.match(hashToken(a), /^[0-9a-f]{64}$/);
  assert.ok(!looksLikeToken('short'));
  assert.ok(!looksLikeToken(a + 'x'));
});

test('phone: Brazilian formats normalise to E.164', () => {
  for (const s of ['(11) 98888-7777', '11988887777', '+55 11 98888 7777', '011 98888-7777', '0 15 11 98888 7777'])
    assert.equal(normalizePhone(s), '+5511988887777', s);
  assert.equal(normalizePhone('(21) 3333-4444'), '+552133334444');       // landline
  assert.equal(normalizePhone('+1 415 555 0100'), '+14155550100');       // other country
  for (const bad of ['', 'abc', '1234', '(11) 8888-777', '(00) 98888-7777', '11 18888-7777', '+0 123', '9'.repeat(40)])
    assert.equal(normalizePhone(bad), null, bad);
  assert.equal(formatPhone('+5511988887777'), '+55 (11) 98888-7777');
});

test('names: trimmed, control chars removed, 1..40 chars', () => {
  assert.equal(cleanName('  Maria   da  Silva '), 'Maria da Silva');
  assert.equal(cleanName('a\u0000b'), 'ab');
  assert.equal(cleanName(''), null);
  assert.equal(cleanName('x'.repeat(41)), null);
});

// ---- HTTP API -----------------------------------------------------------------
let dir, store, server, base, tokA, tokB, devKey, now = 0;
const limiter = new FailLimiter({ max: 5, windowMs: 60_000, now: () => now });

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agw-'));
  store = new Store(join(dir, 'db.json'));
  tokA = newToken(); store.addUser('Ana', hashToken(tokA));
  tokB = newToken(); store.addUser('Bruno', hashToken(tokB));
  devKey = newToken(); store.addDevice('ESP32', hashToken(devKey));
  server = createApp(store, { limiter }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

const api = (path, tok, init = {}) =>
  fetch(base + path, { ...init, headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...(init.headers || {}) } });

test('API: rejects missing / wrong codes', async () => {
  assert.equal((await api('/api/me')).status, 401);
  assert.equal((await api('/api/me', newToken())).status, 401);
  const r = await api('/api/me', tokA);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { name: 'Ana' });
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
});

test('API: add, list and delete contacts; lists are per user', async () => {
  let r = await api('/api/contacts', tokA, { method: 'POST', body: JSON.stringify({ name: 'Mãe', phone: '(11) 98888-7777' }) });
  assert.equal(r.status, 201);
  const c = await r.json();
  assert.equal(c.phone, '+5511988887777');
  assert.equal(c.phoneDisplay, '+55 (11) 98888-7777');
  assert.equal(c.category, 'outro');                             // default when omitted
  r = await api('/api/contacts', tokA, { method: 'POST', body: JSON.stringify({ name: 'Mãe 2', phone: '11988887777' }) });
  assert.equal(r.status, 409);                                   // same number twice
  r = await api('/api/contacts', tokA, { method: 'POST', body: JSON.stringify({ name: '', phone: '11988887777' }) });
  assert.equal(r.status, 400);
  r = await api('/api/contacts', tokA, { method: 'POST', body: JSON.stringify({ name: 'X', phone: '123' }) });
  assert.equal(r.status, 400);

  assert.equal((await (await api('/api/contacts', tokA)).json()).length, 1);
  assert.equal((await (await api('/api/contacts', tokB)).json()).length, 0);   // Bruno sees nothing of Ana's
  assert.equal((await api(`/api/contacts/${c.id}`, tokB, { method: 'DELETE' })).status, 404);  // cannot delete others'
  assert.equal((await api(`/api/contacts/${c.id}`, tokA, { method: 'DELETE' })).status, 204);
  assert.equal((await (await api('/api/contacts', tokA)).json()).length, 0);
});

test('API: contact categories are validated and returned', async () => {
  let r = await api('/api/contacts', tokA, { method: 'POST', body: JSON.stringify({ name: 'Drogaria', phone: '1133334444', category: 'farmacia' }) });
  assert.equal(r.status, 201);
  const c = await r.json();
  assert.equal(c.category, 'farmacia');
  r = await api('/api/contacts', tokA, { method: 'POST', body: JSON.stringify({ name: 'X', phone: '1133335555', category: 'nave' }) });
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: 'invalid_category' });
  r = await api('/api/contacts', tokA, { method: 'POST', body: JSON.stringify({ name: 'X', phone: '1133335555', category: 7 }) });
  assert.equal(r.status, 400);
  assert.equal((await api(`/api/contacts/${c.id}`, tokA, { method: 'DELETE' })).status, 204);
});

test('API: data file never contains an access code', async () => {
  await api('/api/contacts', tokA, { method: 'POST', body: JSON.stringify({ name: 'Pai', phone: '21999990000' }) });
  const raw = readFileSync(join(dir, 'db.json'), 'utf8');
  assert.ok(!raw.includes(tokA) && !raw.includes(tokB) && !raw.includes(devKey));
  assert.ok(raw.includes(hashToken(tokA)));
});

test('device API: key required, returns every user\'s numbers once', async () => {
  await api('/api/contacts', tokB, { method: 'POST', body: JSON.stringify({ name: 'Vizinho', phone: '21999990000' }) });
  await api('/api/contacts', tokB, { method: 'POST', body: JSON.stringify({ name: 'Zelador', phone: '21988887777' }) });
  assert.equal((await fetch(base + '/api/device/contacts')).status, 401);
  assert.equal((await fetch(base + '/api/device/contacts', { headers: { 'x-device-key': tokA } })).status, 401); // user code is not a device key
  const r = await fetch(base + '/api/device/contacts', { headers: { 'x-device-key': devKey } });
  assert.equal(r.status, 200);
  const { contacts } = await r.json();
  assert.deepEqual(contacts.map((c) => c.phone).sort(), ['+5521988887777', '+5521999990000']);
  assert.ok(contacts.every((c) => c.category === 'outro'));
});

test('API: CLI changes are seen without restart; revoked users lose access', async () => {
  const other = new Store(join(dir, 'db.json'));      // what the CLI does
  const tokC = newToken();
  const u = other.addUser('Carla', hashToken(tokC));
  assert.equal((await api('/api/me', tokC)).status, 200);
  other.revokeUser(u.id);
  assert.equal((await api('/api/me', tokC)).status, 401);
});

test('API: repeated failures from one IP are throttled', async () => {
  now = 1_000_000;  // fresh window
  for (let i = 0; i < 5; i++) await api('/api/me', newToken());
  assert.equal((await api('/api/me', tokA)).status, 429);   // even a valid code waits
  now += 61_000;
  assert.equal((await api('/api/me', tokA)).status, 200);
});
