import { describe, expect, it } from 'vitest';

import type { ShopConfig } from '@shopquote/calc';

import { openMigratedMemoryDatabase } from '../src/db.js';
import { materialFamilies, materials, shops } from '../src/schema.js';
import { blankShopConfig } from '../src/seed-blank.js';
import { writeShopConfig } from '../src/write-config.js';

/**
 * `writeShopConfig()` is the only way rows get into the catalog — the seed, a
 * blank shop and (at Task 3.1) a config import all go through it. These are
 * the guarantees the callers rely on rather than re-check.
 */

function configWithOneMaterial(shopId: string): ShopConfig {
  const base = blankShopConfig(shopId, { shopName: 'Writer Test' });
  return {
    ...base,
    families: [
      {
        id: 'family:steel',
        name: 'Steel',
        densityLbPerCuIn: 0.2836,
        defaultScrapPricePerLbUsd: 0,
        aliases: ['CRS'],
      },
    ],
    gauges: [],
    materials: [
      {
        id: 'material:crs-16',
        name: 'CRS 16 GA',
        familyId: 'family:steel',
        form: 'sheet',
        thicknessIn: 0.0598,
        lbPerSqFt: 2.5,
        pricePerLbUsd: 0.41,
        surchargePct: 0,
        scrapPricePerLbUsd: 0,
        standardLengthIn: 120,
        aliases: ['CRS 16'],
        sheetCostUsd: null,
        sheetLbs: null,
        active: true,
      },
    ],
  };
}

describe('writeShopConfig', () => {
  it('re-issues ULIDs and keeps the config id as provenance (§7)', () => {
    const handle = openMigratedMemoryDatabase();
    try {
      const result = writeShopConfig(handle, configWithOneMaterial('shop-x'), {
        shopId: 'shop-x',
        pricesEffectiveFrom: new Date('2023-01-01T00:00:00Z'),
      });

      const stored = handle.db.select().from(materials).get();
      expect(stored?.sourceKey).toBe('material:crs-16');
      expect(stored?.id).not.toBe('material:crs-16');
      expect(result.ids.get('material:crs-16')).toBe(stored?.id);

      // References follow the remap, not the original slug.
      const family = handle.db.select().from(materialFamilies).get();
      expect(stored?.familyId).toBe(family?.id);
    } finally {
      handle.close();
    }
  });

  it('rolls the whole catalog back when one row fails', () => {
    const handle = openMigratedMemoryDatabase();
    try {
      const config = configWithOneMaterial('shop-y');
      // A material pointing at a family that is not in the config.
      config.materials[0]!.familyId = 'family:nope';

      expect(() =>
        writeShopConfig(handle, config, {
          shopId: 'shop-y',
          pricesEffectiveFrom: new Date(),
        }),
      ).toThrow(/family:nope/);

      // The shop row went in first; the transaction has to have taken it back.
      expect(handle.db.select().from(shops).all()).toHaveLength(0);
      expect(handle.db.select().from(materialFamilies).all()).toHaveLength(0);
    } finally {
      handle.close();
    }
  });

  it('rejects a config in which two entities share an id', () => {
    const handle = openMigratedMemoryDatabase();
    try {
      const config = configWithOneMaterial('shop-z');
      config.materials = [config.materials[0]!, { ...config.materials[0]!, name: 'Duplicate' }];

      expect(() =>
        writeShopConfig(handle, config, {
          shopId: 'shop-z',
          pricesEffectiveFrom: new Date(),
        }),
      ).toThrow(/share the id "material:crs-16"/);
    } finally {
      handle.close();
    }
  });

  it('flattens the aliases a ShopConfig carries into one table (§12)', () => {
    const handle = openMigratedMemoryDatabase();
    try {
      const result = writeShopConfig(handle, configWithOneMaterial('shop-a'), {
        shopId: 'shop-a',
        pricesEffectiveFrom: new Date(),
      });
      // One family alias plus one material alias.
      expect(result.counts['intake_aliases']).toBe(2);
    } finally {
      handle.close();
    }
  });
});
