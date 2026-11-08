// Small JSON store (data/db.json). Writes are atomic: write a temp file,
// fsync, rename. The file holds users (name + token hash), devices (token
// hash) and contacts (owned by one user). It never holds a plain access code.
import { mkdirSync, openSync, writeSync, fsyncSync, closeSync, renameSync, readFileSync, existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const EMPTY = { version: 1, users: [], devices: [], contacts: [] };

export class Store {
  constructor(file) {
    this.file = file;
    this.data = structuredClone(EMPTY);
    this.mtime = 0;
    this.refresh();
  }

  // Reload if the file changed on disk (the admin CLI writes it while the
  // server runs): no restart needed, and the server never overwrites it.
  refresh() {
    if (!existsSync(this.file)) return;
    const m = statSync(this.file).mtimeMs;
    if (m === this.mtime) return;
    this.data = { ...EMPTY, ...JSON.parse(readFileSync(this.file, 'utf8')) };
    this.mtime = m;
  }

  save() {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    const fd = openSync(tmp, 'w', 0o600);
    writeSync(fd, JSON.stringify(this.data, null, 2));
    fsyncSync(fd);
    closeSync(fd);
    renameSync(tmp, this.file);
    this.mtime = statSync(this.file).mtimeMs;
  }

  // ---- users / devices ----------------------------------------------------
  addUser(name, tokenHash) {
    this.refresh();
    const u = { id: randomUUID(), name, tokenHash, createdAt: new Date().toISOString(), revoked: false };
    this.data.users.push(u);
    this.save();
    return u;
  }
  addDevice(name, tokenHash) {
    this.refresh();
    const d = { id: randomUUID(), name, tokenHash, createdAt: new Date().toISOString(), revoked: false };
    this.data.devices.push(d);
    this.save();
    return d;
  }
  revokeUser(id) {
    this.refresh();
    const u = this.data.users.find((x) => x.id === id || x.id.startsWith(id));
    if (!u) return null;
    u.revoked = true;
    this.save();
    return u;
  }
  activeUsers() { this.refresh(); return this.data.users.filter((u) => !u.revoked); }
  activeDevices() { this.refresh(); return this.data.devices.filter((d) => !d.revoked); }

  // ---- contacts -----------------------------------------------------------
  contactsOf(userId) {
    this.refresh();
    return this.data.contacts.filter((c) => c.ownerId === userId);
  }
  addContact(userId, name, phone) {
    this.refresh();
    const c = { id: randomUUID(), ownerId: userId, name, phone, createdAt: new Date().toISOString() };
    this.data.contacts.push(c);
    this.save();
    return c;
  }
  deleteContact(userId, id) {
    this.refresh();
    const i = this.data.contacts.findIndex((c) => c.id === id && c.ownerId === userId);
    if (i < 0) return false;
    this.data.contacts.splice(i, 1);
    this.save();
    return true;
  }
  allContacts() {
    const active = new Set(this.activeUsers().map((u) => u.id));
    return this.data.contacts.filter((c) => active.has(c.ownerId));
  }
}
