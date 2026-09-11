/**
 * ShopQuote API — the process.
 *
 * `server.ts` builds the app; this file reads the environment, opens the
 * database, works out which shop it serves, and listens. It refuses to start
 * rather than guess: no database, no tables or no shop each get a sentence
 * saying which command to run.
 *
 *   SHOPQUOTE_DB_PATH        the SQLite file (default <repo>/data/shopquote.db)
 *   SHOPQUOTE_SHOP_ID        which shop, when a database holds more than one
 *   SHOPQUOTE_COOKIE_SECURE  true behind HTTPS (default: true when NODE_ENV=production)
 *   SHOPQUOTE_TRUST_PROXY    true behind a reverse proxy (Task 5.1's Caddy)
 *   HOST, PORT               default 127.0.0.1:3000
 */

import { listShops, openDatabase, type DatabaseHandle } from '@shopquote/db';

import { buildServer } from './server.js';

async function main(): Promise<void> {
  const env = process.env;

  let handle: DatabaseHandle;
  try {
    handle = openDatabase({ mustExist: true });
  } catch (cause) {
    throw new Error(
      `Cannot open the database (${(cause as Error).message}). ` +
        'Run `npm run db:migrate && npm run db:seed` first, or set SHOPQUOTE_DB_PATH.',
    );
  }

  const shopId = pickShop(handle, env['SHOPQUOTE_SHOP_ID']);
  const app = await buildServer({
    db: handle,
    shopId,
    secureCookies: flag(env['SHOPQUOTE_COOKIE_SECURE'], env['NODE_ENV'] === 'production'),
    trustProxy: flag(env['SHOPQUOTE_TRUST_PROXY'], false),
  });

  const stop = (signal: string): void => {
    app.log.info(`${signal} received; closing`);
    void app.close().finally(() => {
      handle.close();
      process.exit(0);
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  await app.listen({ port: Number(env['PORT'] ?? 3000), host: env['HOST'] ?? '127.0.0.1' });
}

function pickShop(handle: DatabaseHandle, configured: string | undefined): string {
  let shops: { id: string; name: string }[];
  try {
    shops = listShops(handle.db);
  } catch (cause) {
    if (/no such table/.test(String(cause))) {
      throw new Error(`${handle.path} has no tables yet. Run \`npm run db:migrate\`.`);
    }
    throw cause;
  }

  if (configured !== undefined && configured !== '') {
    if (!shops.some((s) => s.id === configured)) {
      throw new Error(`SHOPQUOTE_SHOP_ID=${configured} is not a shop in ${handle.path}.`);
    }
    return configured;
  }
  const [only, ...others] = shops;
  if (only === undefined) {
    throw new Error(`${handle.path} holds no shop. Run \`npm run db:seed\` (or db:seed-blank).`);
  }
  if (others.length > 0) {
    throw new Error(
      `${handle.path} holds ${shops.length} shops; set SHOPQUOTE_SHOP_ID to one of: ` +
        shops.map((s) => `${s.id} (${s.name})`).join(', '),
    );
  }
  return only.id;
}

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return value === 'true' || value === '1';
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
