import { createApp } from './app.js';
import { config } from './config.js';
import { Store } from './store.js';
import { Telemetry } from './telemetry.js';

const store = new Store(config.dataFile);
const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);
const telemetry = new Telemetry(config.telemetryDir);
setInterval(() => telemetry.prune(), 6 * 3_600_000).unref();
const app = createApp(store, { staticDir: config.staticDir, telemetry, log });

app.listen(config.port, config.host, () => {
  log(`AirGuard Web on http://${config.host}:${config.port} (links: ${config.publicBase})`);
  log(`${store.activeUsers().length} user(s), ${store.activeDevices().length} device(s)`);
});
