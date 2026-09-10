import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { openMigratedMemoryDatabase } from '../src/db.js';
import {
  gaugeReference,
  intakeAliases,
  machines,
  materialFamilies,
  materials,
  operations,
  platingSpecs,
  shops,
} from '../src/schema.js';
import { seedBlankShop } from '../src/seed-blank.js';

/**
 * BUILD-PLAN 2.1's second seeder — a shop with no workbook, which is Phase 6's
 * starting point and the honest test of §12: if anything about *this* shop had
 * leaked into code rather than data, a blank shop is where it would show up.
 */
describe('db:seed-blank', () => {
  it('creates a shop with gauge tables and nothing that costs money', () => {
    const handle = openMigratedMemoryDatabase();
    try {
      seedBlankShop(handle, { shopName: 'Second Shop', adminPassword: 'x' });

      expect(handle.db.select().from(materialFamilies).all().length).toBe(4);
      expect(handle.db.select().from(gaugeReference).all().length).toBeGreaterThan(80);

      // Everything with a price on it is the owner's to enter.
      expect(handle.db.select().from(materials).all()).toHaveLength(0);
      expect(handle.db.select().from(machines).all()).toHaveLength(0);
      expect(handle.db.select().from(operations).all()).toHaveLength(0);
      expect(handle.db.select().from(platingSpecs).all()).toHaveLength(0);
    } finally {
      handle.close();
    }
  });

  it('starts with the parity flags off — there is no workbook to match', () => {
    const handle = openMigratedMemoryDatabase();
    try {
      seedBlankShop(handle, { adminPassword: 'x' });
      const shop = handle.db.select().from(shops).get();
      expect(shop?.parityMarkupInsideMinChargeMax).toBe(false);
      expect(shop?.parityMachineTimeFactor).toBe(1);
      expect(shop?.parityLegacyCoatingModel).toBe(false);
      expect(shop?.parityFinishesUnmarked).toBe(false);
    } finally {
      handle.close();
    }
  });

  it('seeds the gauge a drawing actually calls out', () => {
    const handle = openMigratedMemoryDatabase();
    try {
      seedBlankShop(handle, { adminPassword: 'x' });

      const steel = handle.db
        .select()
        .from(materialFamilies)
        .where(eq(materialFamilies.name, 'Steel'))
        .get();
      const sixteen = handle.db
        .select()
        .from(gaugeReference)
        .where(eq(gaugeReference.familyId, steel?.id ?? ''))
        .all()
        .find((g) => g.label === '16 ga');

      // Manufacturer's Standard Gauge, and the workbook agrees: its CRS 16 GA
      // row is .0598 at 2.5 lb/ft².
      expect(sixteen?.thicknessIn).toBe(0.0598);
      expect(sixteen?.lbPerSqFtOverride).toBe(2.5);

      // Galvanised carries the base gauge with the coated weight — the same
      // convention as the workbook's G30 16 GA (.0598) at 2.656.
      const galv = handle.db
        .select()
        .from(materialFamilies)
        .where(eq(materialFamilies.name, 'Galvanized'))
        .get();
      const galv16 = handle.db
        .select()
        .from(gaugeReference)
        .where(eq(gaugeReference.familyId, galv?.id ?? ''))
        .all()
        .find((g) => g.label === '16 ga');
      expect(galv16?.thicknessIn).toBe(0.0598);
      expect(galv16?.lbPerSqFtOverride).toBe(2.656);
    } finally {
      handle.close();
    }
  });

  it('seeds the family aliases the intake resolver reads (§8)', () => {
    const handle = openMigratedMemoryDatabase();
    try {
      seedBlankShop(handle, { adminPassword: 'x' });
      const aliases = handle.db.select().from(intakeAliases).all();
      const values = aliases.map((a) => a.alias);
      expect(values).toContain('CRS');
      expect(values).toContain('5052');
      expect(aliases.every((a) => a.kind === 'family')).toBe(true);
    } finally {
      handle.close();
    }
  });

  it('leaves markups at 1.0 rather than borrowing another shop’s', () => {
    const handle = openMigratedMemoryDatabase();
    try {
      seedBlankShop(handle, { adminPassword: 'x' });
      const shop = handle.db.select().from(shops).get();
      expect(shop?.laborMarkup).toBe(1);
      expect(shop?.materialMarkup).toBe(1);
      expect(shop?.minChargeStripIn).toBe(0);
      expect(shop?.defaultQuantityBreaks).toEqual([1, 5, 10, 30, 50, 100]);
    } finally {
      handle.close();
    }
  });
});
