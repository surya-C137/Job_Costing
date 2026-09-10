import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { shopConfigFromSeed, type ShopConfig } from '@shopquote/calc';

import { canonicalJson, configHash, loadShopConfig } from '../src/config.js';
import { openMigratedMemoryDatabase, type DatabaseHandle } from '../src/db.js';
import { coatingModels, materialPrices, materials, operations } from '../src/schema.js';
import { readSeedBundle } from '../src/seed-files.js';
import { blankShopConfig, seedBlankShop } from '../src/seed-blank.js';
import { seedWorkbookShop, WORKBOOK_PRICE_VINTAGE } from '../src/seed.js';

/**
 * `loadShopConfig()` — the inverse of `writeShopConfig()` (BUILD-PLAN 2.2).
 *
 * The golden case through this path lives in `golden.test.ts`. What is here is
 * the property that makes it more than a coincidence: what comes back out is
 * what went in, entity for entity and field for field, with only the ids
 * changed — plus the two things the round trip *deliberately* does not
 * preserve, prices before their effective date and archived rows.
 */

const AFTER_SEED = new Date(WORKBOOK_PRICE_VINTAGE.getTime() + 86_400_000);

function seeded(): { handle: DatabaseHandle; shopId: string } {
  const handle = openMigratedMemoryDatabase();
  const { shopId } = seedWorkbookShop(handle, { adminPassword: 'test' });
  return { handle, shopId };
}

/**
 * A `ShopConfig` with every id replaced by something stable across a round
 * trip, and every list in a fixed order.
 *
 * §7 re-issues ids as ULIDs on the way into the database, so a config that came
 * back out can never be `toEqual` one that went in. Names are what an estimator
 * and an exported config JSON identify a row by, so names are what this
 * compares — which also means a rename would show up as a difference, correctly.
 */
function canonicalise(config: ShopConfig): unknown {
  const names = new Map<string, string>();
  for (const f of config.families) names.set(f.id, `family:${f.name}`);
  for (const m of config.materials) names.set(m.id, `material:${m.name}`);
  for (const m of config.machines) names.set(m.id, `machine:${m.name}`);
  for (const m of config.machines) {
    for (const h of m.hitRates) names.set(h.id, `tool:${m.name}/${h.name}`);
  }
  for (const o of config.operations) names.set(o.id, `operation:${o.name}/${o.standardPerHr}`);
  for (const p of config.platingSpecs) names.set(p.id, `plating:${p.name}`);
  for (const c of config.coatingModels) names.set(c.id, `coating:${c.name}`);
  for (const s of config.silkscreenTiers) names.set(s.id, `silkscreen:${s.name}`);
  for (const a of config.assemblyStandards) names.set(a.id, `assembly:${a.section}/${a.action}`);

  const ref = (id: string | null): string | null =>
    id === null ? null : (names.get(id) ?? `UNRESOLVED:${id}`);

  // These two are identified by what they point at, so they can only be named
  // once the rows above have been.
  for (const g of config.gauges) names.set(g.id, `gauge:${ref(g.familyId)}/${g.label}`);
  for (const s of config.stockSizes) {
    const owner = ref(s.materialId) ?? ref(s.familyId);
    names.set(s.id, `stock:${owner}/${s.lengthIn}x${s.widthIn}`);
  }

  // Aliases are a set, not a list: `loadShopConfig` sorts them and the
  // declaration order they were written in means nothing. Everything else
  // keeps its order, because order elsewhere is data.
  const sortAliases = <T>(row: T): T =>
    'aliases' in (row as object)
      ? { ...row, aliases: [...(row as { aliases: string[] }).aliases].sort() }
      : row;

  const withIds = <T extends { id: string }>(rows: T[]): unknown[] =>
    rows.map((r) => sortAliases({ ...r, id: ref(r.id) })).sort(sortByJson);

  return {
    schemaVersion: config.schemaVersion,
    defaults: config.defaults,
    parity: config.parity,
    enabledModules: [...config.enabledModules],
    families: withIds(config.families),
    gauges: config.gauges
      .map((g) => ({ ...g, id: ref(g.id), familyId: ref(g.familyId) }))
      .sort(sortByJson),
    materials: config.materials
      .map((m) => sortAliases({ ...m, id: ref(m.id), familyId: ref(m.familyId) }))
      .sort(sortByJson),
    stockSizes: config.stockSizes
      .map((s) => ({
        ...s,
        id: ref(s.id),
        materialId: ref(s.materialId),
        familyId: ref(s.familyId),
      }))
      .sort(sortByJson),
    machines: config.machines
      .map((m) => ({ ...m, id: ref(m.id), hitRates: withIds(m.hitRates) }))
      .sort(sortByJson),
    machineMaterialRates: config.machineMaterialRates
      .map((r) => ({ ...r, machineId: ref(r.machineId), materialId: ref(r.materialId) }))
      .sort(sortByJson),
    operations: config.operations
      .map((o) => ({ ...o, id: ref(o.id), machineId: ref(o.machineId) }))
      .sort(sortByJson),
    platingSpecs: withIds(config.platingSpecs),
    coatingModels: withIds(config.coatingModels),
    silkscreenTiers: withIds(config.silkscreenTiers),
    assemblyStandards: withIds(config.assemblyStandards),
  };
}

function sortByJson(a: unknown, b: unknown): number {
  const x = canonicalJson(a);
  const y = canonicalJson(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

describe('loadShopConfig', () => {
  it('gives back the config the seed put in, entity for entity', () => {
    const { handle, shopId } = seeded();
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

  it('resolves each material to the price version in force at asOf (§7)', () => {
    const { handle, shopId } = seeded();
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

  it('carries a material with no price version as null, not zero', () => {
    const { handle, shopId } = seeded();
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

  it('leaves archived rows out of the catalog (§7 soft delete)', () => {
    const { handle, shopId } = seeded();
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

  it('keeps an inactive row in the catalog — inactive is not deleted', () => {
    const { handle, shopId } = seeded();
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

  it('refuses to invent a shop that is not there', () => {
    const handle = openMigratedMemoryDatabase();
    try {
      expect(() => loadShopConfig(handle.db, 'no-such-shop')).toThrow(/No shop no-such-shop/);
    } finally {
      handle.close();
    }
  });

  it('brings a blank shop back with its gauge tables and aliases (§8)', () => {
    const handle = openMigratedMemoryDatabase();
    try {
      const { shopId } = seedBlankShop(handle, { shopName: 'Acme', adminPassword: 'test' });
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

  it('breaks a same-day price tie on the row entered last', () => {
    const { handle, shopId } = seeded();
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
  it('brings the modern coating parameters back once an owner sets them', () => {
    const { handle, shopId } = seeded();
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

  it('treats a half-filled model group as unconfigured, not as a price', () => {
    const { handle, shopId } = seeded();
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

  it('names the machine hit rates against the machine that owns them', () => {
    const { handle, shopId } = seeded();
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
  it('hashes the same config the same however its keys were ordered', () => {
    const { handle, shopId } = seeded();
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

  it('hashes a changed rate differently', () => {
    const { handle, shopId } = seeded();
    try {
      const a = loadShopConfig(handle.db, shopId, AFTER_SEED);
      const b: ShopConfig = { ...a, defaults: { ...a.defaults, laborMarkup: 1.25 } };
      expect(configHash(b)).not.toBe(configHash(a));
    } finally {
      handle.close();
    }
  });

  it('keeps array order, because order is data', () => {
    expect(canonicalJson({ breaks: [1, 5, 10] })).toBe('{"breaks":[1,5,10]}');
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJson(null)).toBe('null');
  });
});
