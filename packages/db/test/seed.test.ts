import { and, eq, isNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { shopConfigFromSeed } from '@shopquote/calc';

import { openMigratedMemoryDatabase, type DatabaseHandle } from '../src/db.js';
import { verifyPassword } from '../src/password.js';
import {
  gaugeReference,
  machineMaterialRates,
  machines,
  materialPrices,
  materials,
  operations,
  punchHitRates,
  shops,
  stockSizes,
  users,
} from '../src/schema.js';
import { readSeedBundle } from '../src/seed-files.js';
import { seedWorkbookShop, WORKBOOK_PRICE_VINTAGE } from '../src/seed.js';

/**
 * BUILD-PLAN 2.1: `db:seed` loads the workbook extract into a fresh database.
 *
 * The assertions worth having here are about the *shape* the seed produces —
 * machines rather than process presets, speeds on the machine/material pairing,
 * one price version per priced material — because that shape is what Task 2.2
 * reads back and what the golden test then prices through. Numbers from the
 * workbook are not re-asserted: the oracle is seventeen values and it lives in
 * calc's golden test (§9).
 */

async function seeded(): Promise<DatabaseHandle> {
  const handle = openMigratedMemoryDatabase();
  await seedWorkbookShop(handle, { adminPassword: 'correct horse battery staple' });
  return handle;
}

describe('db:seed', () => {
  it('creates one shop with the workbook catalog', async () => {
    const handle = await seeded();
    try {
      const shop = handle.db.select().from(shops).get();
      expect(shop).toBeDefined();
      expect(shop?.calcSchemaVersion).toBe(1);
      expect(shop?.defaultQuantityBreaks).toEqual([1, 5, 10, 30, 50, 100]);

      // BUILD-PLAN 2.1's acceptance check: at least 80 materials, and the
      // operations table populated.
      expect(handle.db.select().from(materials).all().length).toBeGreaterThanOrEqual(80);
      expect(handle.db.select().from(operations).all().length).toBeGreaterThan(0);
    } finally {
      handle.close();
    }
  });

  it('turns the workbook’s two "process presets" into machines (§3)', async () => {
    const handle = await seeded();
    try {
      const rows = handle.db.select().from(machines).all();
      expect(rows.map((m) => m.name).sort()).toEqual(['Laser', 'Punch']);

      const laser = rows.find((m) => m.timeModel === 'featureBased');
      expect(laser?.clampStripIn).toBe(1);
      expect(laser?.kerfIn).toBe(0.5);
      // The §5.2 constants that used to be literals inside a formula.
      expect(laser?.intersectionSec).toBe(0.3);
      expect(laser?.rapidSecPerPierce).toBe(0.6);
      expect(laser?.palletChangeSec).toBe(60);
      expect(laser?.palletBatchParts).toBe(100);
      expect(laser?.lossFactor).toBe(1.08);

      // Ten tools, on the punch. "TOTAL HIT COUNT" is a spreadsheet subtotal,
      // not an eleventh tool (§5.3).
      const punch = rows.find((m) => m.timeModel === 'hitBased');
      const tools = handle.db
        .select()
        .from(punchHitRates)
        .where(eq(punchHitRates.machineId, punch?.id ?? ''))
        .all();
      expect(tools).toHaveLength(10);
    } finally {
      handle.close();
    }
  });

  it('moves speed, pierce and punch factor onto the machine×material pairing', async () => {
    const handle = await seeded();
    try {
      const materialColumns = handle.sqlite
        .prepare(`PRAGMA table_info(materials)`)
        .all()
        .map((c) => (c as { name: string }).name);
      // §3: no machine-specific numbers on a material row.
      expect(materialColumns).not.toContain('speed_in_min');
      expect(materialColumns).not.toContain('pierce_s');
      expect(materialColumns).not.toContain('punch_rate_factor');

      const g30 = handle.db
        .select()
        .from(materials)
        .where(eq(materials.name, 'G30 16 GA (.0598)'))
        .get();
      const laser = handle.db.select().from(machines).where(eq(machines.kind, 'laser')).get();
      const rate = handle.db
        .select()
        .from(machineMaterialRates)
        .where(
          and(
            eq(machineMaterialRates.machineId, laser?.id ?? ''),
            eq(machineMaterialRates.materialId, g30?.id ?? ''),
          ),
        )
        .get();

      expect(rate?.cutSpeedInPerMin).toBe(220);
      expect(rate?.pierceSeconds).toBe(0.1);
    } finally {
      handle.close();
    }
  });

  it('versions prices, and leaves unpriced stock unpriced (§7, §12 rule 3)', async () => {
    const handle = await seeded();
    try {
      const priced = handle.db.select().from(materialPrices).all();
      const all = handle.db.select().from(materials).all();

      expect(priced.length).toBeGreaterThan(0);
      expect(priced.length).toBeLessThan(all.length);
      for (const row of priced) {
        expect(row.effectiveFrom.getTime()).toBe(WORKBOOK_PRICE_VINTAGE.getTime());
      }

      // The brushed stainless range the workbook never priced gets no price
      // row at all — not a zero, which would quote free steel.
      const brushed = all.find((m) => m.name.startsWith('ST STL #4B'));
      expect(brushed).toBeDefined();
      const itsPrices = priced.filter((p) => p.materialId === brushed?.id);
      expect(itsPrices).toHaveLength(0);
    } finally {
      handle.close();
    }
  });

  it('writes exactly the rows the ShopConfig carries', async () => {
    const handle = await seeded();
    try {
      const config = shopConfigFromSeed(readSeedBundle());
      expect(handle.db.select().from(materials).all()).toHaveLength(config.materials.length);
      expect(handle.db.select().from(stockSizes).all()).toHaveLength(config.stockSizes.length);
      expect(handle.db.select().from(machineMaterialRates).all()).toHaveLength(
        config.machineMaterialRates.length,
      );
      expect(handle.db.select().from(operations).all()).toHaveLength(config.operations.length);
      // The workbook carries lb/ft² on every row and never looks a gauge up,
      // so there is nothing to seed here. `seed-blank` is where gauges come in.
      expect(handle.db.select().from(gaugeReference).all()).toHaveLength(0);
    } finally {
      handle.close();
    }
  });

  it('keeps both "BRAKE, BEND" rows, at 222/hr and 330/hr', async () => {
    const handle = await seeded();
    try {
      const bends = handle.db
        .select()
        .from(operations)
        .where(eq(operations.name, 'BRAKE, BEND'))
        .all();
      expect(bends).toHaveLength(2);
      expect(bends.map((b) => b.standardPerHr).sort((a, b) => Number(a) - Number(b))).toEqual([
        222, 330,
      ]);
    } finally {
      handle.close();
    }
  });

  it('records where every seeded row came from', async () => {
    const handle = await seeded();
    try {
      const orphans = handle.db.select().from(materials).where(isNull(materials.sourceKey)).all();
      expect(orphans).toHaveLength(0);

      const g30 = handle.db
        .select()
        .from(materials)
        .where(eq(materials.name, 'G30 16 GA (.0598)'))
        .get();
      expect(g30?.sourceKey).toBe('material:g30-16-ga-0598');
      // …but the stored id is a ULID, per §7.
      expect(g30?.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    } finally {
      handle.close();
    }
  });

  it('creates an admin whose password verifies and must be changed', async () => {
    const handle = await seeded();
    try {
      const admin = handle.db.select().from(users).get();
      expect(admin?.username).toBe('admin');
      expect(admin?.role).toBe('admin');
      expect(admin?.mustChangePassword).toBe(true);
      expect(admin?.passwordHash).not.toContain('correct horse');
      expect(await verifyPassword(admin?.passwordHash ?? '', 'correct horse battery staple')).toBe(
        true,
      );
      expect(await verifyPassword(admin?.passwordHash ?? '', 'wrong')).toBe(false);
    } finally {
      handle.close();
    }
  });

  it('generates a password when none is configured, and returns it once', async () => {
    const handle = openMigratedMemoryDatabase();
    try {
      const result = await seedWorkbookShop(handle);
      expect(result.generatedPassword).toBeDefined();
      expect(result.generatedPassword?.length).toBeGreaterThanOrEqual(16);
      const admin = handle.db.select().from(users).get();
      expect(await verifyPassword(admin?.passwordHash ?? '', result.generatedPassword ?? '')).toBe(
        true,
      );
    } finally {
      handle.close();
    }
  });

  it('refuses to seed a database that already holds a shop', async () => {
    const handle = await seeded();
    try {
      await expect(seedWorkbookShop(handle)).rejects.toThrow(/already holds 1 shop/);
      // …unless the operator says so. The schema is multi-shop by design.
      await expect(
        seedWorkbookShop(handle, { force: true, shopName: 'Second' }),
      ).resolves.toBeDefined();
      expect(handle.db.select().from(shops).all()).toHaveLength(2);
    } finally {
      handle.close();
    }
  });
});
