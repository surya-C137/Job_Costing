import { describe, expect, it } from 'vitest';

import { computeQuote, type PartInput, type QuoteInput, type ShopConfig } from '@shopquote/calc';

import { loadShopConfig } from '../src/config.js';
import { openMigratedMemoryDatabase, type DatabaseHandle } from '../src/db.js';
import { seedWorkbookShop, WORKBOOK_PRICE_VINTAGE } from '../src/seed.js';
import golden from '../../calc/test/fixtures/golden-workbook.json' with { type: 'json' };

/**
 * BUILD-PLAN 2.2's acceptance check: the golden case through the database.
 *
 * calc's own `golden.test.ts` prices REQUIREMENTS §9 from the seed files with
 * no database in sight. This prices the same part from a *seeded and reloaded*
 * config, so it proves the three links agree:
 *
 *     seed files → shopConfigFromSeed → writeShopConfig → rows
 *                                     → loadShopConfig → ShopConfig → computeQuote
 *
 * If this passes and calc's passes, `loadShopConfig()` really is
 * `writeShopConfig()`'s inverse. If this fails while calc's passes, the fault
 * is in the round trip and nowhere else — which is the whole reason the seed
 * goes through calc's mapping rather than having one of its own.
 *
 * The oracle is §9's seventeen numbers and no more. Ids are resolved by *name*
 * here, because §7 re-issues them as ULIDs on the way in — that is also how the
 * estimator picks a material, so it is the honest lookup.
 */

async function seededConfig(handle: DatabaseHandle): Promise<ShopConfig> {
  const { shopId } = await seedWorkbookShop(handle, { adminPassword: 'test' });
  // As of the day after the workbook's prices took effect, so the seeded
  // version is the one in force.
  return loadShopConfig(handle.db, shopId, new Date(WORKBOOK_PRICE_VINTAGE.getTime() + 86_400_000));
}

/** Find a catalog row by the name the estimator would type. */
function idOf(rows: { id: string; name: string }[], name: string): string {
  const row = rows.find((r) => r.name === name);
  if (row === undefined) throw new Error(`no "${name}" in the loaded catalog`);
  return row.id;
}

/** The §9 part, entered against a config loaded from the database. */
function goldenPart(config: ShopConfig): PartInput {
  const coating = config.coatingModels.find((c) => c.name.startsWith('Powder'));
  if (coating === undefined) throw new Error('no powder coating model in the loaded catalog');

  return {
    id: 'part-g30',
    partNumber: 'G30-GOLDEN',
    materialId: idOf(config.materials, golden.material.name),
    flatLengthIn: golden.part.flat_length_in,
    flatWidthIn: golden.part.flat_width_in,
    nesting: {
      machineId: idOf(config.machines, golden.nesting.process),
      stockWidthIn: golden.nesting.stock_width_in,
      blankLengthIn: golden.nesting.blank_length_in,
    },
    cutting: {
      model: 'featureBased',
      features: [],
      perimeterCutIn: golden.laser.perimeter_cut_in,
      intersections: golden.laser.intersections,
    },
    operations: [{ operationId: idOf(config.operations, 'LASER'), countPerPart: 1 }],
    finish: {
      coating: { coatingModelId: coating.id, sidesCoated: 2, maskedFeatures: 0 },
    },
    hardware: [],
    nre: [],
  };
}

function goldenQuote(config: ShopConfig): QuoteInput {
  return { parts: [goldenPart(config)], quantityBreaks: [...golden.quantity_breaks] };
}

// Seeding hashes the admin's password, which is async, so the case is priced
// once at module level and every assertion below reads the same result.
const handle = openMigratedMemoryDatabase();
const config = await seededConfig(handle);
const result = computeQuote(goldenQuote(config), config);
const part = result.parts[0];
if (part === undefined) throw new Error('computeQuote returned no parts');

describe('the golden case, through the database (§9)', () => {
  it('reproduces the six selling prices to ±0.005', async () => {
    part.breaks.forEach((stack, i) => {
      const expected = golden.expected.selling_price[i];
      if (expected === undefined) throw new Error(`no expected price at index ${i}`);
      expect(
        Math.abs(stack.sellingPriceUsd - expected),
        `qty ${stack.quantity}: got ${stack.sellingPriceUsd}, expected ${expected}`,
      ).toBeLessThanOrEqual(golden.tolerance.selling_price);
    });
  });

  it('reproduces the six material percentages to ±0.001', async () => {
    part.breaks.forEach((stack, i) => {
      const expected = golden.expected.material_pct_of_selling[i];
      if (expected === undefined) throw new Error(`no expected percentage at index ${i}`);
      expect(
        Math.abs(stack.materialPctOfSelling - expected),
        `qty ${stack.quantity}: got ${stack.materialPctOfSelling}, expected ${expected}`,
      ).toBeLessThanOrEqual(golden.tolerance.material_pct_of_selling);
    });
  });

  it('reproduces the intermediates that survive the round trip', async () => {
    const one = part.breaks[0];
    const hundred = part.breaks[5];
    if (one === undefined || hundred === undefined) throw new Error('missing breaks');

    expect(part.nesting.partsPerBlank).toBe(golden.nesting.parts_per_blank);
    expect(hundred.materialUsd).toBeCloseTo(golden.intermediates.material_per_part, 4);
    expect(one.materialUsd).toBeCloseTo(golden.intermediates.material_at_qty_1, 4);
    // Laser hours reach the stack as direct labour: hrs × $100 × Q2's 0.6.
    expect(hundred.directLaborUsd).toBeCloseTo(
      golden.intermediates.laser_hours_per_part * golden.laser_op.rate_per_hr * 0.6,
      6,
    );
  });

  it('raises the minimum-charge warning and nothing else', async () => {
    // Anything else here would mean a lookup fell through the round trip — a
    // machine rate that did not survive, a price that came back null.
    expect(part.warnings.map((w) => w.code)).toEqual(['min-charge-applied']);
    expect(result.warnings).toEqual([]);
  });

  it('carries the parity flags the shop row holds', async () => {
    expect(config.parity).toEqual({
      markupInsideMinChargeMax: true,
      machineTimeFactor: 0.6,
      legacyCoatingModel: true,
      finishesUnmarked: true,
    });
  });
});
