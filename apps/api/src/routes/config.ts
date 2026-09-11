/**
 * `/api/config` — the whole configuration (§4 FR-1, §8).
 *
 *   GET  /api/config          the ShopConfig in force now, or `?asOf=` a date
 *   PUT  /api/config          the Settings "Shop" page: defaults, parity, modules
 *   GET  /api/config/export   the config JSON, price history and all
 *   POST /api/config/import   make this shop's configuration equal a config JSON
 *
 * Reading is open to every role — the estimator's pickers need the catalog,
 * and BUILD-PLAN 4.2 shows the estimator Settings read-only. Changing any of
 * it is for owners and admins.
 *
 * `PUT` deliberately does not take the catalogs. A form saved from a stale tab
 * would otherwise archive whatever another tab had added since it loaded;
 * catalogs change a row at a time through their own routes, and replacing all
 * of them at once is an import — an explicit act, with a dry run.
 */

import type { FastifyInstance } from 'fastify';

import {
  configDocumentSchema,
  exportShopConfig,
  importShopConfig,
  loadShopConfig,
  updateShopSettings,
} from '@shopquote/db';

import { actorOf, OWNER_OR_ADMIN } from '../auth/guard.js';
import type { AppContext } from '../context.js';
import { parse } from '../problem.js';
import { asOfQuery, importQuery, shopSettingsBody } from '../schemas.js';

/** A config file for a whole catalog with its history is a few hundred KB;
 *  Fastify's 1 MB default is too near for comfort. */
const IMPORT_BODY_LIMIT = 16 * 1024 * 1024;

export function configRoutes(ctx: AppContext) {
  return async (app: FastifyInstance): Promise<void> => {
    const writers = { config: { access: OWNER_OR_ADMIN } };

    app.get('/', async (request) => {
      const { asOf } = parse(asOfQuery, request.query, 'query string');
      return loadShopConfig(ctx.db.db, ctx.shopId, asOf ?? ctx.now());
    });

    app.put('/', writers, async (request) => {
      const settings = parse(shopSettingsBody, request.body);
      return updateShopSettings(ctx.db, ctx.shopId, settings, actorOf(request));
    });

    app.get('/export', writers, async (_request, reply) => {
      const now = ctx.now();
      const document = exportShopConfig(ctx.db.db, ctx.shopId, now);
      const shop = document.config.defaults.shopName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const day = now.toISOString().slice(0, 10);
      return reply
        .header(
          'content-disposition',
          `attachment; filename="shopquote-config-${shop}-${day}.json"`,
        )
        .send(document);
    });

    app.post('/import', { ...writers, bodyLimit: IMPORT_BODY_LIMIT }, async (request) => {
      const { dryRun } = parse(importQuery, request.query, 'query string');
      const document = parse(configDocumentSchema, request.body);
      return importShopConfig(ctx.db, ctx.shopId, document, {
        actor: actorOf(request),
        at: ctx.now(),
        dryRun,
      });
    });
  };
}
