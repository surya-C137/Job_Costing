import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { shopConfigFromSeed, type ShopConfig } from '@shopquote/calc';

import { canonicalJson, configHash, loadShopConfig } from '../src/config.js';
import { openMigratedMemoryDatabase, type DatabaseHandle } from '../src/db.js';
import { coatingModels, materialPrices, materials, operations } from '../src/schema.js';
import { readSeedBundle } from '../src/seed-files.js';
import { blankShopConfig, seedBlankShop } from '../src/seed-blank.js';
import { seedWorkbookShop, WORKBOOK_PRICE_VINTAGE } from '../src/seed.js';
import { canonicalise } from './helpers/canonical.js';

/**
 * `loadShopConfig()` — the inverse of `writeShopConfig()` (BUILD-PLAN 2.2).
 *
 * The golden case through this path lives in `golden.test.ts`. What is here is
 * the property that makes it more than a coincidence: what comes back out is
 * what went in, entity for entity and field for field, with only the ids
 * changed — plus the two things the round trip *deliberately* does not
 * preserve, prices before their effective date and archived rows.
 *
 * `canonicalise()` — ids replaced by names so two configs from different
 * databases can be compared — lives in `helpers/canonical.ts`, shared with the
 * config-import round trip.
 */

const AFTER_SEED = new Date(WORKBOOK_PRICE_VINTAGE.getTime() + 86_400_000);

async function seeded(): Promise<{ handle: DatabaseHandle; shopId: string }> {
  const handle = openMigratedMemoryDatabase();
  const { shopId } = await seedWorkbookShop(handle, { adminPassword: 'test' });
  return { handle, shopId };
}

describe('loadShopConfig', () => {
  it('gives back the config the seed put in, entity for entity', async () => {
    const { handle, shopId } = await seeded();
    try {
      const written = shopConfigFromSeed(readSeedBundle(), { shopId, shopName: 'ShopQuote' });
      const loaded = loadShopConfig(handle.db, shopId, AFTER_SEED);
      // The one number that legitimately differs: the seed adapter has no
      // opinion about ULIDs, so `shopId` is compared separately.
      expect(loaded.shopId).toBe(shopId);
      expect(canonicalise(loaded)).toEqual(canonicalise(written));
    } finally {
      handle.close();
    }
  });

  it('resolves each material to the price version in force at asOf (§7)', async () => {
    const { handle, shopId } = await seeded();
    try {
      const crs = handle.db
        .select()
        .from(materials)
        .where(eq(materials.name, 'CRS 16 GA (.0598)'))
        .get();
      if (crs === undefined) throw new Error('no CRS 16 GA in the seeded catalog');

      const raised = new Date('2026-06-01T00:00:00Z');
      handle.db
        .insert(materialPrices)
        .values({
          shopId,
          materialId: crs.id,
          pricePerLbUsd: 0.62,
          effectiveFrom: raised,
          note: 'tariff',
        })
        .run();

      const priceOn = (asOf: Date): number | null => {
        const row = loadShopConfig(handle.db, shopId, asOf).materials.find((m) => m.id === crs.id);
        return row?.pricePerLbUsd ?? null;
      };

      // The day before the rise, the quote still prices at the old number —
      // which is what makes re-pricing an explicit act rather than a surprise.
      expect(priceOn(new Date(raised.getTime() - 1))).toBeCloseTo(0.41, 4);
      expect(priceOn(raised)).toBe(0.62);
      expect(priceOn(new Date('2027-01-01T00:00:00Z'))).toBe(0.62);
      // Before any version exists, the material has no price at all rather
      // than a free one (§12 rule 3).
      expect(priceOn(new Date('2020-01-01T00:00:00Z'))).toBeNull();
    } finally {
      handle.close();
    }
  });

  it('carries a material with no price version as null, not zero', async () => {
    const { handle, shopId } = await seeded();
    try {
      const config = loadShopConfig(handle.db, shopId, AFTER_SEED);
      const brushed = config.materials.filter((m) => m.name.startsWith('ST STL #4B'));
      expect(brushed.length).toBe(14);
      for (const row of brushed) {
        expect(row.pricePerLbUsd).toBeNull();
      }
    } finally {
      handle.close();
    }
  });

  it('leaves archived rows out of the catalog (§7 soft delete)', async () => {
    const { handle, shopId } = await seeded();
    try {
      const before = loadShopConfig(handle.db, shopId, AFTER_SEED);
      const victim = before.operations.find((o) => o.name === 'TUMBLE DEBURR');
      if (victim === undefined) throw new Error('no TUMBLE DEBURR operation seeded');

      handle.db
        .update(operations)
        .set({ archivedAt: new Date() })
        .where(eq(operations.id, victim.id))
        .run();

      const after = loadShopConfig(handle.db, shopId, AFTER_SEED);
      expect(after.operations).toHaveLength(before.operations.length - 1);
      expect(after.operations.find((o) => o.id === victim.id)).toBeUndefined();
    } finally {
      handle.close();
    }
  });

  it('keeps an inactive row in the catalog — inactive is not deleted', async () => {
    const { handle, shopId } = await seeded();
    try {
      const config = loadShopConfig(handle.db, shopId, AFTER_SEED);
      const first = config.materials[0];
      if (first === undefined) throw new Error('empty catalog');

      handle.db.update(materials).set({ active: false }).where(eq(materials.id, first.id)).run();

      const after = loadShopConfig(handle.db, shopId, AFTER_SEED);
      const row = after.materials.find((m) => m.id === first.id);
      // Still there, still quotable, but the estimator gets an amber note if a
      // part is on it (`material-inactive`).
      expect(row?.active).toBe(false);
    } finally {
      handle.close();
    }
  });

  it('refuses to invent a shop that is not there', async () => {
    const handle = openMigratedMemoryDatabase();
    try {
      expect(() => loadShopConfig(handle.db, 'no-such-shop')).toThrow(/No shop no-such-shop/);
    } finally {
      handle.close();
    }
  });

  it('brings a blank shop back with its gauge tables and aliases (§8)', async () => {
    const handle = openMigratedMemoryDatabase();
    try {
      const { shopId } = await seedBlankShop(handle, { shopName: 'Acme', adminPassword: 'test' });
      const written = blankShopConfig(shopId, { shopName: 'Acme' });
      const loaded = loadShopConfig(handle.db, shopId);

      expect(canonicalise(loaded)).toEqual(canonicalise(written));

      // The half of a config the workbook shop has none of: gauge rows, and
      // the aliases the intake resolver matches a drawing against.
      const steel = loaded.families.find((f) => f.name === 'Steel');
      expect(steel?.aliases).toContain('CRS');
      expect(steel?.aliases).toEqual([...(steel?.aliases ?? [])].sort());
      expect(loaded.gauges.filter((g) => g.familyId === steel?.id).length).toBeGreaterThan(20);
      expect(loaded.materials).toHaveLength(0);
    } finally {
      handle.close();
    }
  });

  it('breaks a same-day price tie on the row entered last', async () => {
    const { handle, shopId } = await seeded();
    try {
      const crs = handle.db
        .select()
        .from(materials)
        .where(eq(materials.name, 'CRS 16 GA (.0598)'))
        .get();
      if (crs === undefined) throw new Error('no CRS 16 GA in the seeded catalog');

      // Someone fat-fingers a price and re-enters it the same afternoon, with
      // the same effective date. The correction is the one that counts.
      const sameDay = new Date('2026-05-01T00:00:00Z');
      for (const price of [0.71, 0.68]) {
        handle.db
          .insert(materialPrices)
          .values({ shopId, materialId: crs.id, pricePerLbUsd: price, effectiveFrom: sameDay })
          .run();
      }

      const config = loadShopConfig(handle.db, shopId, new Date('2026-05-02T00:00:00Z'));
      expect(config.materials.find((m) => m.id === crs.id)?.pricePerLbUsd).toBe(0.68);
    } finally {
      handle.close();
    }
  });

  /**
   * Parity flag Q3's other side. The workbook has no source for any of the
   * powder parameters (§10 q2), so the seed leaves them null and the engine
   * warns rather than pricing coating at zero (§11.3). Once an owner fills
   * them in, they have to survive the round trip — otherwise turning Q3 off
   * silently goes back to warning.
   */
  it('brings the modern coating parameters back once an owner sets them', async () => {
    const { handle, shopId } = await seeded();
    try {
      const powder = loadShopConfig(handle.db, shopId, AFTER_SEED).coatingModels.find((c) =>
        c.name.startsWith('Powder'),
      );
      if (powder === undefined) throw new Error('no powder model seeded');
      expect(powder.modern).toBeNull();
      expect(powder.legacy).toEqual({ rateUsd: 0.5, coverage: 100, sConstant: 5 });

      handle.db
        .update(coatingModels)
        .set({
          modernSpecificGravity: 1.5,
          modernFilmThicknessMils: 2,
          modernTransferEfficiency: 0.6,
          modernPowderPricePerLbUsd: 5,
          modernRackLaborUsdPerPart: 0.1,
          modernMaskingUsdPerFeature: 0.25,
        })
        .where(eq(coatingModels.id, powder.id))
        .run();

      const after = loadShopConfig(handle.db, shopId, AFTER_SEED).coatingModels.find(
        (c) => c.id === powder.id,
      );
      expect(after?.modern).toEqual({
        specificGravity: 1.5,
        filmThicknessMils: 2,
        transferEfficiency: 0.6,
        powderPricePerLbUsd: 5,
        rackLaborUsdPerPart: 0.1,
        maskingUsdPerFeature: 0.25,
      });
    } finally {
      handle.close();
    }
  });

  it('treats a half-filled model group as unconfigured, not as a price', async () => {
    const { handle, shopId } = await seeded();
    try {
      const powder = loadShopConfig(handle.db, shopId, AFTER_SEED).coatingModels.find((c) =>
        c.name.startsWith('Powder'),
      );
      if (powder === undefined) throw new Error('no powder model seeded');

      // Specific gravity entered, film build and the rest still blank. Pricing
      // off whichever constants happened to be there is exactly the `else → 0`
      // hole §11.3 forbids, so the group stays null and the engine warns.
      handle.db
        .update(coatingModels)
        .set({ modernSpecificGravity: 1.5 })
        .where(eq(coatingModels.id, powder.id))
        .run();

      const after = loadShopConfig(handle.db, shopId, AFTER_SEED).coatingModels.find(
        (c) => c.id === powder.id,
      );
      expect(after?.modern).toBeNull();
    } finally {
      handle.close();
    }
  });

  it('names the machine hit rates against the machine that owns them', async () => {
    const { handle, shopId } = await seeded();
    try {
      const config = loadShopConfig(handle.db, shopId, AFTER_SEED);
      const punch = config.machines.find((m) => m.timeModel === 'hitBased');
      const laser = config.machines.find((m) => m.timeModel === 'featureBased');
      expect(punch?.hitRates).toHaveLength(10);
      expect(laser?.hitRates).toHaveLength(0);
    } finally {
      handle.close();
    }
  });
});

describe('canonicalJson and configHash', () => {
  it('hashes the same config the same however its keys were ordered', async () => {
    const { handle, shopId } = await seeded();
    try {
      const a = loadShopConfig(handle.db, shopId, AFTER_SEED);
      // Same config, keys written in a different order — which is what a
      // JSON round trip through the API or an import file does to it.
      const shuffled = Object.fromEntries(
        Object.entries(a as unknown as Record<string, unknown>).reverse(),
      ) as unknown as ShopConfig;
      expect(configHash(shuffled)).toBe(configHash(a));
    } finally {
      handle.close();
    }
  });

  it('hashes a changed rate differently', async () => {
    const { handle, shopId } = await seeded();
    try {
      const a = loadShopConfig(handle.db, shopId, AFTER_SEED);
      const b: ShopConfig = { ...a, defaults: { ...a.defaults, laborMarkup: 1.25 } };
      expect(configHash(b)).not.toBe(configHash(a));
    } finally {
      handle.close();
    }
  });

  it('keeps array order, because order is data', async () => {
    expect(canonicalJson({ breaks: [1, 5, 10] })).toBe('{"breaks":[1,5,10]}');
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJson(null)).toBe('null');
  });
});
