/**
 * Password hashing with Node's built-in scrypt — no dependencies.
 * Used for registered jam accounts the host creates in the admin console.
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const KEYLEN = 32;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(password), salt, KEYLEN, SCRYPT).toString('hex');
  return { salt, hash };
}

export function verifyPassword(password, salt, hash) {
  if (!password || !salt || !hash) return false;
  try {
    const got = scryptSync(String(password), String(salt), KEYLEN, SCRYPT);
    const want = Buffer.from(String(hash), 'hex');
    if (want.length !== got.length) return false;
    return timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

/** Public shape of a user — never includes salt or hash. */
export function publicUser(user) {
  if (!user) return null;
  const { passwordHash, passwordSalt, ...safe } = user;
  return safe;
}
