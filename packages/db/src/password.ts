/**
 * Password hashing for the seeded admin and, later, for login (§4 FR-6).
 *
 * **Why scrypt and not argon2.** BUILD-PLAN 3.1 names argon2, which is the
 * better choice and remains the plan. What this task needs is a *stored
 * format*, and picking one now that cannot accept argon2 later would mean
 * re-hashing every password in a migration. So the hash is a PHC string —
 * `$scrypt$n=...,r=...,p=...$salt$hash` — with the algorithm named inside it,
 * and `verifyPassword()` dispatches on that name. Task 3.1 adds an
 * `$argon2id$` branch, hashes new passwords with it, and re-hashes an old one
 * on the next successful login; nothing already stored has to move.
 *
 * scrypt in the meantime is Node's own, needs no native module on a Windows
 * Server box, and is memory-hard. `n = 16384, r = 8, p = 1` is the widely
 * cited interactive-login parameter set and costs 16 MB per hash, which is
 * inside Node's default 32 MB `maxmem`.
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/** Cost parameters for new scrypt hashes. Old hashes carry their own. */
const SCRYPT = { n: 16384, r: 8, p: 1, keyLength: 32, saltBytes: 16 } as const;

/** Algorithms `verifyPassword()` understands. Task 3.1 adds `argon2id`. */
export type PasswordAlgorithm = 'scrypt';

/** Hash a password into a PHC string safe to store in `users.password_hash`. */
export function hashPassword(password: string): string {
  const salt = randomBytes(SCRYPT.saltBytes);
  const key = scryptSync(password.normalize('NFKC'), salt, SCRYPT.keyLength, {
    N: SCRYPT.n,
    r: SCRYPT.r,
    p: SCRYPT.p,
  });
  const params = `n=${SCRYPT.n},r=${SCRYPT.r},p=${SCRYPT.p}`;
  return `$scrypt$${params}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/**
 * Check a password against a stored hash. Returns false — never throws — for a
 * wrong password, an unreadable hash, or an algorithm this build does not
 * know, so a corrupt row cannot turn into a 500 on the login route.
 */
export function verifyPassword(storedHash: string, password: string): boolean {
  const parsed = parse(storedHash);
  if (parsed === null) return false;

  const key = scryptSync(password.normalize('NFKC'), parsed.salt, parsed.hash.length, {
    N: parsed.n,
    r: parsed.r,
    p: parsed.p,
  });
  return key.length === parsed.hash.length && timingSafeEqual(key, parsed.hash);
}

/** True when a stored hash was made with something other than this build's
 *  current algorithm and parameters, so login should re-hash it. */
export function needsRehash(storedHash: string): boolean {
  const parsed = parse(storedHash);
  if (parsed === null) return true;
  return parsed.n !== SCRYPT.n || parsed.r !== SCRYPT.r || parsed.p !== SCRYPT.p;
}

interface ParsedHash {
  n: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

function parse(storedHash: string): ParsedHash | null {
  const parts = storedHash.split('$');
  // '', algorithm, params, salt, hash
  if (parts.length !== 5 || parts[0] !== '' || parts[1] !== 'scrypt') return null;

  const params = new Map<string, number>();
  for (const pair of (parts[2] ?? '').split(',')) {
    const [name, value] = pair.split('=');
    const parsedValue = Number(value);
    if (name === undefined || !Number.isFinite(parsedValue)) return null;
    params.set(name, parsedValue);
  }

  const n = params.get('n');
  const r = params.get('r');
  const p = params.get('p');
  if (n === undefined || r === undefined || p === undefined) return null;

  try {
    const salt = Buffer.from(parts[3] ?? '', 'base64');
    const hash = Buffer.from(parts[4] ?? '', 'base64');
    if (salt.length === 0 || hash.length === 0) return null;
    return { n, r, p, salt, hash };
  } catch {
    return null;
  }
}

/** A readable bootstrap password, used when the seed is run without
 *  `SHOPQUOTE_ADMIN_PASSWORD`. Printed once, then changed at first login. */
export function generatePassword(length = 20): string {
  // No look-alikes: someone reads this off a terminal and types it.
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[(bytes[i] ?? 0) % alphabet.length];
  }
  return out;
}
