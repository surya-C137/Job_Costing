/**
 * Password hashing (§4 FR-6, §7 security).
 *
 * **The stored value names its own algorithm.** It is a PHC string —
 * `$argon2id$v=19$m=65536,t=3,p=4$salt$hash`, or `$scrypt$n=…,r=…,p=…$salt$hash`
 * for a row written before Task 3.1 — and `verifyPassword()` dispatches on the
 * name inside it. That is what let argon2id arrive without a migration: new
 * passwords are argon2id, an old scrypt row still verifies, and the login route
 * re-hashes it on its owner's next successful sign-in because `needsRehash()`
 * says so. Nothing stored moves in bulk, and nothing ever handles a plaintext
 * it did not just receive.
 *
 * **argon2id at RFC 9106's second recommended parameter set** — 64 MiB, three
 * passes, four lanes. RFC 9106 offers it for when the first choice (2 GiB) is
 * too heavy, which it is for a shop server. It costs tens of milliseconds a
 * login, and five accounts behind a login throttle is the right side of that
 * trade. Raising it later needs no migration either: change `ARGON2`, and
 * `needsRehash()` upgrades every older row one login at a time.
 *
 * The `argon2` package rather than Node's own `crypto.argon2()`: the built-in
 * arrived in Node 24.7 as experimental, and `engines` still admits Node 22. The
 * package is N-API with prebuilt binaries inside its own tarball — nothing to
 * compile on a Windows Server box, and no per-platform optional dependency for
 * a lockfile written on Windows to drop before the Docker build.
 *
 * Everything is async. Hashing 64 MiB is work for the thread pool, not for the
 * event loop serving the estimator's next autosave.
 */

import argon2 from 'argon2';
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/** Cost parameters for new hashes (RFC 9106 §4, second recommended option).
 *  Stored hashes carry their own, which is how `needsRehash()` spots old ones. */
const ARGON2 = { memoryCost: 65_536, timeCost: 3, parallelism: 4 } as const;

/** Algorithms `verifyPassword()` understands. Only the first is ever written. */
export type PasswordAlgorithm = 'argon2id' | 'scrypt';

/** Hash a password into a PHC string for `users.password_hash`. */
export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password.normalize('NFKC'), { type: argon2.argon2id, ...ARGON2 });
}

/**
 * Check a password against a stored hash. Resolves false — never rejects — for
 * a wrong password, an unreadable hash, or an algorithm this build does not
 * know, so a corrupt row cannot turn into a 500 on the login route.
 */
export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  const candidate = password.normalize('NFKC');
  switch (algorithmOf(storedHash)) {
    case 'argon2id':
      try {
        return await argon2.verify(storedHash, candidate);
      } catch {
        return false;
      }
    case 'scrypt':
      return verifyScrypt(storedHash, candidate);
    default:
      return false;
  }
}

/** The algorithm a stored hash names, or null for anything unrecognised. */
export function algorithmOf(storedHash: string): PasswordAlgorithm | null {
  const name = storedHash.split('$')[1];
  return name === 'argon2id' || name === 'scrypt' ? name : null;
}

/** True when a stored hash was made with anything other than this build's
 *  algorithm and parameters, so a successful login should re-hash it. */
export function needsRehash(storedHash: string): boolean {
  if (algorithmOf(storedHash) !== 'argon2id') return true;
  try {
    return argon2.needsRehash(storedHash, ARGON2);
  } catch {
    return true;
  }
}

/* -------------------------------------------------------------------------
   scrypt — verified, never written.

   Task 2.1 stored the seeded admin as `$scrypt$n=16384,r=8,p=1$salt$hash`
   while argon2 waited for this task. Those rows keep working until their
   owner next signs in, and then they are argon2id.
   ------------------------------------------------------------------------- */

async function verifyScrypt(storedHash: string, password: string): Promise<boolean> {
  const parsed = parseScrypt(storedHash);
  if (parsed === null) return false;
  try {
    const key = await scryptAsync(password, parsed.salt, parsed.hash.length, {
      N: parsed.n,
      r: parsed.r,
      p: parsed.p,
    });
    return key.length === parsed.hash.length && timingSafeEqual(key, parsed.hash);
  } catch {
    // Parameters no sane row carries (a corrupt N): refuse, do not 500.
    return false;
  }
}

function scryptAsync(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (error, key) =>
      error === null ? resolve(key) : reject(error),
    );
  });
}

interface ParsedScrypt {
  n: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

function parseScrypt(storedHash: string): ParsedScrypt | null {
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

  const salt = Buffer.from(parts[3] ?? '', 'base64');
  const hash = Buffer.from(parts[4] ?? '', 'base64');
  if (salt.length === 0 || hash.length === 0) return null;
  return { n, r, p, salt, hash };
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
