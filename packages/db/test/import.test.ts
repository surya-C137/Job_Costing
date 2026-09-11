import { and, eq, isNotNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import type { Actor } from '../src/audit.js';
import { addMaterialPrice, archiveMaterial, createMaterial } from '../src/catalog.js';
import { loadPriceHistory, loadShopConfig } from '../src/config.js';
import {
  configDocumentSchema,
  exportShopConfig,
  importShopConfig,
  type ConfigDocument,
} from '../src/config-document.js';
import { openMigratedMemoryDatabase, type DatabaseHandle } from '../src/db.js';
import { auditLog, materialFamilies } from '../src/schema.js';
import { seedBlankShop } from '../src/seed-blank.js';
import { seedWorkbookShop } from '../src/seed.js';
import { listUsers } from '../src/users.js';
import { canonicalise } from './helpers/canonical.js';

/**
 * The config JSON (§4 FR-1: "import/export the whole config as JSON — this is
 * how the next shop starts"; §8: schemaVersion 1).
 *
 * The round trips are the point. Export a shop and import it into a blank one:
 * the catalog comes back entity for entity, price history included. Import a
 * shop's own export: nothing moves at all — the property that makes import
 * safe to press twice.
 */

interface Shop {
  handle: DatabaseHandle;
  shopId: string;
  actor: Actor;
}

async function workbookShop(): Promise<Shop> {
  const handle = openMigratedMemoryDatabase();
  const { shopId } = await seedWorkbookShop(handle, { adminPassword: 'test' });
  return withAdmin(handle, shopId);
}

async function blankShop(): Promise<Shop> {
  const handle = openMigratedMemoryDatabase();
  const { shopId } = await seedBlankShop(handle, { shopName: 'Second Shop', adminPassword: 'x' });
  return withAdmin(handle, shopId);
}

function withAdmin(handle: DatabaseHandle, shopId: string): Shop {
  const [admin] = listUsers(handle.db, shopId);
  if (admin === undefined) throw new Error('the seed made no admin');
  return { handle, shopId, actor: { userId: admin.id } };
}

/** What a file on disk or an HTTP body does to a document — dates become
 *  strings — and then the validation the API applies on the way in. */
function throughJson(document: ConfigDocument): ConfigDocument {
  return configDocumentSchema.parse(JSON.parse(JSON.stringify(document)));
}

/** Price history with material ids replaced by names, for comparing across
 *  databases (§7 re-issues ids). */
function historyByName(document: ConfigDocument): unknown[] {
  const names = new Map(document.config.materials.map((m) => [m.id, m.name]));
  return (document.priceHistory ?? [])
    .map((v) => ({
      ...v,
      materialId: names.get(v.materialId),
      effectiveFrom: v.effectiveFrom.toISOString(),
    }))
    .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
}

const CRS = 'CRS 16 GA (.0598)';

function materialId(shop: Shop, name: string): string {
  const found = loadShopConfig(shop.handle.db, shop.shopId).materials.find((m) => m.name === name);
  if (found === undefined) throw new Error(`no "${name}"`);
  return found.id;
}

describe('export', () => {
  it('carries every price version, not only the one in force (FR-1, §7)', async () => {
    const shop = await workbookShop();
    const crs = materialId(shop, CRS);
    addMaterialPrice(
      shop.handle,
      shop.shopId,
      crs,
      {
        pricePerLbUsd: 0.62,
        sheetCostUsd: null,
        sheetLbs: null,
        effectiveFrom: new Date('2026-06-01T00:00:00Z'),
        note: 'tariff',
      },
      shop.actor,
    );

    const document = exportShopConfig(
      shop.handle.db,
      shop.shopId,
      new Date('2026-07-01T00:00:00Z'),
    );
    const versions = (document.priceHistory ?? []).filter((v) => v.materialId === crs);
    expect(versions).toHaveLength(2);
    expect(versions[0]?.pricePerLbUsd).toBeCloseTo(0.41, 4);
    expect(versions[1]?.pricePerLbUsd).toBe(0.62);
    expect(document.config.materials.find((m) => m.id === crs)?.pricePerLbUsd).toBe(0.62);
    shop.handle.close();
  });

  it('survives JSON and passes its own schema', async () => {
    const shop = await workbookShop();
    const document = throughJson(exportShopConfig(shop.handle.db, shop.shopId));
    expect(document.schemaVersion).toBe(1);
    expect(document.exportedAt).toBeInstanceOf(Date);
    expect(document.config.materials.length).toBeGreaterThanOrEqual(80);
    shop.handle.close();
  });
});

describe('import', () => {
  it('changes nothing when a shop imports its own export', async () => {
    const shop = await workbookShop();
    const at = new Date();
    const before = loadShopConfig(shop.handle.db, shop.shopId, at);
    const document = throughJson(exportShopConfig(shop.handle.db, shop.shopId, at));

    const result = importShopConfig(shop.handle, shop.shopId, document, { actor: shop.actor });

    expect(result.totals).toEqual({ inserted: 0, updated: 0, archived: 0 });
    // Ids and all: matching on id is what keeps open quotes pointing at the
    // rows they were entered against.
    expect(loadShopConfig(shop.handle.db, shop.shopId, at)).toEqual(before);
    shop.handle.close();
  });

  it('loads one shop’s export into a blank shop, and gives it back unchanged', async () => {
    const source = await workbookShop();
    const target = await blankShop();
    const exported = throughJson(exportShopConfig(source.handle.db, source.shopId));

    const result = importShopConfig(target.handle, target.shopId, exported, {
      actor: target.actor,
    });
    expect(result.totals.inserted).toBeGreaterThan(0);

    const reexported = exportShopConfig(target.handle.db, target.shopId);
    expect(canonicalise(reexported.config)).toEqual(canonicalise(exported.config));
    expect(historyByName(reexported)).toEqual(historyByName(exported));

    // The blank shop's reference families were archived, not deleted (§7):
    // they make way for the file's, under live-only uniqueness.
    const archivedFamilies = target.handle.db
      .select()
      .from(materialFamilies)
      .where(
        and(eq(materialFamilies.shopId, target.shopId), isNotNull(materialFamilies.archivedAt)),
      )
      .all();
    expect(archivedFamilies.length).toBe(4);
    expect(result.changes['material_families']?.archived).toBe(4);

    source.handle.close();
    target.handle.close();
  });

  it('prices §9 identically after the trip', async () => {
    // The config is the thing the golden test prices; an import that bent a
    // single rate would show up in canonicalise() above. This is the cheaper
    // spot-check that the file carries the parity flags too.
    const source = await workbookShop();
    const target = await blankShop();
    importShopConfig(
      target.handle,
      target.shopId,
      throughJson(exportShopConfig(source.handle.db, source.shopId)),
      { actor: target.actor },
    );
    expect(loadShopConfig(target.handle.db, target.shopId).parity).toEqual({
      markupInsideMinChargeMax: true,
      machineTimeFactor: 0.6,
      legacyCoatingModel: true,
      finishesUnmarked: true,
    });
    source.handle.close();
    target.handle.close();
  });

  it('can say what it would change without changing it', async () => {
    const source = await workbookShop();
    const target = await blankShop();
    const before = canonicalise(loadShopConfig(target.handle.db, target.shopId));

    const result = importShopConfig(
      target.handle,
      target.shopId,
      throughJson(exportShopConfig(source.handle.db, source.shopId)),
      { actor: target.actor, dryRun: true },
    );

    expect(result.dryRun).toBe(true);
    expect(result.totals.inserted).toBeGreaterThan(0);
    expect(canonicalise(loadShopConfig(target.handle.db, target.shopId))).toEqual(before);
    const logged = target.handle.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'config.import'))
      .all();
    expect(logged).toEqual([]);
    source.handle.close();
    target.handle.close();
  });

  it('brings back what was removed since the export, and removes what was added', async () => {
    const shop = await workbookShop();
    const document = throughJson(exportShopConfig(shop.handle.db, shop.shopId));
    const before = loadShopConfig(shop.handle.db, shop.shopId);
    const crs = before.materials.find((m) => m.name === CRS);
    if (crs === undefined) throw new Error('no CRS');

    archiveMaterial(shop.handle, shop.shopId, crs.id, shop.actor);
    const added = createMaterial(
      shop.handle,
      shop.shopId,
      {
        name: 'ACRYLIC .250 CLEAR',
        familyId: crs.familyId,
        form: 'sheet',
        thicknessIn: 0.25,
        lbPerSqFt: 1.5,
        surchargePct: 0,
        scrapPricePerLbUsd: 0,
        standardLengthIn: 96,
        aliases: [],
        active: true,
      },
      shop.actor,
    );

    const result = importShopConfig(shop.handle, shop.shopId, document, { actor: shop.actor });

    const after = loadShopConfig(shop.handle.db, shop.shopId);
    expect(after.materials.find((m) => m.id === crs.id)?.name).toBe(CRS);
    expect(after.materials.find((m) => m.id === added.id)).toBeUndefined();
    expect(result.changes['materials']).toEqual({ inserted: 0, updated: 1, archived: 1 });
    // Its machine rates come back with it.
    const rates = (c: typeof after) =>
      c.machineMaterialRates.filter((r) => r.materialId === crs.id);
    expect(rates(after)).toHaveLength(rates(before).length);
    shop.handle.close();
  });

  it('refuses a file whose prices and price history disagree', async () => {
    const shop = await workbookShop();
    const raw = JSON.parse(JSON.stringify(exportShopConfig(shop.handle.db, shop.shopId))) as {
      config: { materials: { pricePerLbUsd: number | null }[] };
    };
    const i = raw.config.materials.findIndex((m) => m.pricePerLbUsd !== null);
    const row = raw.config.materials[i];
    if (row === undefined) throw new Error('no priced material');
    row.pricePerLbUsd = 9.99;

    const parsed = configDocumentSchema.safeParse(raw);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path.join('.'))).toContain(
      `config.materials.${i}.pricePerLbUsd`,
    );
    shop.handle.close();
  });

  it('dates the prices of a file without a history at the moment of import', async () => {
    const shop = await workbookShop();
    const exported = exportShopConfig(shop.handle.db, shop.shopId);
    const handWritten = configDocumentSchema.parse({
      ...exported,
      exportedAt: null,
      priceHistory: null,
      config: {
        ...exported.config,
        materials: exported.config.materials.map((m) =>
          m.name === CRS ? { ...m, pricePerLbUsd: 0.66, sheetCostUsd: null, sheetLbs: null } : m,
        ),
      },
    });
    const at = new Date('2026-08-01T00:00:00Z');

    const result = importShopConfig(shop.handle, shop.shopId, handWritten, {
      actor: shop.actor,
      at,
    });

    // One changed price, one new version; the other 65 were already in force.
    expect(result.changes['material_prices']?.inserted).toBe(1);
    const history = loadPriceHistory(shop.handle.db, shop.shopId, materialId(shop, CRS));
    expect(history.at(-1)?.pricePerLbUsd).toBe(0.66);
    expect(history.at(-1)?.effectiveFrom).toEqual(at);
    shop.handle.close();
  });

  it('logs the import with what it changed', async () => {
    const source = await workbookShop();
    const target = await blankShop();
    importShopConfig(
      target.handle,
      target.shopId,
      throughJson(exportShopConfig(source.handle.db, source.shopId)),
      { actor: target.actor },
    );
    const entry = target.handle.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'config.import'))
      .get();
    expect(entry?.actorUserId).toBe(target.actor.userId);
    expect(entry?.summary).toMatch(/^Imported "ShopQuote": \d+ added, \d+ changed, \d+ archived$/);
    source.handle.close();
    target.handle.close();
  });
});
