import { describe, expect, it } from 'vitest';

import {
  blankCostUsd,
  materialAtQty,
  materialForPart,
  minimumChargeUsd,
  nest,
  sheetMetalNestingContributor,
  yieldForLengths,
  type MaterialParams,
} from '../src/material.js';
import { mmToIn } from '../src/units.js';
import golden from './fixtures/golden-workbook.json' with { type: 'json' };
import { goldenConfig, goldenPart, quoteFor } from './helpers/golden-config.js';

/**
 * REQUIREMENTS §5.1, validated against the §9 golden case.
 *
 * Every workbook number here is read from `fixtures/golden-workbook.json`,
 * which `scripts/extract-workbook.py` generates from the xls. None of them is
 * typed in: a fixture typed from the spec proves only that we can copy.
 */

/** The golden part's material parameters, from the fixture. */
const goldenParams: MaterialParams = {
  flatLengthIn: golden.part.flat_length_in,
  flatWidthIn: golden.part.flat_width_in,
  stockWidthIn: golden.nesting.stock_width_in,
  blankLengthIn: golden.nesting.blank_length_in,
  clampStripIn: golden.nesting.clamp_in,
  kerfIn: golden.nesting.kerf_in,
  lbPerSqFt: golden.material.lb_per_sq_ft,
  pricePerLbUsd: golden.material.price_per_lb,
  minChargeStripIn: golden.config.min_charge_strip_in,
};

describe('nesting (§5.1)', () => {
  it('nests the golden part 33 up on a 96-inch blank', () => {
    const n = nest(goldenParams);
    expect(n.partsPerBlank).toBe(golden.nesting.parts_per_blank);
    expect(n.fits).toBe(true);
  });

  it('turns the part to get the better of the two orientations', () => {
    const n = nest(goldenParams);
    // 13.38 across the clamped 47 in gives 3; 7.858 along 96 in gives 11.
    // Unrotated would be 6 × 5 = 30, so the rotated 33 has to win.
    expect(n.orientation).toBe('width');
    expect(n.across).toBe(3);
    expect(n.down).toBe(11);
  });

  it("matches the prototype's 48 × 120 case at 0.375 spacing", () => {
    // BUILD-PLAN 1.2's acceptance case, from the prototype's `nest()`.
    const n = nest({
      ...goldenParams,
      blankLengthIn: 120,
      kerfIn: 0.375,
    });
    expect(n.partsPerBlank).toBe(42);
  });

  it('reports yield as part area over blank area', () => {
    const n = nest(goldenParams);
    const blankArea = golden.nesting.stock_width_in * golden.nesting.blank_length_in;
    const partArea = golden.part.flat_length_in * golden.part.flat_width_in;
    expect(n.yieldPct).toBeCloseTo((33 * partArea) / blankArea, 6);
    expect(n.yieldPct).toBeGreaterThan(0.5);
  });

  it('charges kerf to every part, not only to the gaps between them', () => {
    // Four 10-inch parts fit a 40-inch run only when the kerf is free. §5.1
    // adds it to each part, so 40 / (10 + 0.5) = 3.
    const n = nest({
      ...goldenParams,
      flatLengthIn: 10,
      flatWidthIn: 10,
      stockWidthIn: 11,
      clampStripIn: 0,
      blankLengthIn: 40,
      kerfIn: 0.5,
    });
    expect(n.down).toBe(3);
  });

  it('does not fit a blank wider than the stock', () => {
    const n = nest({ ...goldenParams, flatLengthIn: 60, flatWidthIn: 60 });
    expect(n.fits).toBe(false);
    expect(n.partsPerBlank).toBe(0);
  });

  it('nests the same part entered in millimetres', () => {
    // Conversion happens at the edge (CLAUDE.md); calc only ever sees inches.
    const n = nest({
      ...goldenParams,
      flatLengthIn: mmToIn(golden.part.flat_length_in * 25.4),
      flatWidthIn: mmToIn(golden.part.flat_width_in * 25.4),
    });
    expect(n.partsPerBlank).toBe(golden.nesting.parts_per_blank);
  });
});

describe('material cost (§5.1, §9 intermediates)', () => {
  it('prices one blank of stock at the golden blank cost', () => {
    expect(blankCostUsd(goldenParams)).toBeCloseTo(golden.intermediates.blank_cost, 4);
  });

  it('prices the 12-inch minimum strip at the golden minimum charge', () => {
    expect(minimumChargeUsd(goldenParams)).toBeCloseTo(golden.intermediates.min_charge, 4);
  });

  it("gives one part's share of the blank", () => {
    const cost = materialForPart(goldenParams);
    expect(cost.ok).toBe(true);
    if (!cost.ok) return;
    expect(cost.value.materialPerPartUsd).toBeCloseTo(golden.intermediates.material_per_part, 4);
  });

  it('carries the blank weight', () => {
    const cost = materialForPart(goldenParams);
    if (!cost.ok) throw new Error(cost.error.message);
    // 48 × 96 in of 2.656 lb/ft2 = 32 sq ft of stock.
    expect(cost.value.blankLbs).toBeCloseTo(32 * golden.material.lb_per_sq_ft, 6);
  });

  it('returns a typed failure rather than throwing when the part does not fit', () => {
    const cost = materialForPart({ ...goldenParams, flatLengthIn: 60, flatWidthIn: 60 });
    expect(cost.ok).toBe(false);
    if (cost.ok) return;
    expect(cost.error.code).toBe('part-does-not-fit');
    expect(cost.error.message).toContain('does not fit');
  });

  it("honours the estimator's own nest count", () => {
    const cost = materialForPart({ ...goldenParams, partsPerBlankOverride: 30 });
    if (!cost.ok) throw new Error(cost.error.message);
    expect(cost.value.nesting.partsPerBlank).toBe(30);
    expect(cost.value.materialPerPartUsd).toBeCloseTo(golden.intermediates.blank_cost / 30, 4);
  });
});

describe('materialAtQty and quirk Q1 (§5.1, §5.7)', () => {
  const cost = materialForPart(goldenParams);
  if (!cost.ok) throw new Error(cost.error.message);
  const markup = golden.config.material_markup;

  it('applies the markup inside the MAX at qty 1, giving the golden 10.3254', () => {
    const at = materialAtQty(cost.value, 1, {
      materialMarkup: markup,
      markupInsideMinChargeMax: true,
    });
    expect(at.usdPerPart).toBeCloseTo(golden.intermediates.material_at_qty_1, 4);
    expect(at.minChargeApplied).toBe(true);
  });

  it('falls back to share-of-blank once the quantity carries the minimum', () => {
    for (const qty of [5, 10, 30, 50, 100]) {
      const at = materialAtQty(cost.value, qty, {
        materialMarkup: markup,
        markupInsideMinChargeMax: true,
      });
      expect(at.usdPerPart).toBeCloseTo(golden.intermediates.material_per_part, 4);
      expect(at.minChargeApplied).toBe(false);
    }
  });

  it('with Q1 off, compares against the bare minimum charge', () => {
    const at = materialAtQty(cost.value, 1, {
      materialMarkup: markup,
      markupInsideMinChargeMax: false,
    });
    // The flag's other side is a defensible number, not zero (§11.3).
    expect(at.usdPerPart).toBeCloseTo(golden.intermediates.min_charge, 4);
    expect(at.usdPerPart).toBeLessThan(golden.intermediates.material_at_qty_1);
  });
});

describe('yieldForLengths (§5.1)', () => {
  it('prices each candidate cut length without a lookup grid', () => {
    const rows = yieldForLengths(goldenParams, [48, 96, 120]);
    expect(rows.map((r) => r.blankLengthIn)).toEqual([48, 96, 120]);

    const ninetySix = rows.find((r) => r.blankLengthIn === 96);
    expect(ninetySix?.nesting.partsPerBlank).toBe(golden.nesting.parts_per_blank);
    expect(ninetySix?.materialPerPartUsd).toBeCloseTo(golden.intermediates.material_per_part, 4);
  });

  it('leaves the caller its own params untouched', () => {
    yieldForLengths(goldenParams, [48]);
    expect(goldenParams.blankLengthIn).toBe(golden.nesting.blank_length_in);
  });
});

describe('sheetMetal.nesting contributor (§12)', () => {
  const input = { part: goldenPart(), quote: quoteFor(goldenPart()) };

  it('is a material-bucket contributor taking the material markup', () => {
    expect(sheetMetalNestingContributor.id).toBe('sheetMetal.nesting');
    expect(sheetMetalNestingContributor.bucket).toBe('material');
    expect(sheetMetalNestingContributor.markupClass).toBe('material');
  });

  it('reproduces the golden material figures through a ShopConfig', () => {
    const atOne = sheetMetalNestingContributor.compute(input, goldenConfig(), 1);
    expect(atOne.usdPerPart).toBeCloseTo(golden.intermediates.material_at_qty_1, 4);

    const atHundred = sheetMetalNestingContributor.compute(input, goldenConfig(), 100);
    expect(atHundred.usdPerPart).toBeCloseTo(golden.intermediates.material_per_part, 4);
  });

  it('warns when the minimum charge sets the price, and not otherwise', () => {
    const atOne = sheetMetalNestingContributor.compute(input, goldenConfig(), 1);
    expect(atOne.warnings.map((w) => w.code)).toContain('min-charge-applied');

    const atHundred = sheetMetalNestingContributor.compute(input, goldenConfig(), 100);
    expect(atHundred.warnings).toHaveLength(0);
  });

  it('reports the nest as detail so the UI can show the stack', () => {
    const result = sheetMetalNestingContributor.compute(input, goldenConfig(), 100);
    expect(result.detail?.['partsPerBlank']).toBe(golden.nesting.parts_per_blank);
    expect(result.detail?.['blankCostUsd']).toBeCloseTo(golden.intermediates.blank_cost, 4);
  });

  it('warns rather than throwing when the part does not fit', () => {
    const tooBig = { ...goldenPart(), flatLengthIn: 60, flatWidthIn: 60 };
    const result = sheetMetalNestingContributor.compute(
      { part: tooBig, quote: quoteFor(tooBig) },
      goldenConfig(),
      10,
    );
    expect(result.usdPerPart).toBe(0);
    expect(result.warnings.map((w) => w.code)).toContain('part-does-not-fit');
  });

  it('warns on low yield', () => {
    // 25 in square: one across the clamped 47 in and three along 96, so
    // 3 x 625 of 4608 sq in becomes parts -- 41%, under the 50% threshold.
    const wasteful = { ...goldenPart(), flatLengthIn: 25, flatWidthIn: 25 };
    const result = sheetMetalNestingContributor.compute(
      { part: wasteful, quote: quoteFor(wasteful) },
      goldenConfig(),
      10,
    );
    expect(result.warnings.map((w) => w.code)).toContain('low-yield');
  });

  it('warns when the material row is switched off in Settings', () => {
    const config = goldenConfig();
    const material = config.materials[0];
    if (material === undefined) throw new Error('fixture config has no material');
    material.active = false;

    const result = sheetMetalNestingContributor.compute(input, config, 100);
    expect(result.warnings.map((w) => w.code)).toContain('material-inactive');
  });

  it('applies a material surcharge to the effective price', () => {
    const config = goldenConfig();
    const material = config.materials[0];
    if (material === undefined) throw new Error('fixture config has no material');
    material.surchargePct = 0.1;

    const result = sheetMetalNestingContributor.compute(input, config, 100);
    expect(result.usdPerPart).toBeCloseTo(golden.intermediates.material_per_part * 1.1, 4);
  });
});

describe('resolution failures and edge cases', () => {
  it('reports an unknown material as a reference failure, not a price of zero', () => {
    const part = { ...goldenPart(), materialId: 'material-nope' };
    const result = sheetMetalNestingContributor.compute(
      { part, quote: quoteFor(part) },
      goldenConfig(),
      10,
    );
    expect(result.usdPerPart).toBe(0);
    expect(result.warnings[0]?.code).toBe('unknown-reference');
    expect(result.warnings[0]?.message).toContain('material-nope');
  });

  /**
   * §12 rule 3, and not a hypothetical: the workbook stocks fourteen brushed
   * stainless gauges with no price in the sheet at all. A shop halfway through
   * entering its catalog has the same hole. Quoting them at zero would price a
   * job as though the steel were free, so the price is null and the estimator
   * is told which material to go and price.
   */
  it('refuses to price stock that has no $/lb, and names it', () => {
    const config = goldenConfig();
    const material = config.materials[0];
    if (material === undefined) throw new Error('fixture config has no material');
    material.pricePerLbUsd = null;

    const part = goldenPart();
    const result = sheetMetalNestingContributor.compute(
      { part, quote: quoteFor(part) },
      config,
      100,
    );
    expect(result.usdPerPart).toBe(0);
    expect(result.warnings.map((w) => w.code)).toContain('missing-material-price');
    expect(result.warnings[0]?.message).toContain(material.name);
  });

  it('reports an unknown machine the same way', () => {
    const part = {
      ...goldenPart(),
      nesting: { ...goldenPart().nesting, machineId: 'machine-nope' },
    };
    const result = sheetMetalNestingContributor.compute(
      { part, quote: quoteFor(part) },
      goldenConfig(),
      10,
    );
    expect(result.usdPerPart).toBe(0);
    expect(result.warnings[0]?.message).toContain('machine-nope');
  });

  it('takes clamp and kerf overrides off the part before the machine row', () => {
    const base = goldenPart();
    const part = {
      ...base,
      nesting: { ...base.nesting, kerfInOverride: 0.375, blankLengthIn: 120 },
    };
    const result = sheetMetalNestingContributor.compute(
      { part, quote: quoteFor(part) },
      goldenConfig(),
      100,
    );
    // The prototype's 48 x 120 case: a fibre shop's 0.375 kerf nests 42 up.
    expect(result.detail?.['partsPerBlank']).toBe(42);
  });

  it('prices nothing at a quantity of zero rather than dividing by it', () => {
    const cost = materialForPart(goldenParams);
    if (!cost.ok) throw new Error(cost.error.message);
    const at = materialAtQty(cost.value, 0, {
      materialMarkup: 1.2,
      markupInsideMinChargeMax: true,
    });
    expect(at.usdPerPart).toBe(0);
    expect(at.minChargeApplied).toBe(false);
  });

  it('reports zero cost for a candidate length the part does not fit', () => {
    const rows = yieldForLengths({ ...goldenParams, flatLengthIn: 60, flatWidthIn: 60 }, [96]);
    expect(rows[0]?.nesting.fits).toBe(false);
    expect(rows[0]?.materialPerPartUsd).toBe(0);
  });

  it('treats a kerf that swallows the stock as not fitting', () => {
    const n = nest({ ...goldenParams, kerfIn: -100 });
    expect(n.partsPerBlank).toBe(0);
  });
});
