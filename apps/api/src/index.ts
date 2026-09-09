/**
 * ShopQuote API.
 *
 * Every price the user sees is computed here, not in the browser: the web app
 * sends inputs and renders what comes back (REQUIREMENTS §4 FR-2). That keeps
 * one costing engine in play and lets each save store the config snapshot it
 * was priced with (§7).
 *
 * Routes arrive in BUILD-PLAN Phase 3: auth and config (3.1), quotes and parts
 * (3.2), CSV and drawing intake (3.3).
 */

import Fastify from 'fastify';

export function buildServer() {
  const app = Fastify({ logger: true });

  app.get('/healthz', async () => ({ status: 'ok' }));

  return app;
}

/* Only listen when run directly, so tests can build a server without binding
   a port. */
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const port = Number(process.env['PORT'] ?? 3000);
  const host = process.env['HOST'] ?? '127.0.0.1';
  const app = buildServer();
  app.listen({ port, host }).catch((err: unknown) => {
    app.log.error(err);
    process.exit(1);
  });
}
