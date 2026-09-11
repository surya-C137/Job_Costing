/**
 * `/api/auth` — sign in, sign out, who am I, change my password (§4 FR-6).
 *
 * The login path is where the security requirements of §7 meet: the throttle
 * is consulted before the password is checked, an unknown username costs the
 * same as a wrong password, and a stored hash on an older algorithm is
 * upgraded the moment its owner proves they know the password.
 */

import type { FastifyInstance } from 'fastify';

import {
  createSession,
  deleteSession,
  findLoginCandidate,
  needsRehash,
  normalizeUsername,
  passwordProblem,
  purgeExpiredSessions,
  recordAudit,
  recordLogin,
  rehashPassword,
  setPassword,
  verifyPassword,
} from '@shopquote/db';

import { clearSessionCookie, sessionOf, setSessionCookie } from '../auth/guard.js';
import type { AppContext } from '../context.js';
import { parse, problems } from '../problem.js';
import { loginBody, passwordChangeBody } from '../schemas.js';

export function authRoutes(ctx: AppContext) {
  return async (app: FastifyInstance): Promise<void> => {
    const { db, sqlite } = ctx.db;

    app.post('/login', { config: { access: 'public' } }, async (request, reply) => {
      const { username, password } = parse(loginBody, request.body);
      const now = ctx.now();

      const wait = ctx.throttle.retryAfterSeconds(request.ip, username, now);
      if (wait > 0) throw problems.tooManyAttempts(wait);

      const candidate = findLoginCandidate(db, ctx.shopId, username);
      const verified = await verifyPassword(
        candidate?.passwordHash ?? (await ctx.decoyHash()),
        password,
      );
      if (candidate === undefined || !verified) {
        ctx.throttle.recordFailure(request.ip, username, now);
        request.log.warn(
          { username: normalizeUsername(username), address: request.ip },
          'sign-in failed',
        );
        throw problems.invalidCredentials();
      }
      ctx.throttle.recordSuccess(request.ip, username);

      // A hash on an older algorithm or cost — Task 2.1's scrypt, or argon2id
      // before a parameter bump — is replaced now, while we hold the password.
      const upgraded = needsRehash(candidate.passwordHash);
      if (upgraded) await rehashPassword(db, candidate.id, password);

      const session = sqlite.transaction(() => {
        purgeExpiredSessions(db, now);
        const created = createSession(db, {
          shopId: ctx.shopId,
          userId: candidate.id,
          now,
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        });
        recordLogin(db, candidate.id, now);
        recordAudit(db, {
          shopId: ctx.shopId,
          actorUserId: candidate.id,
          action: 'auth.login',
          entityTable: 'users',
          entityId: candidate.id,
          summary: `"${candidate.username}" signed in${upgraded ? '; stored password hash upgraded' : ''}`,
        });
        return created;
      })();

      setSessionCookie(reply, ctx, session.token, session.expiresAt);
      const { passwordHash: _hash, ...user } = candidate;
      return { user: { ...user, lastLoginAt: now }, expiresAt: session.expiresAt };
    });

    app.post(
      '/logout',
      { config: { allowPendingPasswordChange: true } },
      async (request, reply) => {
        const session = sessionOf(request);
        sqlite.transaction(() => {
          deleteSession(db, session.sessionId);
          recordAudit(db, {
            shopId: ctx.shopId,
            actorUserId: session.user.id,
            action: 'auth.logout',
            entityTable: 'users',
            entityId: session.user.id,
            summary: `"${session.user.username}" signed out`,
          });
        })();
        clearSessionCookie(reply);
        return reply.code(204).send();
      },
    );

    app.get('/me', { config: { allowPendingPasswordChange: true } }, async (request) => {
      const session = sessionOf(request);
      return { user: session.user, expiresAt: session.expiresAt };
    });

    /**
     * Change my own password. The current one is required even though the
     * session proves who this is: a browser left signed in on the shop floor
     * should not let a passer-by take the account over.
     */
    app.put('/password', { config: { allowPendingPasswordChange: true } }, async (request) => {
      const session = sessionOf(request);
      const { currentPassword, newPassword } = parse(passwordChangeBody, request.body);
      const { username } = session.user;
      const now = ctx.now();

      const wait = ctx.throttle.retryAfterSeconds(request.ip, username, now);
      if (wait > 0) throw problems.tooManyAttempts(wait);

      const candidate = findLoginCandidate(db, ctx.shopId, username);
      if (
        candidate === undefined ||
        !(await verifyPassword(candidate.passwordHash, currentPassword))
      ) {
        ctx.throttle.recordFailure(request.ip, username, now);
        throw problems.invalid('/currentPassword', 'That is not your current password.');
      }

      const problem = passwordProblem(newPassword, username);
      if (problem !== null) throw problems.invalid('/newPassword', problem);
      if (newPassword.normalize('NFKC') === currentPassword.normalize('NFKC')) {
        throw problems.invalid('/newPassword', 'Choose a password different from the current one.');
      }

      const user = await setPassword(ctx.db, ctx.shopId, session.user.id, newPassword, {
        mustChangePassword: false,
        keepSessionId: session.sessionId,
        actor: { userId: session.user.id },
        action: 'auth.password.change',
      });
      return { user };
    });
  };
}
