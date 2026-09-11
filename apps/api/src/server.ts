/**
 * The Fastify app (BUILD-PLAN 3.1).
 *
 * Every price the user sees is computed here, not in the browser: the web app
 * sends inputs and renders what comes back (REQUIREMENTS §4 FR-2). That keeps
 * one costing engine in play and lets each save store the config snapshot it
 * was priced with (§7).
 *
 * `buildServer()` takes an open database and never opens or closes one, so a
 * test hands it an in-memory database and `index.ts` hands it the real file.
 * It also takes the clock, which is how the tests check a twelve-hour session
 * without waiting twelve hours.
 *
 * Routes: auth and accounts, config and its catalogs (3.1). Quotes and parts
 * (3.2) and intake (3.3) land beside them.
 */

import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';

import { hashPassword, type DatabaseHandle } from '@shopquote/db';

import { registerAuth } from './auth/guard.js';
import { LoginThrottle, type ThrottleLimits } from './auth/throttle.js';
import type { AppContext } from './context.js';
import { registerProblems } from './problem.js';
import { authRoutes } from './routes/auth.js';
import { catalogRoutes } from './routes/catalog.js';
import { configRoutes } from './routes/config.js';
import { userRoutes } from './routes/users.js';

export interface ServerOptions {
  /** An open, migrated database. The server neither opens nor closes it. */
  db: DatabaseHandle;
  /** The shop this server serves. */
  shopId: string;
  /** Request logging. On in production; tests turn it off. */
  logger?: boolean;
  /** Mark the session cookie Secure — on behind HTTPS (§7). */
  secureCookies?: boolean;
  /** Believe X-Forwarded-For from a reverse proxy (Caddy, Task 5.1), so the
   *  login throttle counts the client and not the proxy. */
  trustProxy?: boolean;
  /** The clock. Tests move it; nothing else should. */
  now?: () => Date;
  throttle?: ThrottleLimits;
}

export async function buildServer(options: ServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? true,
    trustProxy: options.trustProxy ?? false,
  });
  // JSON only. Fastify also parses text/plain by default, and text/plain is
  // one of the bodies a cross-site HTML form can send; without it, a write
  // needs a JSON body no form can produce, behind the SameSite=Strict cookie.
  app.removeContentTypeParser('text/plain');

  let decoy: Promise<string> | undefined;
  const ctx: AppContext = {
    db: options.db,
    shopId: options.shopId,
    now: options.now ?? (() => new Date()),
    secureCookies: options.secureCookies ?? false,
    throttle: new LoginThrottle(options.throttle),
    decoyHash: () => (decoy ??= hashPassword(randomBytes(32).toString('base64'))),
  };

  // Awaited so the cookie parser's onRequest hook is in place before the
  // session guard's, which reads what it parsed.
  await app.register(cookie);
  registerProblems(app);
  registerAuth(app, ctx);

  app.get('/healthz', { config: { access: 'public' } }, async () => ({ status: 'ok' }));

  void app.register(authRoutes(ctx), { prefix: '/api/auth' });
  void app.register(userRoutes(ctx), { prefix: '/api/users' });
  void app.register(configRoutes(ctx), { prefix: '/api/config' });
  void app.register(catalogRoutes(ctx), { prefix: '/api' });

  return app;
}
