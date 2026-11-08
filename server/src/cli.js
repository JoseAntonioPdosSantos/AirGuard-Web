// Administration on the laptop (codes are shown ONCE and never stored):
//   npm run user:add -- "Maria"      new user + access link
//   npm run user:list                users (no codes)
//   npm run user:revoke -- <id>      disable a user's link
//   npm run device:add -- "ESP32"    key for the ESP32 (X-Device-Key)
// The running server picks up changes by itself (no restart needed).
import { config } from './config.js';
import { Store } from './store.js';
import { newToken, hashToken } from './tokens.js';
import { cleanName } from './phone.js';

const [cmd, ...args] = process.argv.slice(2);
const store = new Store(config.dataFile);

switch (cmd) {
  case 'user:add': {
    const name = cleanName(args.join(' '));
    if (!name) { console.error('usage: npm run user:add -- "Name"'); process.exit(1); }
    const token = newToken();
    const u = store.addUser(name, hashToken(token));
    console.log(`User "${u.name}" created (id ${u.id.slice(0, 8)}).`);
    console.log('Access link (shown only now; send it only to this person):');
    console.log(`  ${config.publicBase}/#k=${token}`);
    break;
  }
  case 'user:list':
    for (const u of store.data.users)
      console.log(`${u.id.slice(0, 8)}  ${u.revoked ? 'REVOKED' : 'active '}  ${u.name}  (${store.contactsOf(u.id).length} contacts)`);
    break;
  case 'user:revoke': {
    const u = args[0] && store.revokeUser(args[0]);
    console.log(u ? `User "${u.name}" revoked.` : 'usage: npm run user:revoke -- <id>');
    break;
  }
  case 'device:add': {
    const name = cleanName(args.join(' ') || 'ESP32');
    const token = newToken();
    store.addDevice(name, hashToken(token));
    console.log(`Device "${name}" created. Key (shown only now), header X-Device-Key:`);
    console.log(`  ${token}`);
    break;
  }
  default:
    console.error('commands: user:add, user:list, user:revoke, device:add');
    process.exit(1);
}
