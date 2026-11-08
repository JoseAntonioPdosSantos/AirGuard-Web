// Access codes: 32 random bytes (256 bits) from the OS CSPRNG, base64url.
// Only the SHA-256 of a code is stored, so a copy of the data file does not
// reveal any working code. 256 bits cannot be guessed or brute-forced.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const TOKEN_BYTES = 32;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/; // base64url of 32 bytes, no padding

export function newToken() {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function hashToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function looksLikeToken(token) {
  return typeof token === 'string' && TOKEN_RE.test(token);
}

// Constant-time comparison of two hex digests of equal length.
export function sameHash(a, b) {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}
