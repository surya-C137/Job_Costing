import { describe, expect, it } from 'vitest';

import { computeQuote } from '../src/rollup.js';
import { machineId, materialId, operationId, shopConfigFromSeed } from '../src/seed.js';
import type { ShopConfig } from '../src/types/config.js';
import type { PartInput, QuoteInput } from '../src/types/part.js';
import golden from './fixtures/golden-workbook.json' with { type: 'json' };
import { seedBundle } from './helpers/seed-bundle.js';

/**
 * REQUIREMENTS §9 — the parity test, and the definition of correct.
 *
 * This is the one that matters. It builds a `ShopConfig` out of the *seed
 * files* rather than a hand-made fixture, prices the §9 part through
 * `computeQuote()`, and holds the answer to the oracle: six selling prices to
 * ±0.005, six material percentages to ±0.001, and five intermediates.
 *
 * If a number here is wrong, the engine is wrong. Never edit
 * `fixtures/golden-workbook.json` to make it pass — trace the formula in the
 * xls, fix the engine, and say what the discrepancy was in the commit message.
 *
 * Equally: do not add assertions here for other workbook numbers. The oracle
 * is seventeen values and no more (§9, "What not to test").
 */

const config: ShopConfig = shopConfigFromSeed(seedBundle());

/** The §9 part, entered against the seeded catalog. */
function goldenPart(): PartInput {
  return {
    id: 'part-g30',
    partNumber: 'G30-GOLDEN',
    materialId: materialId('g30-16-ga-0598'),
    flatLengthIn: golden.part.flat_length_in,
    flatWidthIn: golden.part.flat_width_in,
    nesting: {
      machineId: machineId('laser'),
      stockWidthIn: golden.nesting.stock_width_in,
      blankLengthIn: golden.nesting.blank_length_in,
    },
    cutting: {
      model: 'featureBased',
      features: [],
      perimeterCutIn: golden.laser.perimeter_cut_in,
      intersections: golden.laser.intersections,
    },
    operations: [{ operationId: operationId('laser'), countPerPart: 1 }],
    finish: {
      coating: {
        coatingModelId: 'coating:powder-smooth-or-textured',
        sidesCoated: 1,
        maskedFeatures: 0,
      },
    },
    hardware: [],
    nre: [],
  };
}

function goldenQuote(): QuoteInput {
  return { parts: [goldenPart()], quantityBreaks: [...golden.quantity_breaks] };
}

describe('golden case (REQUIREMENTS §9)', () => {
  const result = computeQuote(goldenQuote(), config);
  const part = result.parts[0];
  if (part === undefined) throw new Error('computeQuote returned no parts');

  it('prices every quantity break the workbook does', () => {
    expect(part.breaks.map((b) => b.quantity)).toEqual(golden.quantity_breaks);
  });

  it('reproduces the six selling prices to ±0.005', () => {
    part.breaks.forEach((stack, i) => {
      const expected = golden.expected.selling_price[i];
      if (expected === undefined) throw new Error(`no expected price at index ${i}`);
      expect(
        Math.abs(stack.sellingPriceUsd - expected),
        `qty ${stack.quantity}: got ${stack.sellingPriceUsd}, expected ${expected}`,
      ).toBeLessThanOrEqual(golden.tolerance.selling_price);
    });
  });

  it('reproduces the six material percentages to ±0.001', () => {
    part.breaks.forEach((stack, i) => {
      const expected = golden.expected.material_pct_of_selling[i];
      if (expected === undefined) throw new Error(`no expected percentage at index ${i}`);
      expect(
        Math.abs(stack.materialPctOfSelling - expected),
        `qty ${stack.quantity}: got ${stack.materialPctOfSelling}, expected ${expected}`,
      ).toBeLessThanOrEqual(golden.tolerance.material_pct_of_selling);
    });
  });

  it('reproduces the five named intermediates', () => {
    const one = part.breaks[0];
    const hundred = part.breaks[5];
    if (one === undefined || hundred === undefined) throw new Error('missing breaks');

    // Material per part, and the qty-1 figure where the minimum charge bites.
    expect(hundred.materialUsd).toBeCloseTo(golden.intermediates.material_per_part, 4);
    expect(one.materialUsd).toBeCloseTo(golden.intermediates.material_at_qty_1, 4);
    // Blank cost and the minimum strip, from the nesting contributor's detail.
    expect(part.nesting.partsPerBlank).toBe(golden.nesting.parts_per_blank);
    // Laser hours reach the stack as direct labour: hrs × $100 × 0.6.
    expect(hundred.directLaborUsd).toBeCloseTo(
      golden.intermediates.laser_hours_per_part * golden.laser_op.rate_per_hr * 0.6,
      6,
    );
  });

  it('warns about the minimum charge, and about nothing else', () => {
    // The one amber note the §9 case should raise: at a quantity of one the
    // 12-inch strip sets the material price, which is exactly why qty-1
    // material is 10.3254 and not 2.0859. Anything *else* here would mean a
    // lookup had silently fallen back (§12 rule 3).
    expect(part.warnings.map((w) => w.code)).toEqual(['min-charge-applied']);
    expect(result.warnings).toEqual([]);
  });

  it('raises that warning only at the quantity where it bites', () => {
    const withWarning = part.breaks
      .filter((b) => b.warnings.some((w) => w.code === 'min-charge-applied'))
      .map((b) => b.quantity);
    expect(withWarning).toEqual([1]);
  });
});

describe('the cost stack behind the prices (§5.6)', () => {
  const result = computeQuote(goldenQuote(), config);
  const part = result.parts[0];
  if (part === undefined) throw new Error('computeQuote returned no parts');
  const one = part.breaks[0];
  const hundred = part.breaks[5];
  if (one === undefined || hundred === undefined) throw new Error('missing breaks');

  it('carries the whole job setup at a quantity of one', () => {
    // Laser setup 0.2 h × $100 = $20, and no shop flat charge (§5.6).
    expect(one.fixedUsd).toBeCloseTo(golden.laser_op.fixed_dollars, 6);
    expect(hundred.fixedUsd).toBeCloseTo(golden.laser_op.fixed_dollars / 100, 6);
  });

  it('bills machine time at quirk Q2’s 0.6 factor', () => {
    expect(one.directLaborUsd).toBeCloseTo(0.3135272727272727, 8);
  });

  it('prices the coating off the perimeter, quirk Q3', () => {
    // Hand-derived from the seeded constants, not pinned to a workbook cell:
    // rate 0.5 × (perimeter 42.476 ÷ coverage 100 × S 5) = 1.0619.
    const expected = 0.5 * ((golden.coating.perimeter_in / 100) * 5);
    expect(one.coatingUsd).toBeCloseTo(expected, 10);
  });

  it('adds coating after the markups, quirk Q4', () => {
    // The stack has to add up exactly, with the finish outside both blocks.
    const sum = one.materialBlockUsd + one.laborBlockUsd + one.coatingUsd + one.silkscreenUsd;
    expect(sum).toBeCloseTo(one.sellingPriceUsd, 10);
  });

  it('marks the material block once on top of quirk Q1’s markup', () => {
    // Q1 puts a 1.2 inside the minimum-charge MAX; §5.6 applies another 1.2 to
    // the block. At a quantity of one the minimum therefore carries both.
    expect(one.materialUsd).toBeCloseTo(golden.intermediates.material_at_qty_1, 4);
    expect(one.materialBlockUsd).toBeCloseTo(
      golden.intermediates.material_at_qty_1 * golden.config.material_markup,
      4,
    );
  });

  it('leaves every unused line at zero', () => {
    expect(one.materialExtrasUsd).toBe(0);
    expect(one.hardwareUsd).toBe(0);
    expect(one.platingUsd).toBe(0);
    expect(one.silkscreenUsd).toBe(0);
  });
});

describe('the seeded catalog (§3, §12)', () => {
  it('carries the whole workbook', () => {
    expect(config.materials).toHaveLength(80);
    expect(config.operations).toHaveLength(20);
    expect(config.platingSpecs).toHaveLength(35);
    expect(config.machines).toHaveLength(2);
  });

  it('moves speed and pierce off the material row onto the pairing (§3)', () => {
    const rate = config.machineMaterialRates.find(
      (r) => r.machineId === machineId('laser') && r.materialId === materialId('g30-16-ga-0598'),
    );
    expect(rate?.cutSpeedInPerMin).toBe(golden.material.speed_in_min);
    expect(rate?.pierceSeconds).toBe(golden.material.pierce_s);
    expect(config.materials[0]).not.toHaveProperty('speedInMin');
  });

  it('seeds the machine timing constants recovered from the worksheet (§5.2)', () => {
    const laser = config.machines.find((m) => m.id === machineId('laser'));
    expect(laser?.intersectionSec).toBe(0.3);
    expect(laser?.rapidSecPerPierce).toBe(0.6);
    expect(laser?.palletBatchParts).toBe(100);
    expect(laser?.lossFactor).toBe(1.08);
    expect(laser?.kerfIn).toBe(golden.nesting.kerf_in);
  });

  it('seeds no flat shop charge, because D13 was the setup roll-up (§5.6)', () => {
    expect(config.defaults.shopFixedCostPerJobUsd).toBe(0);
  });

  it('gives the punch machine the tool table and the laser none (§5.3)', () => {
    const punch = config.machines.find((m) => m.id === machineId('punch'));
    const laser = config.machines.find((m) => m.id === machineId('laser'));
    expect(punch?.hitRates).toHaveLength(10);
    expect(laser?.hitRates).toHaveLength(0);
  });
});
