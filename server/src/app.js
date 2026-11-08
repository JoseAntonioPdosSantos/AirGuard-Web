// HTTP API + static app. Used by server.js (real port) and by the tests.
//
// User API (Authorization: Bearer <user access code>):
//   GET    /api/me                 -> { name }
//   GET    /api/contacts           -> [{ id, name, phone, phoneDisplay, createdAt }]
//   POST   /api/contacts {name, phone}
//   DELETE /api/contacts/:id
// Device API for the ESP32 (X-Device-Key: <device key>):
//   GET    /api/device/contacts    -> { contacts: [{ name, phone }] }  (every user's list)
import express from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { hashToken, looksLikeToken, sameHash } from './tokens.js';
import { normalizePhone, formatPhone, cleanName } from './phone.js';

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

export function createApp(store, { staticDir, limiter = new FailLimiter(), log = () => {} } = {}) {
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
  app.use('/api', express.json({ limit: '4kb' }));
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

  const view = (c) => ({ id: c.id, name: c.name, phone: c.phone, phoneDisplay: formatPhone(c.phone), createdAt: c.createdAt });

  app.get('/api/me', authUser, (req, res) => res.json({ name: req.user.name }));

  app.get('/api/contacts', authUser, (req, res) => {
    const list = store.contactsOf(req.user.id).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    res.json(list.map(view));
  });

  app.post('/api/contacts', authUser, (req, res) => {
    const name = cleanName(req.body?.name);
    const phone = normalizePhone(req.body?.phone);
    if (!name) return res.status(400).json({ error: 'invalid_name' });
    if (!phone) return res.status(400).json({ error: 'invalid_phone' });
    const mine = store.contactsOf(req.user.id);
    if (mine.length >= MAX_CONTACTS_PER_USER) return res.status(409).json({ error: 'limit_reached' });
    if (mine.some((c) => c.phone === phone)) return res.status(409).json({ error: 'duplicate_phone' });
    const c = store.addContact(req.user.id, name, phone);
    log(`contact added by ${req.user.name}`);
    res.status(201).json(view(c));
  });

  app.delete('/api/contacts/:id', authUser, (req, res) => {
    if (!store.deleteContact(req.user.id, req.params.id)) return res.status(404).json({ error: 'not_found' });
    res.status(204).end();
  });

  app.get('/api/device/contacts', (req, res) => {
    const ip = req.socket.remoteAddress || '?';
    if (limiter.blocked(ip)) return res.status(429).json({ error: 'too_many_attempts' });
    const dev = findByToken(store.activeDevices(), req.get('x-device-key') || '');
    if (!dev) { limiter.fail(ip); return res.status(401).json({ error: 'invalid_key' }); }
    // Compact, one entry per distinct number (several users may list the same one).
    const seen = new Set();
    const contacts = [];
    for (const c of store.allContacts()) {
      if (seen.has(c.phone)) continue;
      seen.add(c.phone);
      contacts.push({ name: c.name, phone: c.phone });
    }
    res.json({ contacts });
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));

  if (staticDir && existsSync(staticDir)) {
    app.use(express.static(staticDir, { index: 'index.html', maxAge: '1h' }));
    app.get('*', (req, res) => res.sendFile(join(staticDir, 'index.html')));
  }
  return app;
}
