/**
 * Password hashing with Node's built-in scrypt — no dependencies.
 * Used for registered jam accounts the host creates in the admin console.
 */

import { promisify } from 'node:util';
import { randomBytes, scrypt as scryptCb, scryptSync, timingSafeEqual } from 'node:crypto';

const KEYLEN = 32;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const scryptAsync = promisify(scryptCb);

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(password), salt, KEYLEN, SCRYPT).toString('hex');
  return { salt, hash };
}

export async function hashPasswordAsync(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = (await scryptAsync(String(password), salt, KEYLEN, SCRYPT)).toString('hex');
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

/** Non-blocking verify for request handlers — keeps the event loop free under load. */
export async function verifyPasswordAsync(password, salt, hash) {
  if (!password || !salt || !hash) return false;
  try {
    const got = await scryptAsync(String(password), String(salt), KEYLEN, SCRYPT);
    const want = Buffer.from(String(hash), 'hex');
    if (want.length !== got.length) return false;
    return timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

/**
 * Fixed dummy credential so unknown/disabled usernames still pay the scrypt
 * cost — avoids timing that reveals which accounts exist.
 */
export const DUMMY_CREDENTIAL = hashPassword('amplify-timing-equalizer');

/** Public shape of a user — never includes salt or hash. */
export function publicUser(user) {
  if (!user) return null;
  const { passwordHash, passwordSalt, ...safe } = user;
  return safe;
}
