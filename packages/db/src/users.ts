/**
 * Accounts (§4 FR-6: login, roles, password reset by admin).
 *
 * Five accounts at most (§1) and three roles (§2), with a handful of rules
 * that are easy to state and easy to forget:
 *
 *   - Usernames compare case-insensitively, so they are stored lowercase:
 *     "Admin" typed at the login box is the admin.
 *   - A password somebody else chose — the seed's, an admin's reset — must be
 *     changed on first use (`mustChangePassword`). The API enforces it.
 *   - Changing or resetting a password ends that user's other sessions.
 *   - A shop cannot lose its last admin, and nobody can remove themselves.
 *
 * Password *policy* (`passwordProblem`) is for passwords a person chooses at
 * the API. The seeders accept whatever bootstrap password the operator sets,
 * because it is forced to change the first time it is used.
 */

import { and, eq, isNull, ne } from 'drizzle-orm';
import { ulid } from 'ulid';

import { recordAudit, type Actor } from './audit.js';
import type { DatabaseHandle, ShopQuoteDatabase } from './db.js';
import { DataError } from './errors.js';
import { hashPassword } from './password.js';
import { sessions, users } from './schema.js';

export const ROLES = ['estimator', 'owner', 'admin'] as const;
export type Role = (typeof ROLES)[number];

/** What the app may show about a user. Never the hash. */
export interface UserSummary {
  id: string;
  shopId: string;
  username: string;
  displayName: string | null;
  email: string | null;
  role: Role;
  /** Set when someone other than this user chose the current password. */
  mustChangePassword: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
}

type UserRow = typeof users.$inferSelect;

export function toUserSummary(row: UserRow): UserSummary {
  return {
    id: row.id,
    shopId: row.shopId,
    username: row.username,
    displayName: row.displayName,
    email: row.email,
    role: row.role,
    mustChangePassword: row.mustChangePassword,
    lastLoginAt: row.lastLoginAt,
    createdAt: row.createdAt,
  };
}

export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;

/** The stored form of a username, or a `DataError` saying why it cannot be one. */
function checkedUsername(raw: string): string {
  const username = normalizeUsername(raw);
  if (!USERNAME_PATTERN.test(username)) {
    throw new DataError(
      'invalid',
      'A username is 2–64 characters of letters, digits, dots, dashes and underscores.',
      { field: 'username' },
    );
  }
  return username;
}

/**
 * NIST SP 800-63B-4 §3.1.1.2: a length floor of 15 for a password that is the
 * only factor, no composition rules, no forced periodic change. A few ordinary
 * words clears it and is easier to type on a shop-floor keyboard than
 * `Tr0ub4dor&3`.
 */
export const MIN_PASSWORD_LENGTH = 15;
export const MAX_PASSWORD_LENGTH = 256;

/** Why a chosen password is unacceptable, or null when it is fine. */
export function passwordProblem(password: string, username: string): string | null {
  const normalized = password.normalize('NFKC');
  const length = [...normalized].length;
  if (length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters — a few words is easiest.`;
  }
  if (length > MAX_PASSWORD_LENGTH) return `Use at most ${MAX_PASSWORD_LENGTH} characters.`;
  if (normalizeUsername(normalized) === normalizeUsername(username)) {
    return 'A password cannot be the username.';
  }
  return null;
}

const liveIn = (shopId: string) => and(eq(users.shopId, shopId), isNull(users.archivedAt));

export function listUsers(db: ShopQuoteDatabase, shopId: string): UserSummary[] {
  return db
    .select()
    .from(users)
    .where(liveIn(shopId))
    .all()
    .map(toUserSummary)
    .sort((a, b) => a.username.localeCompare(b.username));
}

export function getUser(
  db: ShopQuoteDatabase,
  shopId: string,
  id: string,
): UserSummary | undefined {
  const row = db
    .select()
    .from(users)
    .where(and(liveIn(shopId), eq(users.id, id)))
    .get();
  return row === undefined ? undefined : toUserSummary(row);
}

export interface LoginCandidate extends UserSummary {
  passwordHash: string;
}

/** The live user a login attempt names, with the hash to check against. */
export function findLoginCandidate(
  db: ShopQuoteDatabase,
  shopId: string,
  username: string,
): LoginCandidate | undefined {
  const row = db
    .select()
    .from(users)
    .where(and(liveIn(shopId), eq(users.username, normalizeUsername(username))))
    .get();
  return row === undefined ? undefined : { ...toUserSummary(row), passwordHash: row.passwordHash };
}

export interface UserRecord {
  username: string;
  passwordHash: string;
  role: Role;
  displayName: string | null;
  email: string | null;
  mustChangePassword: boolean;
}

/**
 * The synchronous half of `createUser()`, for a caller that has hashed the
 * password already and needs the insert inside its own transaction — the
 * seeders, which write a shop and its first admin as one unit.
 */
export function insertUser(db: ShopQuoteDatabase, shopId: string, record: UserRecord): UserSummary {
  const username = checkedUsername(record.username);
  const taken = db
    .select({ id: users.id })
    .from(users)
    .where(and(liveIn(shopId), eq(users.username, username)))
    .get();
  if (taken !== undefined) {
    throw new DataError('conflict', `There is already a user called "${username}".`, {
      field: 'username',
    });
  }

  const row = db
    .insert(users)
    .values({
      id: ulid(),
      shopId,
      username,
      displayName: record.displayName,
      email: record.email,
      role: record.role,
      passwordHash: record.passwordHash,
      mustChangePassword: record.mustChangePassword,
    })
    .returning()
    .get();
  return toUserSummary(row);
}

export interface NewUser {
  username: string;
  password: string;
  role: Role;
  displayName?: string | null;
  email?: string | null;
  /** Defaults to true: whoever set this password, it was not its owner. */
  mustChangePassword?: boolean;
}

/** Create an account on an admin's behalf (§4 FR-6). */
export async function createUser(
  handle: DatabaseHandle,
  shopId: string,
  input: NewUser,
  actor: Actor,
): Promise<UserSummary> {
  checkedUsername(input.username); // before paying for a hash
  const passwordHash = await hashPassword(input.password);

  return handle.sqlite.transaction(() => {
    const created = insertUser(handle.db, shopId, {
      username: input.username,
      passwordHash,
      role: input.role,
      displayName: input.displayName ?? null,
      email: input.email ?? null,
      mustChangePassword: input.mustChangePassword ?? true,
    });
    recordAudit(handle.db, {
      shopId,
      actorUserId: actor.userId,
      action: 'user.create',
      entityTable: 'users',
      entityId: created.id,
      summary: `Created ${created.role} "${created.username}"`,
      after: created,
    });
    return created;
  })();
}

export interface UserChanges {
  displayName: string | null;
  email: string | null;
  role: Role;
}

export function updateUser(
  handle: DatabaseHandle,
  shopId: string,
  id: string,
  changes: UserChanges,
  actor: Actor,
): UserSummary {
  return handle.sqlite.transaction(() => {
    const before = requireUser(handle.db, shopId, id);
    if (before.role === 'admin' && changes.role !== 'admin') {
      guardLastAdmin(handle.db, shopId, id, 'change the role of');
    }

    const row = handle.db
      .update(users)
      .set({ displayName: changes.displayName, email: changes.email, role: changes.role })
      .where(eq(users.id, id))
      .returning()
      .get();
    const after = toUserSummary(row);

    recordAudit(handle.db, {
      shopId,
      actorUserId: actor.userId,
      action: 'user.update',
      entityTable: 'users',
      entityId: id,
      summary:
        before.role === after.role
          ? `Updated "${after.username}"`
          : `Changed "${after.username}" from ${before.role} to ${after.role}`,
      before,
      after,
    });
    return after;
  })();
}

/** Soft-delete an account (§7) and end its sessions. */
export function archiveUser(
  handle: DatabaseHandle,
  shopId: string,
  id: string,
  actor: Actor,
): void {
  handle.sqlite.transaction(() => {
    const before = requireUser(handle.db, shopId, id);
    if (id === actor.userId) {
      throw new DataError('conflict', 'You cannot remove your own account; another admin can.');
    }
    if (before.role === 'admin') guardLastAdmin(handle.db, shopId, id, 'remove');

    handle.db.update(users).set({ archivedAt: new Date() }).where(eq(users.id, id)).run();
    handle.db.delete(sessions).where(eq(sessions.userId, id)).run();

    recordAudit(handle.db, {
      shopId,
      actorUserId: actor.userId,
      action: 'user.archive',
      entityTable: 'users',
      entityId: id,
      summary: `Removed "${before.username}"`,
      before,
    });
  })();
}

export interface SetPasswordOptions {
  /** True for an admin's reset — the user must choose their own next. */
  mustChangePassword: boolean;
  /** The session making the change survives it; every other one ends. */
  keepSessionId?: string;
  actor: Actor;
  action: 'auth.password.change' | 'user.password.reset';
}

/**
 * Set a user's password. Ends every session but the one making the change: a
 * password changed because it might be known should not leave a door open on
 * another machine.
 */
export async function setPassword(
  handle: DatabaseHandle,
  shopId: string,
  userId: string,
  newPassword: string,
  options: SetPasswordOptions,
): Promise<UserSummary> {
  const passwordHash = await hashPassword(newPassword);

  return handle.sqlite.transaction(() => {
    const before = requireUser(handle.db, shopId, userId);
    const row = handle.db
      .update(users)
      .set({ passwordHash, mustChangePassword: options.mustChangePassword })
      .where(eq(users.id, userId))
      .returning()
      .get();

    handle.db
      .delete(sessions)
      .where(
        options.keepSessionId === undefined
          ? eq(sessions.userId, userId)
          : and(eq(sessions.userId, userId), ne(sessions.id, options.keepSessionId)),
      )
      .run();

    recordAudit(handle.db, {
      shopId,
      actorUserId: options.actor.userId,
      action: options.action,
      entityTable: 'users',
      entityId: userId,
      summary:
        options.action === 'user.password.reset'
          ? `Reset the password for "${before.username}"`
          : `"${before.username}" changed their password`,
    });
    return toUserSummary(row);
  })();
}

/**
 * Replace a stored hash with a fresh one after a successful login, when
 * `needsRehash()` says the old one is on an older algorithm or cost. Same
 * password, so no session ends and no flag moves.
 */
export async function rehashPassword(
  db: ShopQuoteDatabase,
  userId: string,
  password: string,
): Promise<void> {
  const passwordHash = await hashPassword(password);
  db.update(users).set({ passwordHash }).where(eq(users.id, userId)).run();
}

export function recordLogin(db: ShopQuoteDatabase, userId: string, at: Date): void {
  db.update(users).set({ lastLoginAt: at }).where(eq(users.id, userId)).run();
}

function requireUser(db: ShopQuoteDatabase, shopId: string, id: string): UserSummary {
  const user = getUser(db, shopId, id);
  if (user === undefined) throw new DataError('not-found', `No user ${id} in this shop.`);
  return user;
}

function guardLastAdmin(db: ShopQuoteDatabase, shopId: string, id: string, verb: string): void {
  const others = db
    .select({ id: users.id })
    .from(users)
    .where(and(liveIn(shopId), eq(users.role, 'admin'), ne(users.id, id)))
    .all();
  if (others.length === 0) {
    throw new DataError(
      'conflict',
      `You cannot ${verb} the last admin — the shop would have nobody who can manage accounts.`,
    );
  }
}
