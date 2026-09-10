import { describe, expect, it } from 'vitest';

import {
  coatingContributor,
  coatingUsdPerPart,
  finishAreaSqIn,
  perimeterIn,
  platingContributor,
  platingUsdPerPart,
  powderCoverageSqFtPerLb,
  silkscreenContributor,
} from '../src/finish.js';
import { shopConfigFromSeed } from '../src/seed.js';
import type { CoatingModel } from '../src/types/config.js';
import type { PartInput } from '../src/types/part.js';
import golden from './fixtures/golden-workbook.json' with { type: 'json' };
import { seedBundle } from './helpers/seed-bundle.js';

/**
 * REQUIREMENTS §5.5 and §11.3, against the seeded catalog.
 *
 * The coating tests carry the weight here: quirk Q3's legacy model is what
 * reproduces §9, and its other side has to be a defensible number rather than
 * a hole (§11.3).
 */

const config = shopConfigFromSeed(seedBundle());

/** 13.38 × 7.858 — the §9 part, for its area and perimeter. */
function part(overrides: Partial<PartInput> = {}): PartInput {
  return {
    id: 'part-finish',
    partNumber: 'FINISH-TEST',
    materialId: 'material:g30-16-ga-0598',
    flatLengthIn: golden.part.flat_length_in,
    flatWidthIn: golden.part.flat_width_in,
    nesting: { machineId: 'machine:laser', stockWidthIn: 48, blankLengthIn: 96 },
    cutting: { model: 'none' },
    operations: [],
    finish: {},
    hardware: [],
    nre: [],
    ...overrides,
  };
}

const inputFor = (p: PartInput) => ({ part: p, quote: { parts: [p], quantityBreaks: [1] } });

describe('finish geometry (§5.5)', () => {
  it('takes the perimeter as 2(L + W)', () => {
    // The workbook's own 42.476 for the golden part.
    expect(perimeterIn(inputFor(part()))).toBeCloseTo(golden.coating.perimeter_in, 6);
  });

  it('falls back to the blank area when nothing was measured', () => {
    expect(finishAreaSqIn(inputFor(part()))).toBeCloseTo(golden.part.blank_area_sq_in, 6);
  });

  it('prefers a measured net area when the estimator has one', () => {
    expect(finishAreaSqIn(inputFor(part({ finishedAreaSqIn: 90 })))).toBe(90);
  });
});

describe('plating (§5.5)', () => {
  const spec = { lotMinimumUsd: 125, pricePerSqInUsd: 0.05, partMinimumUsd: 0.55 };
  const area = golden.part.blank_area_sq_in; // 105.14 in²

  it('charges the lot minimum when the quantity is small', () => {
    expect(platingUsdPerPart(spec, area, 1)).toBe(125);
  });

  it('charges the area rate once the lot minimum is spread thin', () => {
    // 0.05 × 105.14 = 5.257, against 125 ÷ 100 = 1.25.
    expect(platingUsdPerPart(spec, area, 100)).toBeCloseTo(0.05 * area, 6);
  });

  it('never goes below the per-part minimum', () => {
    const tiny = { ...spec, lotMinimumUsd: 0, pricePerSqInUsd: 0.0001 };
    expect(platingUsdPerPart(tiny, 1, 1000)).toBe(0.55);
  });

  it('prices nothing at a quantity of zero rather than dividing by it', () => {
    expect(platingUsdPerPart(spec, area, 0)).toBeCloseTo(0.05 * area, 6);
  });

  it('prices a seeded spec through the contributor', () => {
    const plated = part({
      finish: { platingSpecId: 'plating:anodize-chromic-mil-8625-type-i-class-1-dyed' },
    });
    const result = platingContributor.compute(inputFor(plated), config, 100);
    expect(result.usdPerPart).toBeGreaterThan(0);
    expect(result.warnings).toHaveLength(0);
  });

  it('costs nothing when the part is not plated', () => {
    expect(platingContributor.compute(inputFor(part()), config, 10).usdPerPart).toBe(0);
  });

  it('warns rather than pricing when the spec is not in the catalog', () => {
    const plated = part({ finish: { platingSpecId: 'plating:nope' } });
    const result = platingContributor.compute(inputFor(plated), config, 10);
    expect(result.usdPerPart).toBe(0);
    expect(result.warnings[0]?.code).toBe('missing-standard');
  });

  it('warns when a non-RoHS finish meets a customer who requires it (§11.2)', () => {
    const specs = config.platingSpecs.map((p) =>
      p.id === 'plating:anodize-chromic-mil-8625-type-i-class-1-dyed'
        ? { ...p, rohsCompliant: false }
        : p,
    );
    const plated = part({
      finish: { platingSpecId: 'plating:anodize-chromic-mil-8625-type-i-class-1-dyed' },
    });
    const result = platingContributor.compute(
      {
        part: plated,
        quote: {
          parts: [plated],
          quantityBreaks: [1],
          customer: { id: 'c1', name: 'Acme', rohsRequired: true },
        },
      },
      { ...config, platingSpecs: specs },
      10,
    );
    expect(result.warnings.map((w) => w.code)).toContain('non-rohs-finish');
    // A warning, never a block: the price still comes out (CLAUDE.md Design).
    expect(result.usdPerPart).toBeGreaterThan(0);
  });
});

describe('powder coverage (§11.3, verified against the trade)', () => {
  it('is 192.3 ft²/lb for a specific-gravity-1 powder at 1 mil, perfect transfer', () => {
    expect(powderCoverageSqFtPerLb(1, 1, 1)).toBeCloseTo(192.3, 6);
  });

  it('halves when the film doubles', () => {
    expect(powderCoverageSqFtPerLb(1.5, 2, 1)).toBeCloseTo(
      powderCoverageSqFtPerLb(1.5, 1, 1) / 2,
      6,
    );
  });

  it('scales with transfer efficiency', () => {
    // The trade's worked example: SG 1.5, 2 mils, 50% transfer.
    expect(powderCoverageSqFtPerLb(1.5, 2, 0.5)).toBeCloseTo(32.05, 4);
  });

  it('refuses to divide by a zero specific gravity or film build', () => {
    expect(powderCoverageSqFtPerLb(0, 2, 1)).toBe(0);
    expect(powderCoverageSqFtPerLb(1.5, 0, 1)).toBe(0);
  });
});

describe('coating (§5.5 quirk Q3, §11.3)', () => {
  const legacyModel: CoatingModel = {
    id: 'coating:powder',
    name: 'Powder',
    minimumChargeUsd: 0,
    legacy: { rateUsd: 0.5, coverage: 100, sConstant: 5 },
    modern: null,
  };
  const modernModel: CoatingModel = {
    ...legacyModel,
    modern: {
      specificGravity: 1.5,
      filmThicknessMils: 2,
      transferEfficiency: 0.6,
      powderPricePerLbUsd: 5,
      rackLaborUsdPerPart: 0.1,
      maskingUsdPerFeature: 0.05,
    },
  };
  const geometry = {
    perimeterIn: golden.coating.perimeter_in,
    areaSqIn: golden.part.blank_area_sq_in,
    sidesCoated: 2 as const,
    maskedFeatures: 0,
  };

  it('reproduces the $1.0619 the workbook charges, on the legacy model', () => {
    const { usd } = coatingUsdPerPart(legacyModel, { ...geometry, legacy: true });
    // Hand-derived from the seeded constants and the part's own perimeter,
    // not read from a workbook cell: rate x (perimeter / coverage x S).
    const expected = 0.5 * ((golden.coating.perimeter_in / 100) * 5);
    expect(expected).toBeCloseTo(1.0619, 4);
    expect(usd).toBeCloseTo(expected, 10);
  });

  it('prices the modern model off coated area and real coverage', () => {
    const { usd } = coatingUsdPerPart(modernModel, { ...geometry, legacy: false });
    // 192.3/1.5/2 × 0.6 = 38.46 ft²/lb; 105.14 × 2 sides ÷ 144 = 1.4603 ft².
    const coverage = 192.3 / 1.5 / 2 / (1 / 0.6);
    const expected = (golden.part.blank_area_sq_in * 2) / 144 / coverage * 5 + 0.1;
    expect(usd).toBeCloseTo(expected, 6);
  });

  it('charges masking per feature on the modern model', () => {
    const bare = coatingUsdPerPart(modernModel, { ...geometry, legacy: false }).usd;
    const masked = coatingUsdPerPart(modernModel, {
      ...geometry,
      maskedFeatures: 4,
      legacy: false,
    }).usd;
    expect(masked - bare).toBeCloseTo(4 * 0.05, 10);
  });

  it('charges one side at half of two', () => {
    const two = coatingUsdPerPart(modernModel, { ...geometry, legacy: false }).usd;
    const one = coatingUsdPerPart(modernModel, {
      ...geometry,
      sidesCoated: 1,
      legacy: false,
    }).usd;
    // Powder halves; racking does not.
    expect(one - 0.1).toBeCloseTo((two - 0.1) / 2, 10);
  });

  it('honours a minimum charge on either model', () => {
    const withFloor = { ...modernModel, minimumChargeUsd: 9 };
    expect(coatingUsdPerPart(withFloor, { ...geometry, legacy: true }).usd).toBe(9);
    expect(coatingUsdPerPart(withFloor, { ...geometry, legacy: false }).usd).toBe(9);
  });

  it('warns rather than charging zero when a model has no parameters (§11.3)', () => {
    const bare: CoatingModel = { ...legacyModel, legacy: null };
    const legacy = coatingUsdPerPart(bare, { ...geometry, legacy: true });
    expect(legacy.usd).toBe(0);
    expect(legacy.warning?.code).toBe('missing-standard');

    const modern = coatingUsdPerPart(legacyModel, { ...geometry, legacy: false });
    expect(modern.usd).toBe(0);
    expect(modern.warning?.message).toContain('specific gravity');
  });

  it('is unmarked, because quirk Q4 puts it outside the blocks', () => {
    expect(coatingContributor.markupClass).toBe('none');
    expect(coatingContributor.bucket).toBe('coating');
  });

  it('costs nothing when the part is not coated', () => {
    expect(coatingContributor.compute(inputFor(part()), config, 10).usdPerPart).toBe(0);
  });

  it('warns when the model is not in the catalog', () => {
    const coated = part({
      finish: { coating: { coatingModelId: 'coating:nope', sidesCoated: 1, maskedFeatures: 0 } },
    });
    const result = coatingContributor.compute(inputFor(coated), config, 10);
    expect(result.usdPerPart).toBe(0);
    expect(result.warnings[0]?.code).toBe('missing-standard');
  });

  it('surfaces a parameterless seeded model as a warning', () => {
    // "Liquid, Smooth" has no S constant in the workbook.
    const coated = part({
      finish: {
        coating: { coatingModelId: 'coating:liquid-smooth', sidesCoated: 1, maskedFeatures: 0 },
      },
    });
    const result = coatingContributor.compute(inputFor(coated), config, 10);
    expect(result.warnings[0]?.code).toBe('missing-standard');
  });
});

describe('silkscreen (§5.5)', () => {
  const screened = part({ finish: { silkscreenTierId: 'silkscreen:screen-price-0-50' } });

  it('amortises the screen charge and adds the print cost', () => {
    // Seeded tier: $75 screen, $0.50 a print.
    expect(silkscreenContributor.compute(inputFor(screened), config, 1).usdPerPart).toBeCloseTo(
      75.5,
      6,
    );
    expect(silkscreenContributor.compute(inputFor(screened), config, 100).usdPerPart).toBeCloseTo(
      0.75 + 0.5,
      6,
    );
  });

  it('is unmarked alongside coating (quirk Q4)', () => {
    expect(silkscreenContributor.markupClass).toBe('none');
  });

  it('costs nothing when the part is not screened', () => {
    expect(silkscreenContributor.compute(inputFor(part()), config, 10).usdPerPart).toBe(0);
  });

  it('warns when the tier is not in the catalog', () => {
    const bad = part({ finish: { silkscreenTierId: 'silkscreen:nope' } });
    const result = silkscreenContributor.compute(inputFor(bad), config, 10);
    expect(result.usdPerPart).toBe(0);
    expect(result.warnings[0]?.code).toBe('missing-standard');
  });

  it('says so when the customer supplies the screen', () => {
    const customerScreen = part({
      finish: { silkscreenTierId: 'silkscreen:screen-price-customer' },
    });
    const result = silkscreenContributor.compute(inputFor(customerScreen), config, 10);
    expect(result.warnings[0]?.message).toContain('customer supplies');
    expect(result.usdPerPart).toBe(0);
  });

  it('prices nothing at a quantity of zero rather than dividing by it', () => {
    expect(silkscreenContributor.compute(inputFor(screened), config, 0).usdPerPart).toBe(0.5);
  });
});
