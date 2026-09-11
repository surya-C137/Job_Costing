/**
 * The catalogs an owner edits a row at a time (§4 FR-1; BUILD-PLAN 3.1):
 *
 *   /api/materials              + GET /:id/prices, POST /:id/price
 *   /api/operations
 *   /api/plating-specs
 *   /api/coating-models
 *   /api/silkscreen-tiers
 *   /api/assembly-standards
 *
 * Each is GET (list), GET /:id, POST, PUT /:id, DELETE /:id — where DELETE
 * archives (§7: nothing is hard-deleted). Paths are the `ShopConfig` keys in
 * kebab case, so a list here is exactly the array `GET /api/config` carries.
 *
 * Reads go through `loadShopConfig()`, never a table (the rule `@shopquote/db`
 * states once): what the list shows is what the engine would price with.
 *
 * **Prices.** A material's $/lb is not a field you edit: each change is a new
 * version (§7), posted to `/api/materials/:id/price`, and the old one stays
 * for the quotes that used it. A PUT that tries to carry a price is refused
 * with directions rather than silently ignored.
 */

import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';

import type { ShopConfig } from '@shopquote/calc';
import {
  addMaterialPrice,
  archiveAssemblyStandard,
  archiveCoatingModel,
  archiveMaterial,
  archiveOperation,
  archivePlatingSpec,
  archiveSilkscreenTier,
  createAssemblyStandard,
  createCoatingModel,
  createMaterial,
  createOperation,
  createPlatingSpec,
  createSilkscreenTier,
  loadShopConfig,
  materialPriceHistory,
  updateAssemblyStandard,
  updateCoatingModel,
  updateMaterial,
  updateOperation,
  updatePlatingSpec,
  updateSilkscreenTier,
  type Actor,
  type DatabaseHandle,
} from '@shopquote/db';

import { actorOf, OWNER_OR_ADMIN } from '../auth/guard.js';
import type { AppContext } from '../context.js';
import { parse, problems } from '../problem.js';
import {
  assemblyBody,
  coatingBody,
  idParams,
  materialBody,
  materialCreateBody,
  operationBody,
  platingBody,
  PRICE_FIELDS,
  priceBody,
  silkscreenBody,
} from '../schemas.js';

type Schema<T> = z.ZodType<T, z.ZodTypeDef, unknown>;

interface Catalog<C, U, E extends { id: string }> {
  path: string;
  noun: string;
  list: (config: ShopConfig) => readonly E[];
  createBody: Schema<C>;
  updateBody: Schema<U>;
  create: (handle: DatabaseHandle, shopId: string, input: C, actor: Actor) => E;
  update: (handle: DatabaseHandle, shopId: string, id: string, input: U, actor: Actor) => E;
  archive: (handle: DatabaseHandle, shopId: string, id: string, actor: Actor) => void;
  /** Refuse a body before it is parsed, with a better message than a schema's. */
  screenUpdate?: (body: unknown) => void;
}

function register<C, U, E extends { id: string }>(
  app: FastifyInstance,
  ctx: AppContext,
  catalog: Catalog<C, U, E>,
): void {
  const writers = { config: { access: OWNER_OR_ADMIN } };
  const base = `/${catalog.path}`;
  const current = (): readonly E[] =>
    catalog.list(loadShopConfig(ctx.db.db, ctx.shopId, ctx.now()));

  app.get(base, async () => current());

  app.get(`${base}/:id`, async (request) => {
    const { id } = parse(idParams, request.params, 'path');
    const found = current().find((e) => e.id === id);
    if (found === undefined) throw problems.notFound(`No ${catalog.noun} ${id} in this shop.`);
    return found;
  });

  app.post(base, writers, async (request, reply) => {
    const input = parse(catalog.createBody, request.body);
    const created = catalog.create(ctx.db, ctx.shopId, input, actorOf(request));
    return reply.code(201).header('location', `/api${base}/${created.id}`).send(created);
  });

  app.put(`${base}/:id`, writers, async (request) => {
    const { id } = parse(idParams, request.params, 'path');
    catalog.screenUpdate?.(request.body);
    const input = parse(catalog.updateBody, request.body);
    return catalog.update(ctx.db, ctx.shopId, id, input, actorOf(request));
  });

  app.delete(`${base}/:id`, writers, async (request, reply) => {
    const { id } = parse(idParams, request.params, 'path');
    catalog.archive(ctx.db, ctx.shopId, id, actorOf(request));
    return reply.code(204).send();
  });
}

export function catalogRoutes(ctx: AppContext) {
  return async (app: FastifyInstance): Promise<void> => {
    const writers = { config: { access: OWNER_OR_ADMIN } };

    register(app, ctx, {
      path: 'materials',
      noun: 'material',
      list: (config) => config.materials,
      createBody: materialCreateBody,
      updateBody: materialBody,
      create: (handle, shopId, { price, ...input }, actor) =>
        createMaterial(
          handle,
          shopId,
          input,
          actor,
          price === undefined
            ? undefined
            : { ...price, effectiveFrom: price.effectiveFrom ?? ctx.now() },
        ),
      update: updateMaterial,
      archive: archiveMaterial,
      screenUpdate: (body) => {
        if (typeof body !== 'object' || body === null) return;
        const field = PRICE_FIELDS.find((f) => f in body);
        if (field !== undefined) {
          throw problems.invalid(
            `/${field}`,
            'Prices are versioned, never edited in place (§7). ' +
              'Post the new price to POST /api/materials/:id/price; the old one stays for the quotes that used it.',
          );
        }
      },
    });

    app.get('/materials/:id/prices', async (request) => {
      const { id } = parse(idParams, request.params, 'path');
      return materialPriceHistory(ctx.db.db, ctx.shopId, id);
    });

    app.post('/materials/:id/price', writers, async (request, reply) => {
      const { id } = parse(idParams, request.params, 'path');
      const body = parse(priceBody, request.body);
      const version = addMaterialPrice(
        ctx.db,
        ctx.shopId,
        id,
        { ...body, effectiveFrom: body.effectiveFrom ?? ctx.now() },
        actorOf(request),
      );
      return reply.code(201).send(version);
    });

    register(app, ctx, {
      path: 'operations',
      noun: 'operation',
      list: (config) => config.operations,
      createBody: operationBody,
      updateBody: operationBody,
      create: createOperation,
      update: updateOperation,
      archive: archiveOperation,
    });

    register(app, ctx, {
      path: 'plating-specs',
      noun: 'plating spec',
      list: (config) => config.platingSpecs,
      createBody: platingBody,
      updateBody: platingBody,
      create: createPlatingSpec,
      update: updatePlatingSpec,
      archive: archivePlatingSpec,
    });

    register(app, ctx, {
      path: 'coating-models',
      noun: 'coating model',
      list: (config) => config.coatingModels,
      createBody: coatingBody,
      updateBody: coatingBody,
      create: createCoatingModel,
      update: updateCoatingModel,
      archive: archiveCoatingModel,
    });

    register(app, ctx, {
      path: 'silkscreen-tiers',
      noun: 'silkscreen tier',
      list: (config) => config.silkscreenTiers,
      createBody: silkscreenBody,
      updateBody: silkscreenBody,
      create: createSilkscreenTier,
      update: updateSilkscreenTier,
      archive: archiveSilkscreenTier,
    });

    register(app, ctx, {
      path: 'assembly-standards',
      noun: 'assembly standard',
      list: (config) => config.assemblyStandards,
      createBody: assemblyBody,
      updateBody: assemblyBody,
      create: createAssemblyStandard,
      update: updateAssemblyStandard,
      archive: archiveAssemblyStandard,
    });
  };
}
