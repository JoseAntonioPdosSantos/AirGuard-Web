import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleMessage } from '../src/mqtt_ingest.js';
import { Telemetry } from '../src/telemetry.js';

const T0 = 1_800_000_000_000;
const mk = () => new Telemetry('/nonexistent', { persist: false, now: () => T0 });
const msg = (o) => Buffer.from(JSON.stringify(o));

test('a batch on airguard/<device>/telemetry is ingested with now/ms timing', () => {
  const t = mk();
  const r = handleMessage(t, 'airguard/KITCHEN_01/telemetry', msg({
    now: 10_000,
    records: [{ src: 'node', k: 'env', ms: 8_000, temp: 24.5, hum: 60, gas: 0.2 }],
  }));
  assert.deepEqual(r, { device: 'KITCHEN_01', kept: 1 });
  assert.equal(t.raw.at(-1).t, T0 - 2_000);
  assert.equal(t.raw.at(-1).temp, 24.5);
});

test('other topics, bad JSON and missing records are ignored', () => {
  const t = mk();
  assert.equal(handleMessage(t, 'esp32/unit01/data', msg({ records: [] })).error, 'topic');
  assert.equal(handleMessage(t, 'airguard/a/b/telemetry', msg({ records: [] })).error, 'topic');
  assert.equal(handleMessage(t, 'airguard/KITCHEN_01/telemetry', Buffer.from('{oops')).error, 'json');
  assert.equal(handleMessage(t, 'airguard/KITCHEN_01/telemetry', msg({ now: 1 })).error, 'records');
  assert.equal(t.raw.length, 0);
});
