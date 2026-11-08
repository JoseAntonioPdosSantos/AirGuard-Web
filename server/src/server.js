import { createApp } from './app.js';
import { config } from './config.js';
import { Store } from './store.js';

const store = new Store(config.dataFile);
const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);
const app = createApp(store, { staticDir: config.staticDir, log });

app.listen(config.port, config.host, () => {
  log(`AirGuard Web on http://${config.host}:${config.port} (links: ${config.publicBase})`);
  log(`${store.activeUsers().length} user(s), ${store.activeDevices().length} device(s)`);
});
