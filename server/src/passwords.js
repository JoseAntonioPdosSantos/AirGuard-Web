// Edit password of a user (asked before adding, editing or deleting a contact).
// Stored as scrypt(password, 16-byte random salt): "scrypt$<salt hex>$<hash hex>".
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const PASSWORD_MIN = 4;
export const PASSWORD_MAX = 64;
const KEYLEN = 32;

export function validPassword(p) {
  return typeof p === 'string' && [...p].length >= PASSWORD_MIN && [...p].length <= PASSWORD_MAX;
}

export function hashPassword(p) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(p.normalize('NFC'), salt, KEYLEN).toString('hex')}`;
}

export function checkPassword(p, stored) {
  if (typeof p !== 'string' || typeof stored !== 'string' || p.length > PASSWORD_MAX * 4) return false;
  const [kind, salt, hash] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const got = scryptSync(p.normalize('NFC'), Buffer.from(salt, 'hex'), KEYLEN);
  const want = Buffer.from(hash, 'hex');
  return got.length === want.length && timingSafeEqual(got, want);
}
