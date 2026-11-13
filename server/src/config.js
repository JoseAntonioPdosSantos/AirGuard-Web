import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const config = {
  host: process.env.HOST || '0.0.0.0',
  port: Number(process.env.PORT || 8787),
  // Address printed in the access links (the laptop's fixed LAN IP).
  publicBase: process.env.PUBLIC_BASE || 'http://192.168.1.10:8787',
  dataFile: process.env.DATA_FILE || join(root, 'data', 'db.json'),
  telemetryDir: process.env.TELEMETRY_DIR || join(root, 'data', 'telemetry'),
  staticDir: join(root, 'web', 'dist'),
  // MQTT broker the ESP32 publishes telemetry to ("" = do not subscribe).
  mqttUrl: process.env.MQTT_URL ?? 'mqtt://127.0.0.1:1883',
  mqttUsername: process.env.MQTT_USERNAME || '',
  mqttPassword: process.env.MQTT_PASSWORD || '',
  // WhatsApp link (needs the MQTT broker: it reaches the node only through it).
  // WHATSAPP=0 turns it off; WHATSAPP_GROUPS=1 also takes messages from groups.
  whatsapp: process.env.WHATSAPP !== '0',
  whatsappGroups: process.env.WHATSAPP_GROUPS === '1',
  whatsappDir: process.env.WHATSAPP_DIR || join(root, 'data', 'whatsapp'),
};
