import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, FailLimiter } from '../src/app.js';
import { Store } from '../src/store.js';
import { newToken, hashToken, looksLikeToken } from '../src/tokens.js';
import { normalizePhone, formatPhone, cleanName } from '../src/phone.js';
import { hashPassword, checkPassword } from '../src/passwords.js';

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
const PW = 'cozinha42';  // edit password of Ana and Bruno
const limiter = new FailLimiter({ max: 5, windowMs: 60_000, now: () => now });

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agw-'));
  store = new Store(join(dir, 'db.json'));
  tokA = newToken(); store.addUser('Ana', hashToken(tokA));
  tokB = newToken(); const b = store.addUser('Bruno', hashToken(tokB));
  store.setPassword(store.data.users[0].id, hashPassword(PW));
  store.setPassword(b.id, hashPassword(PW));
  devKey = newToken(); store.addDevice('ESP32', hashToken(devKey));
  server = createApp(store, { limiter }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

const api = (path, tok, init = {}) =>
  fetch(base + path, { ...init, headers: { 'content-type': 'application/json', 'x-edit-password': PW, ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...(init.headers || {}) } });

test('API: rejects missing / wrong codes', async () => {
  assert.equal((await api('/api/me')).status, 401);
  assert.equal((await api('/api/me', newToken())).status, 401);
  const r = await api('/api/me', tokA);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { name: 'Ana', hasPassword: true });
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

test('passwords: scrypt hash, salted, checked', () => {
  const h = hashPassword('abcd');
  assert.match(h, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  assert.notEqual(h, hashPassword('abcd'));
  assert.ok(checkPassword('abcd', h));
  assert.ok(!checkPassword('abce', h));
  assert.ok(!checkPassword('abcd', 'garbage'));
});

test('API: add / edit / delete need the edit password', async () => {
  now += 61_000;  // fresh limiter window
  const body = JSON.stringify({ name: 'Gás', phone: '1140041234', category: 'gas' });
  let r = await api('/api/contacts', tokA, { method: 'POST', body, headers: { 'x-edit-password': '' } });
  assert.equal(r.status, 403);
  r = await api('/api/contacts', tokA, { method: 'POST', body, headers: { 'x-edit-password': 'errada' } });
  assert.equal(r.status, 403);
  assert.deepEqual(await r.json(), { error: 'wrong_password' });
  r = await api('/api/contacts', tokA, { method: 'POST', body });
  assert.equal(r.status, 201);
  const c = await r.json();
  assert.equal((await api(`/api/contacts/${c.id}`, tokA, { method: 'DELETE', headers: { 'x-edit-password': 'x' } })).status, 403);
  assert.equal((await api(`/api/contacts/${c.id}`, tokA, { method: 'DELETE' })).status, 204);
  now += 61_000;  // the wrong guesses above count in the limiter
});

test('API: edit a contact (name, phone, category); validated, per user', async () => {
  now += 61_000;
  let r = await api('/api/contacts', tokA, { method: 'POST', body: JSON.stringify({ name: 'Farmácia', phone: '1132320000', category: 'farmacia' }) });
  const c = await r.json();
  await api('/api/contacts', tokA, { method: 'POST', body: JSON.stringify({ name: 'Outro', phone: '1132321111' }) });
  r = await api(`/api/contacts/${c.id}`, tokA, { method: 'PUT', body: JSON.stringify({ name: 'Drogaria 24h', phone: '(11) 3232-9999', category: 'farmacia' }) });
  assert.equal(r.status, 200);
  const e = await r.json();
  assert.equal(e.id, c.id);
  assert.equal(e.name, 'Drogaria 24h');
  assert.equal(e.phone, '+551132329999');
  r = await api(`/api/contacts/${c.id}`, tokA, { method: 'PUT', body: JSON.stringify({ name: 'X', phone: '1132321111' }) });
  assert.equal(r.status, 409);                                                    // number of another contact
  r = await api(`/api/contacts/${c.id}`, tokA, { method: 'PUT', body: JSON.stringify({ name: 'X', phone: '1132329999', category: 'medico' }) });
  assert.equal(r.status, 200);                                                    // keeping its own number is fine
  assert.equal((await api(`/api/contacts/${c.id}`, tokA, { method: 'PUT', body: JSON.stringify({ name: '', phone: '1132329999' }) })).status, 400);
  assert.equal((await api(`/api/contacts/${c.id}`, tokB, { method: 'PUT', body: JSON.stringify({ name: 'Y', phone: '1132328888' }) })).status, 404);
});

test('API: set and change the edit password', async () => {
  now += 61_000;
  const other = new Store(join(dir, 'db.json'));
  const tokD = newToken();
  other.addUser('Davi', hashToken(tokD));
  const noPw = { 'x-edit-password': '' };
  assert.deepEqual(await (await api('/api/me', tokD)).json(), { name: 'Davi', hasPassword: false });
  let r = await api('/api/contacts', tokD, { method: 'POST', body: JSON.stringify({ name: 'A', phone: '1130000000' }), headers: noPw });
  assert.equal(r.status, 428);                                                    // must create one first
  assert.equal((await api('/api/password', tokD, { method: 'POST', body: JSON.stringify({ password: 'abc' }) })).status, 400);  // too short
  assert.equal((await api('/api/password', tokD, { method: 'POST', body: JSON.stringify({ password: 'primeira' }) })).status, 204);
  assert.equal((await (await api('/api/me', tokD)).json()).hasPassword, true);
  assert.equal((await api('/api/password/check', tokD, { method: 'POST', headers: { 'x-edit-password': 'primeira' } })).status, 204);
  assert.equal((await api('/api/password/check', tokD, { method: 'POST', headers: { 'x-edit-password': 'nao' } })).status, 403);
  // change: the current one is required
  assert.equal((await api('/api/password', tokD, { method: 'POST', body: JSON.stringify({ password: 'segunda' }) })).status, 403);
  assert.equal((await api('/api/password', tokD, { method: 'POST', body: JSON.stringify({ password: 'segunda', current: 'primeira' }) })).status, 204);
  r = await api('/api/contacts', tokD, { method: 'POST', body: JSON.stringify({ name: 'A', phone: '1130000000' }), headers: { 'x-edit-password': 'segunda' } });
  assert.equal(r.status, 201);
  assert.ok(!readFileSync(join(dir, 'db.json'), 'utf8').includes('segunda'), 'only the hash is stored');
  now += 61_000;
});

test('API: repeated failures from one IP are throttled', async () => {
  now = 1_000_000;  // fresh window
  for (let i = 0; i < 5; i++) await api('/api/me', newToken());
  assert.equal((await api('/api/me', tokA)).status, 429);   // even a valid code waits
  now += 61_000;
  assert.equal((await api('/api/me', tokA)).status, 200);
});
