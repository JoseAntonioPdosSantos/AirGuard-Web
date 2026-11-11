// Telemetry over MQTT: the ESP32 node publishes {now, records} batches on
// airguard/<device>/telemetry (QoS 0); this subscriber hands them to
// Telemetry.ingest, exactly like the HTTP route did.
//
// Broker access is the authentication: only logins of the broker can publish.
import mqtt from 'mqtt';

export const TOPIC = 'airguard/+/telemetry';
const TOPIC_RE = /^airguard\/([A-Za-z0-9_-]{1,32})\/telemetry$/;
const MAX_PAYLOAD = 1 << 20;
const MAX_RECORDS = 5000;

// Pure: one MQTT message -> { device, kept } or { error }.
export function handleMessage(telemetry, topic, payload) {
  const m = TOPIC_RE.exec(topic);
  if (!m) return { error: 'topic' };
  if (payload.length > MAX_PAYLOAD) return { error: 'too_large' };
  let body;
  try { body = JSON.parse(payload.toString('utf8')); } catch { return { error: 'json' }; }
  const records = body?.records;
  if (!Array.isArray(records) || records.length > MAX_RECORDS) return { error: 'records' };
  return { device: m[1], kept: telemetry.ingest(records, body.now) };
}

// Connects and keeps reconnecting (mqtt.js does it every reconnectPeriod).
// Connection state goes to telemetry.mqtt (shown in /api/telemetry/state).
export function startMqtt(telemetry, { url, username, password, log = () => {} }) {
  telemetry.mqtt = { enabled: true, connected: false, url, lastMessage: null, error: null };
  const client = mqtt.connect(url, {
    username: username || undefined,
    password: password || undefined,
    clientId: `airguard-web-${process.pid}`,
    reconnectPeriod: 5000,
    connectTimeout: 10_000,
    keepalive: 30,
  });
  client.on('connect', () => {
    telemetry.mqtt.connected = true;
    telemetry.mqtt.error = null;
    log(`MQTT connected to ${url}, subscribing ${TOPIC}`);
    client.subscribe(TOPIC, { qos: 0 }, (err) => { if (err) log(`MQTT subscribe failed: ${err.message}`); });
  });
  client.on('close', () => {
    if (telemetry.mqtt.connected) log('MQTT connection closed');
    telemetry.mqtt.connected = false;
  });
  client.on('error', (err) => {
    if (telemetry.mqtt.error !== err.message) log(`MQTT error: ${err.message}`);
    telemetry.mqtt.error = err.message;
  });
  client.on('message', (topic, payload) => {
    const r = handleMessage(telemetry, topic, payload);
    if (r.error) log(`MQTT ${topic}: ignored (${r.error})`);
    else telemetry.mqtt.lastMessage = Date.now();
  });
  return client;
}
