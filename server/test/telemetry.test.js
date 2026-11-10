import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { Store } from '../src/store.js';
import { Telemetry } from '../src/telemetry.js';
import { newToken, hashToken } from '../src/tokens.js';

const T0 = Date.UTC(2026, 10, 10, 12, 0, 0);
const hb = (seq, extra = {}) => JSON.stringify({ v: 1, type: 'HB', device: 'KITCHEN_01', dst: 'GATEWAY_01', seq,
  levels: 'NNNN', air_index: 10, temperature: 24.6, humidity: 58, timestamp: seq * 5, ...extra });
const alert = (id, sev = 'MEDIUM') => JSON.stringify({ v: 1, type: 'ALERT', device: 'KITCHEN_01', dst: 'GATEWAY_01',
  event_id: id, category: 'AIR_QUALITY', severity: sev, air_index: 22, timestamp: 9 });

function clock(t = T0) {
  const c = { t, now: () => c.t };
  return c;
}

test('node env record becomes a sample and the current reading', () => {
  const c = clock();
  const tm = new Telemetry('', { now: c.now, persist: false });
  tm.ingest([{ src: 'node', k: 'env', ms: 1, pc: T0, temp: 25.4, rh: 61, hi: 25.9, gas: 0.42, ao: 0.43, adc: 500,
    env: 'ok', air: 'ok', lv: 'MNNN', ov: 'MEDIUM', relay: false, flags: 0, lora: 'ok', q: 0, wack: 0, up: 10 }]);
  const s = tm.state();
  assert.equal(s.node.online, true);
  assert.equal(s.current.via, 'node');
  assert.equal(s.current.temp, 25.4);
  assert.equal(s.current.gas, 0.42);
  assert.deepEqual(s.current.levels, { air: 'MEDIUM', temp: 'NORMAL', hum: 'NORMAL', sys: 'NORMAL' });
  c.t += 11_000;
  assert.equal(tm.state().node.online, false);
});

test('node TX and gateway RX of the same heartbeat are one packet; gaps count as lost', () => {
  const c = clock();
  const tm = new Telemetry('', { now: c.now, persist: false });
  tm.ingest([
    { src: 'node', k: 'tx', pc: T0, id: 0xE0000001, kind: 'hb', try: 1, len: 120, frame: hb(1) },
    { src: 'node', k: 'txd', pc: T0 + 400, id: 0xE0000001, kind: 'hb', ok: true, air: 390 },
    { src: 'gw', k: 'rx', pc: T0 + 420, from: 101, rssi: -31, snr: 11, len: 120, res: 'hb', frame: hb(1) },
    // seq 2 and 3 never arrive
    { src: 'gw', k: 'rx', pc: T0 + 15_400, from: 101, rssi: -40, snr: 9, len: 120, res: 'hb', frame: hb(4) },
  ]);
  const s = tm.state();
  const p1 = s.packets.find((p) => p.type === 'HB' && p.ref === 1);
  assert.ok(p1.tx && p1.rx, 'matched');
  assert.equal(p1.tx.airtime, 390);
  assert.equal(p1.rx.rssi, -31);
  assert.equal(s.packets.filter((p) => p.type === 'HB').length, 2);
  assert.equal(s.link.hbReceived, 2);
  assert.equal(s.link.hbLost, 2);
  assert.equal(s.link.lossPct, 50);
  assert.equal(s.link.rssi, -40);
});

test('only the gateway connected: readings come from the heartbeat (air_index / 20 = volts)', () => {
  const c = clock();
  const tm = new Telemetry('', { now: c.now, persist: false });
  tm.ingest([{ src: 'gw', k: 'rx', pc: T0, from: 101, rssi: -30, snr: 10, len: 120, res: 'hb', frame: hb(7) }]);
  const s = tm.state();
  assert.equal(s.current.via, 'lora');
  assert.equal(s.current.temp, 24.6);
  assert.equal(s.current.gas, 0.5);
  assert.equal(tm.history('1h').points.at(-1).hum, 58);
});

test('alert: ACK latency, dedup of node and gateway copies, failure', () => {
  const c = clock();
  const tm = new Telemetry('', { now: c.now, persist: false });
  tm.ingest([
    { src: 'node', k: 'evt', pc: T0, id: 77, type: 'ALERT', cat: 'AIR_QUALITY', sev: 'MEDIUM', prev: 'NORMAL' },
    { src: 'node', k: 'tx', pc: T0 + 10, id: 77, kind: 'event', try: 1, len: 150, frame: alert(77) },
    { src: 'gw', k: 'rx', pc: T0 + 450, from: 101, rssi: -33, snr: 10, len: 150, res: 'event', frame: alert(77) },
    { src: 'gw', k: 'ack', pc: T0 + 500, id: 77, to: 101, frame: '{"type":"ACK","ack_for":77}' },
    { src: 'node', k: 'ack', pc: T0 + 900, id: 77, from: 'GATEWAY_01', rssi: -30, snr: 11 },
    { src: 'node', k: 'tx', pc: T0 + 2000, id: 78, kind: 'event', try: 6, len: 150, frame: alert(78, 'HIGH') },
    { src: 'node', k: 'fail', pc: T0 + 3000, id: 78, tries: 6 },
  ]);
  const s = tm.state();
  assert.equal(s.alerts.length, 1, 'node evt and gateway rx are the same alert');
  const ev = s.packets.find((p) => p.type === 'ALERT' && p.ref === 77);
  assert.equal(ev.latency, 890);
  assert.equal(ev.rx.rssi, -33);
  const ack = s.packets.find((p) => p.type === 'ACK' && p.ref === 77);
  assert.ok(ack.tx && ack.rx, 'gateway ACK seen sent and received');
  assert.equal(s.link.ackLatencyMs, 890);
  const failed = s.packets.find((p) => p.ref === 78);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.retry, true);
});

test('history buckets by range; wrong PC clock replaced by the server clock', () => {
  const c = clock();
  const tm = new Telemetry('', { now: c.now, persist: false });
  for (let i = 0; i < 30; i += 1)
    tm.ingest([{ src: 'node', k: 'env', pc: T0 + i * 2000, temp: 20 + i * 0.1, rh: 50, gas: 0.3 + i * 0.01 }]);
  c.t = T0 + 60_000;
  const h1 = tm.history('1h');
  assert.equal(h1.step, 10_000);
  assert.equal(h1.points.length, 6);
  assert.equal(h1.points[0].tempMin, 20);
  const h24 = tm.history('24h');
  assert.equal(h24.points.length, 1);
  assert.equal(h24.points[0].gasMax, 0.59);
  assert.equal(tm.history('nonsense').range, '24h');

  tm.ingest([{ src: 'node', k: 'env', pc: 0, temp: 99, rh: 1, gas: 0 }]);
  assert.ok(tm.raw.at(-1).t === c.t);
});

test('records are persisted per day and replayed at start-up', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agtlm-'));
  try {
    const c = clock();
    const a = new Telemetry(dir, { now: c.now });
    a.ingest([{ src: 'node', k: 'boot', pc: T0, fw: '1.0.0', boot: 3, gas_med: 0.8, gas_high: 1.4 },
      { src: 'node', k: 'env', pc: T0, temp: 22, rh: 40, gas: 0.2 }]);
    assert.equal(readdirSync(dir).length, 1);
    const b = new Telemetry(dir, { now: c.now });
    assert.equal(b.raw.length, 1);
    assert.equal(b.limits.gasMedium, 0.8);
    assert.equal(b.state().node.online, false, 'not online just because of old records');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('HTTP: ingest needs the device key, reading needs a user code; SSE stream sends status', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agweb-'));
  const store = new Store(join(dir, 'db.json'));
  const userCode = newToken(), devKey = newToken();
  store.addUser('Ana', hashToken(userCode));
  store.addDevice('bridge', hashToken(devKey));
  const telemetry = new Telemetry('', { persist: false });
  const server = createApp(store, { telemetry }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const body = JSON.stringify({ records: [{ src: 'node', k: 'env', temp: 21, rh: 45, gas: 0.3 }] });
    let r = await fetch(`${base}/api/telemetry/ingest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal(r.status, 401);
    r = await fetch(`${base}/api/telemetry/ingest`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-device-key': devKey }, body });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { kept: 1 });

    // a batch above the 4 kB limit of the other routes is accepted
    const big = JSON.stringify({ records: Array.from({ length: 200 }, () => ({ src: 'gw', k: 'stat', lcd: true, lora: true, events: 1, hbs: 2, ov: 'NORMAL' })) });
    r = await fetch(`${base}/api/telemetry/ingest`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-device-key': devKey }, body: big });
    assert.equal(r.status, 200);

    r = await fetch(`${base}/api/telemetry/state`);
    assert.equal(r.status, 401);
    r = await fetch(`${base}/api/telemetry/state`, { headers: { authorization: `Bearer ${userCode}` } });
    assert.equal((await r.json()).current.temp, 21);

    const ctl = new AbortController();
    r = await fetch(`${base}/api/telemetry/stream`, { headers: { authorization: `Bearer ${userCode}` }, signal: ctl.signal });
    assert.match(r.headers.get('content-type'), /^text\/event-stream/);
    const reader = r.body.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /^event: status\n/);
    telemetry.ingest([{ src: 'node', k: 'env', temp: 22, rh: 45, gas: 0.3 }]);
    let text = '';
    while (!text.includes('event: env')) text += new TextDecoder().decode((await reader.read()).value);
    ctl.abort();
  } finally {
    server.closeAllConnections();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
