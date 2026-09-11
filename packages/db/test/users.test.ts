import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { openMigratedMemoryDatabase, type DatabaseHandle } from '../src/db.js';
import { DataError } from '../src/errors.js';
import { verifyPassword } from '../src/password.js';
import { auditLog, sessions, users } from '../src/schema.js';
import { seedBlankShop } from '../src/seed-blank.js';
import { createSession, resolveSession, SESSION_TTL_MS, sessionIdFor } from '../src/sessions.js';
import {
  archiveUser,
  createUser,
  findLoginCandidate,
  listUsers,
  passwordProblem,
  setPassword,
  updateUser,
  type UserSummary,
} from '../src/users.js';

/**
 * §4 FR-6 (login, roles, password reset by admin) and §7 (sessions expire in
 * 12 h). The rules here are the ones that are easy to state and easy to lose:
 * case-insensitive usernames, a password change that ends the other sessions,
 * a shop that can never be left without an admin.
 */

interface Shop {
  handle: DatabaseHandle;
  shopId: string;
  admin: UserSummary;
}

async function shop(): Promise<Shop> {
  const handle = openMigratedMemoryDatabase();
  const { shopId } = await seedBlankShop(handle, { adminPassword: 'bootstrap' });
  const [admin] = listUsers(handle.db, shopId);
  if (admin === undefined) throw new Error('the blank seed made no admin');
  return { handle, shopId, admin };
}

/** The `DataError` code a write was refused with. */
async function refusal(write: () => unknown): Promise<string> {
  try {
    await write();
  } catch (error) {
    if (error instanceof DataError) return error.code;
    throw error;
  }
  throw new Error('expected the write to be refused');
}

const PASSWORD = 'four ordinary words here';

describe('accounts', () => {
  it('stores a username lowercase and finds it however it is typed', async () => {
    const { handle, shopId, admin } = await shop();
    const jo = await createUser(
      handle,
      shopId,
      { username: '  Estimator.Jo ', password: PASSWORD, role: 'estimator' },
      { userId: admin.id },
    );
    expect(jo.username).toBe('estimator.jo');
    expect(jo.mustChangePassword).toBe(true);
    expect(findLoginCandidate(handle.db, shopId, 'ESTIMATOR.JO')?.id).toBe(jo.id);
    handle.close();
  });

  it('allows one live user per name — and the name back once they are removed', async () => {
    const { handle, shopId, admin } = await shop();
    const actor = { userId: admin.id };
    const jo = await createUser(
      handle,
      shopId,
      { username: 'jo', password: PASSWORD, role: 'estimator' },
      actor,
    );
    expect(
      await refusal(() =>
        createUser(handle, shopId, { username: 'JO', password: PASSWORD, role: 'owner' }, actor),
      ),
    ).toBe('conflict');

    archiveUser(handle, shopId, jo.id, actor);
    // Soft delete keeps the old row (§7); the live-only unique index lets
    // the next Jo have the name.
    const again = await createUser(
      handle,
      shopId,
      { username: 'jo', password: PASSWORD, role: 'estimator' },
      actor,
    );
    expect(again.id).not.toBe(jo.id);
    expect(handle.db.select().from(users).where(eq(users.username, 'jo')).all()).toHaveLength(2);
    handle.close();
  });

  it('refuses a username that is not one', async () => {
    const { handle, shopId, admin } = await shop();
    expect(
      await refusal(() =>
        createUser(
          handle,
          shopId,
          { username: 'has spaces', password: PASSWORD, role: 'estimator' },
          { userId: admin.id },
        ),
      ),
    ).toBe('invalid');
    handle.close();
  });

  it('records who created whom', async () => {
    const { handle, shopId, admin } = await shop();
    const jo = await createUser(
      handle,
      shopId,
      { username: 'jo', password: PASSWORD, role: 'estimator' },
      { userId: admin.id },
    );
    const entry = handle.db.select().from(auditLog).where(eq(auditLog.entityId, jo.id)).get();
    expect(entry?.action).toBe('user.create');
    expect(entry?.actorUserId).toBe(admin.id);
    expect(JSON.stringify(entry?.after)).not.toContain('$argon2id$');
    handle.close();
  });

  it('will not lose the last admin, and nobody removes themselves', async () => {
    const { handle, shopId, admin } = await shop();
    const actor = { userId: admin.id };
    expect(
      await refusal(() =>
        updateUser(
          handle,
          shopId,
          admin.id,
          { displayName: null, email: null, role: 'owner' },
          actor,
        ),
      ),
    ).toBe('conflict');
    expect(await refusal(() => archiveUser(handle, shopId, admin.id, actor))).toBe('conflict');

    const second = await createUser(
      handle,
      shopId,
      { username: 'second', password: PASSWORD, role: 'admin' },
      actor,
    );
    // With another admin in place, the first may step down.
    const demoted = updateUser(
      handle,
      shopId,
      admin.id,
      { displayName: 'Owner', email: null, role: 'owner' },
      { userId: second.id },
    );
    expect(demoted.role).toBe('owner');
    handle.close();
  });
});

describe('passwords', () => {
  it('ends the other sessions when a password changes, and keeps the one that changed it', async () => {
    const { handle, shopId, admin } = await shop();
    const now = new Date();
    const here = createSession(handle.db, { shopId, userId: admin.id, now });
    const there = createSession(handle.db, { shopId, userId: admin.id, now });

    const after = await setPassword(handle, shopId, admin.id, PASSWORD, {
      mustChangePassword: false,
      keepSessionId: here.sessionId,
      actor: { userId: admin.id },
      action: 'auth.password.change',
    });

    expect(after.mustChangePassword).toBe(false);
    expect(resolveSession(handle.db, here.token, now)).toBeDefined();
    expect(resolveSession(handle.db, there.token, now)).toBeUndefined();
    const stored = findLoginCandidate(handle.db, shopId, 'admin');
    expect(await verifyPassword(stored?.passwordHash ?? '', PASSWORD)).toBe(true);
    handle.close();
  });

  it('makes an admin-reset user choose again, and signs them out everywhere', async () => {
    const { handle, shopId, admin } = await shop();
    const jo = await createUser(
      handle,
      shopId,
      { username: 'jo', password: PASSWORD, role: 'estimator', mustChangePassword: false },
      { userId: admin.id },
    );
    createSession(handle.db, { shopId, userId: jo.id, now: new Date() });

    const reset = await setPassword(handle, shopId, jo.id, 'a temporary one for jo', {
      mustChangePassword: true,
      actor: { userId: admin.id },
      action: 'user.password.reset',
    });

    expect(reset.mustChangePassword).toBe(true);
    expect(handle.db.select().from(sessions).where(eq(sessions.userId, jo.id)).all()).toEqual([]);
    const entry = handle.db.select().from(auditLog).where(eq(auditLog.entityId, jo.id)).all();
    expect(entry.map((e) => e.action)).toContain('user.password.reset');
    handle.close();
  });

  it('asks for length, not symbols (NIST SP 800-63B-4)', () => {
    expect(passwordProblem('Tr0ub4dor&3', 'jo')).toMatch(/at least 15/);
    expect(passwordProblem('correct horse battery staple', 'jo')).toBeNull();
    expect(passwordProblem('  Estimator.Jo.Long.Name ', 'estimator.jo.long.name')).toMatch(
      /cannot be the username/,
    );
  });
});

describe('sessions (§7)', () => {
  it('stores a hash of the token, never the token', async () => {
    const { handle, shopId, admin } = await shop();
    const { token, sessionId } = createSession(handle.db, {
      shopId,
      userId: admin.id,
      now: new Date(),
    });
    expect(sessionId).toBe(sessionIdFor(token));
    const raw = JSON.stringify(handle.db.select().from(sessions).all());
    expect(raw).not.toContain(token);
    handle.close();
  });

  it('lasts twelve hours from sign-in, then is gone', async () => {
    const { handle, shopId, admin } = await shop();
    const signIn = new Date('2026-09-10T07:00:00Z');
    const { token } = createSession(handle.db, { shopId, userId: admin.id, now: signIn });

    const lastMoment = new Date(signIn.getTime() + SESSION_TTL_MS - 1);
    expect(resolveSession(handle.db, token, lastMoment)?.user.id).toBe(admin.id);

    const expired = new Date(signIn.getTime() + SESSION_TTL_MS);
    expect(resolveSession(handle.db, token, expired)).toBeUndefined();
    expect(handle.db.select().from(sessions).all()).toEqual([]);
    handle.close();
  });

  it('ends with the account', async () => {
    const { handle, shopId, admin } = await shop();
    const jo = await createUser(
      handle,
      shopId,
      { username: 'jo', password: PASSWORD, role: 'estimator' },
      { userId: admin.id },
    );
    const { token } = createSession(handle.db, { shopId, userId: jo.id, now: new Date() });
    archiveUser(handle, shopId, jo.id, { userId: admin.id });
    expect(resolveSession(handle.db, token, new Date())).toBeUndefined();
    handle.close();
  });
});
