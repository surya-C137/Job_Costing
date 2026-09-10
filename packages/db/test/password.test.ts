import { describe, expect, it } from 'vitest';

import { generatePassword, hashPassword, needsRehash, verifyPassword } from '../src/password.js';

/**
 * §4 FR-6. The property that matters beyond "it round-trips" is the stored
 * *format*: a PHC string naming its algorithm, so Task 3.1 can add argon2id
 * beside scrypt and re-hash on login rather than migrating every row.
 */
describe('password hashing', () => {
  it('round-trips, and rejects anything else', () => {
    const hash = hashPassword('trés sécret ✓');
    expect(verifyPassword(hash, 'trés sécret ✓')).toBe(true);
    expect(verifyPassword(hash, 'tres secret')).toBe(false);
    expect(verifyPassword(hash, '')).toBe(false);
  });

  it('stores a PHC string that names its algorithm and parameters', () => {
    const hash = hashPassword('hunter2');
    expect(hash).toMatch(/^\$scrypt\$n=16384,r=8,p=1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(hash).not.toContain('hunter2');
  });

  it('salts, so the same password hashes differently every time', () => {
    expect(hashPassword('same')).not.toBe(hashPassword('same'));
  });

  it('returns false rather than throwing on a hash it cannot read', () => {
    for (const bad of ['', 'plaintext', '$argon2id$v=19$m=1$notyet$hash', '$scrypt$broken']) {
      expect(verifyPassword(bad, 'anything')).toBe(false);
    }
  });

  it('asks for a re-hash when the stored parameters are not the current ones', () => {
    expect(needsRehash(hashPassword('current'))).toBe(false);
    expect(needsRehash('$scrypt$n=1024,r=8,p=1$c2FsdA==$aGFzaA==')).toBe(true);
    expect(needsRehash('$argon2id$v=19$m=65536,t=3,p=4$c2FsdA==$aGFzaA==')).toBe(true);
  });

  it('generates a password without look-alike characters', () => {
    const generated = generatePassword();
    expect(generated).toHaveLength(20);
    expect(generated).not.toMatch(/[01lIO]/);
    expect(verifyPassword(hashPassword(generated), generated)).toBe(true);
  });
});
