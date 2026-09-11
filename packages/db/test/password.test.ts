import { randomBytes, scryptSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  algorithmOf,
  generatePassword,
  hashPassword,
  needsRehash,
  verifyPassword,
} from '../src/password.js';

/**
 * §4 FR-6. What matters beyond "it round-trips" is the stored *format*: a PHC
 * string naming its algorithm. That is what let Task 3.1 bring in argon2id
 * beside Task 2.1's scrypt and upgrade each row at its owner's next login,
 * instead of migrating every row at once.
 */

/** A row as Task 2.1 wrote it. Built here because nothing in the app writes
 *  scrypt any more — but a database seeded before Task 3.1 is full of them. */
function legacyScryptHash(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password.normalize('NFKC'), salt, 32, { N: 16384, r: 8, p: 1 });
  return `$scrypt$n=16384,r=8,p=1$${salt.toString('base64')}$${key.toString('base64')}`;
}

describe('password hashing', () => {
  it('round-trips, and rejects anything else', async () => {
    const hash = await hashPassword('trés sécret ✓');
    expect(await verifyPassword(hash, 'trés sécret ✓')).toBe(true);
    expect(await verifyPassword(hash, 'tres secret')).toBe(false);
    expect(await verifyPassword(hash, '')).toBe(false);
  });

  it('writes argon2id at RFC 9106’s second recommended parameters', async () => {
    const hash = await hashPassword('hunter2');
    expect(algorithmOf(hash)).toBe('argon2id');
    expect(hash).toMatch(/^\$argon2id\$v=19\$/);
    for (const param of ['m=65536', 't=3', 'p=4']) expect(hash).toContain(param);
    expect(hash).not.toContain('hunter2');
  });

  it('salts, so the same password hashes differently every time', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });

  it('still verifies a scrypt row from before argon2id, and marks it for re-hashing', async () => {
    const legacy = legacyScryptHash('bootstrap password');
    expect(algorithmOf(legacy)).toBe('scrypt');
    expect(await verifyPassword(legacy, 'bootstrap password')).toBe(true);
    expect(await verifyPassword(legacy, 'something else')).toBe(false);
    expect(needsRehash(legacy)).toBe(true);
  });

  it('marks an argon2id row on older parameters for re-hashing, and a current one not', async () => {
    expect(needsRehash(await hashPassword('current'))).toBe(false);
    expect(
      needsRehash('$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaA'),
    ).toBe(true);
    expect(needsRehash('$argon2i$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA')).toBe(true);
  });

  it('resolves false rather than throwing on a hash it cannot read', async () => {
    for (const bad of [
      '',
      'plaintext',
      '$argon2id$v=19$m=1$notyet$hash',
      '$scrypt$broken',
      '$scrypt$n=99999999999,r=8,p=1$c2FsdA==$aGFzaA==',
      '$bcrypt$whatever',
    ]) {
      expect(await verifyPassword(bad, 'anything')).toBe(false);
    }
  });

  it('generates a password without look-alike characters', async () => {
    const generated = generatePassword();
    expect(generated).toHaveLength(20);
    expect(generated).not.toMatch(/[01lIO]/);
    expect(await verifyPassword(await hashPassword(generated), generated)).toBe(true);
  });
});
