// HTTP API + static app. Used by server.js (real port) and by the tests.
//
// User API (Authorization: Bearer <user access code>):
//   GET    /api/me                 -> { name, hasPassword }
//   POST   /api/password {password, current?}  set (first time) or change the edit password
//   POST   /api/password/check (X-Edit-Password) -> 204 / 403 wrong_password / 428 password_not_set
//   GET    /api/contacts           -> [{ id, name, phone, phoneDisplay, category, createdAt }]
//   POST   /api/contacts {name, phone, category?}        \
//   PUT    /api/contacts/:id {name, phone, category?}     > need X-Edit-Password
//   DELETE /api/contacts/:id                             /  (428 password_not_set, 403 wrong_password)
//   GET    /api/telemetry/state    -> current readings, boards online, last radio packets
//   GET    /api/telemetry/history?range=1h|6h|24h|7d|30d -> bucketed series + alerts
//   GET    /api/telemetry/stream   -> text/event-stream (env, packet, alert, gw, boot, status)
// Device API (X-Device-Key: <device key>):
//   GET    /api/device/contacts    -> { contacts: [{ name, phone, category }] }  (every user's list)
//   POST   /api/telemetry/ingest {now, records: [...]} -> { kept }   (simulator; the ESP32 uses MQTT)
import express from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { hashToken, looksLikeToken, sameHash } from './tokens.js';
import { normalizePhone, formatPhone, cleanName } from './phone.js';
import { cleanCategory, DEFAULT_CATEGORY } from './categories.js';
import { checkPassword, hashPassword, validPassword } from './passwords.js';

export const MAX_CONTACTS_PER_USER = 100;

// Failed-authentication limiter per client IP (codes are unguessable; this
// only keeps scanners from hammering the server and filling the logs).
export class FailLimiter {
  constructor({ max = 10, windowMs = 60_000, now = () => Date.now() } = {}) {
    this.max = max; this.windowMs = windowMs; this.now = now; this.hits = new Map();
  }
  blocked(ip) {
    const h = this.hits.get(ip);
    return !!h && this.now() - h.start < this.windowMs && h.count >= this.max;
  }
  fail(ip) {
    const t = this.now();
    const h = this.hits.get(ip);
    if (!h || t - h.start >= this.windowMs) this.hits.set(ip, { start: t, count: 1 });
    else h.count += 1;
  }
}

function findByToken(list, token) {
  if (!looksLikeToken(token)) return null;
  const h = hashToken(token);
  let found = null;
  for (const item of list) if (sameHash(item.tokenHash, h)) found = item;  // no early exit
  return found;
}

export const STATUS_PERIOD_MS = 3000;

export function createApp(store, { staticDir, telemetry = null, limiter = new FailLimiter(), log = () => {} } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);

  app.use((req, res, next) => {
    res.set({
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; " +
        "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    });
    next();
  });
  const smallJson = express.json({ limit: '4kb' });
  const ingestJson = express.json({ limit: '1mb' });  // a batch of telemetry lines
  app.use('/api', (req, res, next) => (req.path === '/telemetry/ingest' ? ingestJson : smallJson)(req, res, next));
  app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  const authUser = (req, res, next) => {
    const ip = req.socket.remoteAddress || '?';
    if (limiter.blocked(ip)) return res.status(429).json({ error: 'too_many_attempts' });
    const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
    const user = m && findByToken(store.activeUsers(), m[1]);
    if (!user) {
      limiter.fail(ip);
      log(`auth failed from ${ip}`);
      return res.status(401).json({ error: 'invalid_code' });
    }
    req.user = user;
    next();
  };

  const view = (c) => ({ id: c.id, name: c.name, phone: c.phone, phoneDisplay: formatPhone(c.phone),
    category: c.category || DEFAULT_CATEGORY, createdAt: c.createdAt });

  app.get('/api/me', authUser, (req, res) => res.json({ name: req.user.name, hasPassword: !!req.user.passwordHash }));

  // Edit password: required to add, edit or delete. Wrong guesses count in the
  // same per-IP limiter as wrong access codes.
  const needPassword = (req, res, next) => {
    const ip = req.socket.remoteAddress || '?';
    if (!req.user.passwordHash) return res.status(428).json({ error: 'password_not_set' });
    if (limiter.blocked(ip)) return res.status(429).json({ error: 'too_many_attempts' });
    if (!checkPassword(req.get('x-edit-password') || '', req.user.passwordHash)) {
      limiter.fail(ip);
      log(`wrong edit password for ${req.user.name} from ${ip}`);
      return res.status(403).json({ error: 'wrong_password' });
    }
    next();
  };

  app.post('/api/password/check', authUser, needPassword, (req, res) => res.status(204).end());

  app.post('/api/password', authUser, (req, res) => {
    const ip = req.socket.remoteAddress || '?';
    const { password, current } = req.body || {};
    const had = !!req.user.passwordHash;
    if (had) {
      if (limiter.blocked(ip)) return res.status(429).json({ error: 'too_many_attempts' });
      if (!checkPassword(current || '', req.user.passwordHash)) {
        limiter.fail(ip);
        return res.status(403).json({ error: 'wrong_password' });
      }
    }
    if (!validPassword(password)) return res.status(400).json({ error: 'invalid_password' });
    store.setPassword(req.user.id, hashPassword(password));
    log(`edit password ${had ? 'changed' : 'set'} by ${req.user.name}`);
    res.status(204).end();
  });

  app.get('/api/contacts', authUser, (req, res) => {
    const list = store.contactsOf(req.user.id).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    res.json(list.map(view));
  });

  const contactFields = (req, res) => {
    const name = cleanName(req.body?.name);
    const phone = normalizePhone(req.body?.phone);
    const category = cleanCategory(req.body?.category);
    if (!name) { res.status(400).json({ error: 'invalid_name' }); return null; }
    if (!phone) { res.status(400).json({ error: 'invalid_phone' }); return null; }
    if (!category) { res.status(400).json({ error: 'invalid_category' }); return null; }
    return { name, phone, category };
  };

  app.post('/api/contacts', authUser, needPassword, (req, res) => {
    const f = contactFields(req, res);
    if (!f) return;
    const { name, phone, category } = f;
    const mine = store.contactsOf(req.user.id);
    if (mine.length >= MAX_CONTACTS_PER_USER) return res.status(409).json({ error: 'limit_reached' });
    if (mine.some((c) => c.phone === phone)) return res.status(409).json({ error: 'duplicate_phone' });
    const c = store.addContact(req.user.id, name, phone, category);
    log(`contact added by ${req.user.name}`);
    res.status(201).json(view(c));
  });

  app.put('/api/contacts/:id', authUser, needPassword, (req, res) => {
    const f = contactFields(req, res);
    if (!f) return;
    const mine = store.contactsOf(req.user.id);
    if (!mine.some((c) => c.id === req.params.id)) return res.status(404).json({ error: 'not_found' });
    if (mine.some((c) => c.phone === f.phone && c.id !== req.params.id)) return res.status(409).json({ error: 'duplicate_phone' });
    const c = store.updateContact(req.user.id, req.params.id, f);
    log(`contact edited by ${req.user.name}`);
    res.json(view(c));
  });

  app.delete('/api/contacts/:id', authUser, needPassword, (req, res) => {
    if (!store.deleteContact(req.user.id, req.params.id)) return res.status(404).json({ error: 'not_found' });
    res.status(204).end();
  });

  const authDevice = (req, res, next) => {
    const ip = req.socket.remoteAddress || '?';
    if (limiter.blocked(ip)) return res.status(429).json({ error: 'too_many_attempts' });
    const dev = findByToken(store.activeDevices(), req.get('x-device-key') || '');
    if (!dev) { limiter.fail(ip); return res.status(401).json({ error: 'invalid_key' }); }
    req.device = dev;
    next();
  };

  // ---- telemetry (ambiente + LoRa) -----------------------------------------
  if (telemetry) {
    app.post('/api/telemetry/ingest', authDevice, (req, res) => {
      const records = req.body?.records;
      if (!Array.isArray(records) || records.length > 5000) return res.status(400).json({ error: 'invalid_records' });
      res.json({ kept: telemetry.ingest(records, req.body?.now) });
    });

    app.get('/api/telemetry/state', authUser, (req, res) => res.json(telemetry.state()));

    app.get('/api/telemetry/history', authUser, (req, res) => res.json(telemetry.history(String(req.query.range || '24h'))));

    app.get('/api/telemetry/stream', authUser, (req, res) => {
      res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      const status = () => {
        const { packets, alerts, ...s } = telemetry.state();  // eslint-disable-line no-unused-vars
        send('status', s);
      };
      status();
      const unsubscribe = telemetry.subscribe(send);
      const timer = setInterval(status, STATUS_PERIOD_MS);
      req.on('close', () => { clearInterval(timer); unsubscribe(); });
    });
  }

  app.get('/api/device/contacts', authDevice, (req, res) => {
    // Compact, one entry per distinct number (several users may list the same one).
    const seen = new Set();
    const contacts = [];
    for (const c of store.allContacts()) {
      if (seen.has(c.phone)) continue;
      seen.add(c.phone);
      contacts.push({ name: c.name, phone: c.phone, category: c.category || DEFAULT_CATEGORY });
    }
    res.json({ contacts });
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));

  if (staticDir && existsSync(staticDir)) {
    // index.html always revalidates so a new build reaches phones at once;
    // hashed assets (/assets/*) can be cached.
    const noCacheHtml = (res, path) => { if (path.endsWith('.html') || path.endsWith('.webmanifest')) res.set('Cache-Control', 'no-cache'); };
    app.use(express.static(staticDir, { index: 'index.html', maxAge: '1h', setHeaders: noCacheHtml }));
    app.get('*', (req, res) => res.set('Cache-Control', 'no-cache').sendFile(join(staticDir, 'index.html')));
  }
  return app;
}
