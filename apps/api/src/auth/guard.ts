/**
 * Sessions and roles, enforced once for every route (§2 auth, §7 security).
 *
 * **Closed by default.** A route that says nothing about access needs a
 * signed-in user; it has to say `access: 'public'` to be open, and name roles
 * to be narrower. A route someone forgets to mark is therefore closed, not
 * open — the opposite failure would be the one that matters.
 *
 * **The bootstrap password is enforced here too.** A user whose password was
 * set by someone else — the seed's admin, an admin's reset — can reach only
 * the routes marked `allowPendingPasswordChange` (who am I, change password,
 * sign out) until they choose their own.
 *
 * **CSRF.** The session cookie is `SameSite=Strict` and every write takes a
 * JSON body, which a cross-site form cannot send. On a LAN app with no
 * cross-origin client, that is the whole defence it needs.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { resolveSession, type ActiveSession, type Actor, type Role } from '@shopquote/db';

import type { AppContext } from '../context.js';
import { problems } from '../problem.js';

export const SESSION_COOKIE = 'shopquote_session';

/** Who may call a route. Absent means any signed-in user. */
export type Access = 'public' | 'signed-in' | readonly Role[];

/** Settings writes (§4 FR-1; BUILD-PLAN 4.2: "owner/admin only"). */
export const OWNER_OR_ADMIN = ['owner', 'admin'] as const satisfies readonly Role[];
/** Accounts (§4 FR-6: "password reset by admin"). */
export const ADMIN_ONLY = ['admin'] as const satisfies readonly Role[];

declare module 'fastify' {
  interface FastifyContextConfig {
    access?: Access;
    /** Reachable while the user must still replace a password someone else set. */
    allowPendingPasswordChange?: boolean;
  }
  interface FastifyRequest {
    /** The session behind this request, or null. Set before any route runs. */
    auth: ActiveSession | null;
  }
}

export function registerAuth(app: FastifyInstance, ctx: AppContext): void {
  app.decorateRequest('auth', null);

  app.addHook('onRequest', async (request, reply) => {
    request.auth = currentSession(request, reply, ctx);

    const { config, url } = request.routeOptions;
    if (url === undefined) return; // no such route: the 404 handler answers
    const access = config.access ?? 'signed-in';
    if (access === 'public') return;

    const session = request.auth;
    if (session === null) throw problems.unauthenticated();
    if (session.user.mustChangePassword && config.allowPendingPasswordChange !== true) {
      throw problems.passwordChangeRequired();
    }
    if (access !== 'signed-in' && !access.includes(session.user.role)) {
      throw problems.forbidden(session.user.role, access);
    }
  });
}

function currentSession(
  request: FastifyRequest,
  reply: FastifyReply,
  ctx: AppContext,
): ActiveSession | null {
  const token = request.cookies[SESSION_COOKIE];
  if (token === undefined || token === '') return null;
  const session = resolveSession(ctx.db.db, token, ctx.now());
  if (session === undefined || session.user.shopId !== ctx.shopId) {
    // Expired, signed out, or from another shop's server: tell the browser to
    // stop sending it.
    clearSessionCookie(reply);
    return null;
  }
  return session;
}

export function setSessionCookie(
  reply: FastifyReply,
  ctx: AppContext,
  token: string,
  expiresAt: Date,
): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: ctx.secureCookies,
    expires: expiresAt,
    maxAge: Math.max(0, Math.round((expiresAt.getTime() - ctx.now().getTime()) / 1000)),
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

/** The session of a request the guard has already let through. */
export function sessionOf(request: FastifyRequest): ActiveSession {
  if (request.auth === null) throw problems.unauthenticated();
  return request.auth;
}

/** Who is making a change, for the audit log. */
export function actorOf(request: FastifyRequest): Actor {
  return { userId: sessionOf(request).user.id };
}
