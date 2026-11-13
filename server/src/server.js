import { createApp } from './app.js';
import { config } from './config.js';
import { Store } from './store.js';
import { Telemetry } from './telemetry.js';
import { startMqtt } from './mqtt_ingest.js';
import mqtt from 'mqtt';
import { WhatsApp } from './whatsapp.js';
import { startWaBridge } from './wa_bridge.js';

const store = new Store(config.dataFile);
const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);
const telemetry = new Telemetry(config.telemetryDir);
setInterval(() => telemetry.prune(), 6 * 3_600_000).unref();
if (config.mqttUrl) {
  startMqtt(telemetry, { url: config.mqttUrl, username: config.mqttUsername, password: config.mqttPassword, log });
}
// WhatsApp: messages received go to the node's displays, the node's alerts go
// to the user's WhatsApp. Everything between this server and the node is MQTT.
let whatsapp = null;
if (config.whatsapp && config.mqttUrl) {
  const wa = new WhatsApp({ dir: config.whatsappDir, groups: config.whatsappGroups, log });
  whatsapp = startWaBridge(mqtt, {
    wa, dir: config.whatsappDir, url: config.mqttUrl, username: config.mqttUsername, password: config.mqttPassword,
    contacts: () => store.allContacts(), log,
  });
  wa.start().catch((e) => log(`whatsapp: start failed: ${e.message}`));
  const bye = () => { whatsapp.stop().finally(() => process.exit(0)); };
  process.once('SIGTERM', bye);
  process.once('SIGINT', bye);
}
const app = createApp(store, { staticDir: config.staticDir, telemetry, whatsapp, log });

app.listen(config.port, config.host, () => {
  log(`AirGuard Web on http://${config.host}:${config.port} (links: ${config.publicBase})`);
  log(`${store.activeUsers().length} user(s), ${store.activeDevices().length} device(s)`);
});
