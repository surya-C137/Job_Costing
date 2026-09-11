/**
 * Server-side sessions (§2 auth, §7 security: "sessions expire in 12 h").
 *
 * **The cookie holds a token; the table holds its SHA-256.** A copy of the
 * database file — which is exactly what the nightly backup makes (§7) — then
 * contains no session anyone can use. The token is 256 random bits, so a plain
 * hash is enough; there is nothing to brute-force a salt against.
 *
 * **Twelve hours from sign-in, not from last activity.** §7 says sessions
 * expire in 12 h, and a fixed window is the plain reading: the estimator signs
 * in at the start of a shift and again at the start of the next one. A sliding
 * window would keep a browser left open on the shop floor signed in forever.
 */

import { createHash, randomBytes } from 'node:crypto';
import { and, eq, lt, ne } from 'drizzle-orm';

import type { ShopQuoteDatabase } from './db.js';
import { sessions, users } from './schema.js';
import { toUserSummary, type UserSummary } from './users.js';

/** §7: twelve hours. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** How stale `last_seen_at` may get before a request refreshes it. Writing it
 *  on every request would turn every read into a write. */
const TOUCH_INTERVAL_MS = 60 * 1000;

/** What the table stores for a token. */
export function sessionIdFor(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface NewSession {
  shopId: string;
  userId: string;
  now: Date;
  ttlMs?: number;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface CreatedSession {
  /** Goes in the cookie. Never stored. */
  token: string;
  sessionId: string;
  expiresAt: Date;
}

export function createSession(db: ShopQuoteDatabase, input: NewSession): CreatedSession {
  const token = randomBytes(32).toString('base64url');
  const sessionId = sessionIdFor(token);
  const expiresAt = new Date(input.now.getTime() + (input.ttlMs ?? SESSION_TTL_MS));
  db.insert(sessions)
    .values({
      id: sessionId,
      shopId: input.shopId,
      userId: input.userId,
      expiresAt,
      lastSeenAt: input.now,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    })
    .run();
  return { token, sessionId, expiresAt };
}

export interface ActiveSession {
  sessionId: string;
  expiresAt: Date;
  user: UserSummary;
}

/**
 * The session a cookie token names, if it is still good. An expired session,
 * or one whose user has since been archived, is deleted on the way past and
 * reads as no session at all.
 */
export function resolveSession(
  db: ShopQuoteDatabase,
  token: string,
  now: Date,
): ActiveSession | undefined {
  const sessionId = sessionIdFor(token);
  const row = db
    .select()
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.id, sessionId))
    .get();
  if (row === undefined) return undefined;

  if (row.sessions.expiresAt.getTime() <= now.getTime() || row.users.archivedAt !== null) {
    db.delete(sessions).where(eq(sessions.id, sessionId)).run();
    return undefined;
  }

  const lastSeen = row.sessions.lastSeenAt?.getTime() ?? 0;
  if (now.getTime() - lastSeen >= TOUCH_INTERVAL_MS) {
    db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, sessionId)).run();
  }

  return { sessionId, expiresAt: row.sessions.expiresAt, user: toUserSummary(row.users) };
}

export function deleteSession(db: ShopQuoteDatabase, sessionId: string): void {
  db.delete(sessions).where(eq(sessions.id, sessionId)).run();
}

/** End every session a user has, except optionally one. */
export function deleteUserSessions(
  db: ShopQuoteDatabase,
  userId: string,
  exceptSessionId?: string,
): void {
  db.delete(sessions)
    .where(
      exceptSessionId === undefined
        ? eq(sessions.userId, userId)
        : and(eq(sessions.userId, userId), ne(sessions.id, exceptSessionId)),
    )
    .run();
}

/** Drop sessions past their expiry. Called at each login, which is often
 *  enough for five users and needs no scheduler. */
export function purgeExpiredSessions(db: ShopQuoteDatabase, now: Date): void {
  db.delete(sessions).where(lt(sessions.expiresAt, now)).run();
}
