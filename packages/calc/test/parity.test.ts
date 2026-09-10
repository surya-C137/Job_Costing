import { describe, expect, it } from 'vitest';

import { computeQuote } from '../src/rollup.js';
import { machineId, materialId, operationId, shopConfigFromSeed } from '../src/seed.js';
import type { ShopConfig } from '../src/types/config.js';
import type { PartInput, QuoteInput } from '../src/types/part.js';
import golden from './fixtures/golden-workbook.json' with { type: 'json' };
import { seedBundle } from './helpers/seed-bundle.js';

/**
 * REQUIREMENTS §5.7 and §11.3 — every parity flag, switched off on its own.
 *
 * Two things are being guarded here, and the second matters more than the
 * numbers.
 *
 * 1. The prices in `docs/parity-report.md` are what the engine actually
 *    produces. That document is what goes in front of the owner when we ask
 *    §10 questions 1–3, so it cannot quietly drift from the code.
 *
 * 2. **Every flag has two real sides.** §11.3 is explicit that turning one off
 *    must yield a defensible number, not zero and not a hole. Each scenario
 *    below therefore asserts that the price *moved* and that it moved the way
 *    the report says — a flag whose "off" branch fell through to zero would
 *    show up as a price collapse, and one that was never wired up at all
 *    (as `finishesUnmarked` briefly was) shows up as no movement.
 */

const base = shopConfigFromSeed(seedBundle());
const COATING_ID = 'coating:powder-smooth-or-textured';

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
    finish: { coating: { coatingModelId: COATING_ID, sidesCoated: 2, maskedFeatures: 0 } },
    hardware: [],
    nre: [],
  };
}

const quote = (): QuoteInput => ({
  parts: [goldenPart()],
  quantityBreaks: [...golden.quantity_breaks],
});

function pricesFor(config: ShopConfig): number[] {
  const result = computeQuote(quote(), config);
  const part = result.parts[0];
  if (part === undefined) throw new Error('computeQuote returned no parts');
  return part.breaks.map((b) => b.sellingPriceUsd);
}

/** The trade-typical powder placeholders the Q3 row is priced with. The
 *  workbook has no source for any of them — §10 question 2. */
const ASSUMED_POWDER = {
  specificGravity: 1.5,
  filmThicknessMils: 2,
  transferEfficiency: 0.6,
  powderPricePerLbUsd: 5,
  rackLaborUsdPerPart: 0.1,
  maskingUsdPerFeature: 0.05,
};

const withModernPowder = (config: ShopConfig): ShopConfig => ({
  ...config,
  coatingModels: config.coatingModels.map((c) =>
    c.id === COATING_ID ? { ...c, modern: ASSUMED_POWDER } : c,
  ),
});

const baseline = pricesFor(base);

describe('the baseline this report is measured against', () => {
  it('is the workbook, on every flag', () => {
    expect(base.parity).toEqual({
      markupInsideMinChargeMax: true,
      machineTimeFactor: 0.6,
      legacyCoatingModel: true,
      finishesUnmarked: true,
    });
  });

  it('reproduces §9', () => {
    baseline.forEach((price, i) => {
      const expected = golden.expected.selling_price[i];
      if (expected === undefined) throw new Error(`no expected price at ${i}`);
      expect(Math.abs(price - expected)).toBeLessThanOrEqual(golden.tolerance.selling_price);
    });
  });
});

describe('Q1 off — markup outside the minimum-charge MAX (§5.7)', () => {
  const prices = pricesFor({
    ...base,
    parity: { ...base.parity, markupInsideMinChargeMax: false },
  });

  it('drops the quantity-1 price by $2.07', () => {
    expect(prices[0]).toBeCloseTo(35.7635, 3);
    expect((prices[0] ?? 0) - (baseline[0] ?? 0)).toBeCloseTo(-2.0651, 3);
  });

  it('changes nothing above a quantity of one, where the nest beats the minimum', () => {
    expect(prices.slice(1)).toEqual(baseline.slice(1));
  });

  it('still charges more than the bare minimum strip — not a hole (§11.3)', () => {
    expect(prices[0]).toBeGreaterThan(golden.intermediates.min_charge);
  });
});

describe('Q2 off — machine time billed as machine time (§5.7)', () => {
  const prices = pricesFor({ ...base, parity: { ...base.parity, machineTimeFactor: 1 } });

  it('raises every price by the same $0.25', () => {
    prices.forEach((price, i) => {
      expect(price - (baseline[i] ?? 0)).toBeCloseTo(0.2508, 3);
    });
  });

  it('is the labour markup applied to the 0.4× of laser time the workbook forgives', () => {
    const forgiven = golden.intermediates.laser_hours_per_part * golden.laser_op.rate_per_hr * 0.4;
    expect((prices[5] ?? 0) - (baseline[5] ?? 0)).toBeCloseTo(
      forgiven * golden.config.labor_markup,
      6,
    );
  });

  it('takes a dialable factor, not a boolean', () => {
    const half = pricesFor({ ...base, parity: { ...base.parity, machineTimeFactor: 0.8 } });
    expect(half[5]).toBeGreaterThan(baseline[5] ?? 0);
    expect(half[5]).toBeLessThan(prices[5] ?? 0);
  });
});

describe('Q3 off — coating priced off area rather than perimeter (§11.3)', () => {
  const config = withModernPowder(base);
  const prices = pricesFor({ ...config, parity: { ...base.parity, legacyCoatingModel: false } });

  it('lowers every price by the same $0.77', () => {
    prices.forEach((price, i) => {
      expect(price - (baseline[i] ?? 0)).toBeCloseTo(-0.7721, 3);
    });
  });

  it('is a real number, not zero — the failure mode §11.3 names', () => {
    const result = computeQuote(quote(), {
      ...config,
      parity: { ...base.parity, legacyCoatingModel: false },
    });
    const stack = result.parts[0]?.breaks[5];
    expect(stack?.coatingUsd).toBeGreaterThan(0);
    // Powder for two faces plus racking, at the assumed parameters.
    const coverage = (192.3 / 1.5 / 2) * 0.6;
    const coatedSqFt = (golden.part.blank_area_sq_in * 2) / 144;
    expect(stack?.coatingUsd).toBeCloseTo((coatedSqFt / coverage) * 5 + 0.1, 6);
  });

  it('collapses to a warning, not a silent zero, when the powder is unspecified', () => {
    // The seed ships `modern: null` — the workbook has no source for it.
    const result = computeQuote(quote(), {
      ...base,
      parity: { ...base.parity, legacyCoatingModel: false },
    });
    expect(result.parts[0]?.warnings.map((w) => w.message).join(' ')).toContain(
      'specific gravity',
    );
  });
});

describe('Q4 off — coating and silkscreen inside the markups (§5.6)', () => {
  const prices = pricesFor({ ...base, parity: { ...base.parity, finishesUnmarked: false } });

  it('raises every price by the coating markup the workbook never charges', () => {
    prices.forEach((price, i) => {
      expect(price - (baseline[i] ?? 0)).toBeCloseTo(0.2124, 3);
    });
  });

  it('is exactly the material markup applied to the coating', () => {
    const coating = 0.5 * ((golden.coating.perimeter_in / 100) * 5);
    expect((prices[5] ?? 0) - (baseline[5] ?? 0)).toBeCloseTo(
      coating * (golden.config.material_markup - 1),
      6,
    );
  });

  it('actually moves the price — the flag is wired to the roll-up', () => {
    // This is the regression that matters: `finishesUnmarked` was declared on
    // the contributors and read by nobody, so switching it changed nothing.
    expect(prices).not.toEqual(baseline);
  });
});

describe('the report and the engine agree', () => {
  it('every flag moves the price when switched off', () => {
    const scenarios: ShopConfig[] = [
      { ...base, parity: { ...base.parity, markupInsideMinChargeMax: false } },
      { ...base, parity: { ...base.parity, machineTimeFactor: 1 } },
      { ...withModernPowder(base), parity: { ...base.parity, legacyCoatingModel: false } },
      { ...base, parity: { ...base.parity, finishesUnmarked: false } },
    ];
    for (const config of scenarios) {
      expect(pricesFor(config)).not.toEqual(baseline);
    }
  });

  it('no flag sends a price to zero or below', () => {
    const all: ShopConfig = {
      ...withModernPowder(base),
      parity: {
        markupInsideMinChargeMax: false,
        machineTimeFactor: 1,
        legacyCoatingModel: false,
        finishesUnmarked: false,
      },
    };
    for (const price of pricesFor(all)) expect(price).toBeGreaterThan(0);
  });
});

describe('a second fixture, from a real recent quote', () => {
  /**
   * BUILD-PLAN Task 1.5 and REQUIREMENTS §9: one workbook case proves the
   * engine reproduces one workbook case. A second, from a quote the estimator
   * actually sent, is what would show it generalises — ideally one with a
   * punched part, plating, hardware and NRE, since the §9 case exercises none
   * of those and the punch model has no oracle at all (see docs/decisions.md,
   * Task 1.3).
   *
   * Blocked on Phase 0.1: `docs/discovery/quote-2.xlsx` does not exist yet.
   * BUILD-PLAN 0.1 asks the shop for ten recent quotes; the first of them
   * lands here.
   */
  it.todo('reproduces docs/discovery/quote-2.xlsx once the estimator provides it');
});
