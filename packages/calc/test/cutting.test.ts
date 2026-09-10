import { describe, expect, it } from 'vitest';

import { blanksPerSheet, cuttingHoursForPart } from '../src/cutting.js';
import { cutLengthIn, featureCutLengthIn, laserHoursPerPart, pierceCount } from '../src/laser.js';
import { punchHoursPerPart } from '../src/punch.js';
import type { CutFeature, PartInput } from '../src/types/part.js';
import golden from './fixtures/golden-workbook.json' with { type: 'json' };
import {
  GOLDEN_MACHINE_ID,
  GOLDEN_MATERIAL_ID,
  goldenConfig,
  goldenPart,
  quoteFor,
} from './helpers/golden-config.js';

/**
 * REQUIREMENTS §5.2 and §5.3.
 *
 * The laser case is the fifth of the engine's five intermediates and this
 * file's reason to exist: 0.0052255 hours per part, read from the fixture.
 * BUILD-PLAN 1.3 asks for five decimals; these assert eight.
 */

/** The §9 laser case, as explicit numbers. */
const goldenLaser = {
  features: [] as CutFeature[],
  perimeterCutIn: golden.laser.perimeter_cut_in,
  intersections: golden.laser.intersections,
  cutSpeedInPerMin: golden.material.speed_in_min,
  pierceSeconds: golden.material.pierce_s,
  // 33 up on a 96-inch blank cut from 120-inch stock: 33 × 1.25.
  partsPerSheet: golden.nesting.parts_per_blank * (golden.material.std_length_in / golden.nesting.blank_length_in),
  palletChangeSec: golden.laser.pallet_change_s,
  palletBatchParts: 100,
  intersectionSec: 0.3,
  rapidSecPerPierce: 0.6,
  lossFactor: 1.08,
};

describe('cut length and pierces (§5.2)', () => {
  it('measures a hole as its circumference, times how many there are', () => {
    expect(featureCutLengthIn({ shape: 'hole', diameterIn: 2, count: 3 })).toBeCloseTo(
      Math.PI * 2 * 3,
      10,
    );
  });

  it('measures an obround as two flanks plus a full circle of end radii', () => {
    // A 4 × 1 slot: two 3-inch flanks plus a 1-inch circle.
    expect(featureCutLengthIn({ shape: 'obround', lengthIn: 4, widthIn: 1, count: 1 })).toBeCloseTo(
      3 * 2 + Math.PI,
      10,
    );
  });

  it('collapses to a circle when an obround is as wide as it is long', () => {
    expect(featureCutLengthIn({ shape: 'obround', lengthIn: 2, widthIn: 2, count: 1 })).toBeCloseTo(
      Math.PI * 2,
      10,
    );
  });

  it('measures a rectangle as its perimeter', () => {
    // The workbook's own E17: 2 × (2.412 + 4.0) = 12.824.
    expect(featureCutLengthIn({ shape: 'rect', lengthIn: 2.412, widthIn: 4, count: 1 })).toBeCloseTo(
      12.824,
      10,
    );
  });

  it('takes a misc feature at the length entered', () => {
    expect(featureCutLengthIn({ shape: 'misc', cutLengthIn: 7.5, count: 2 })).toBe(15);
  });

  it('adds every feature to the outside profile', () => {
    const features: CutFeature[] = [
      { shape: 'hole', diameterIn: 1, count: 4 },
      { shape: 'rect', lengthIn: 2, widthIn: 3, count: 1 },
    ];
    expect(cutLengthIn(features, 58)).toBeCloseTo(58 + Math.PI * 4 + 10, 10);
  });

  it('pierces once per feature instance plus once for the profile', () => {
    expect(pierceCount([])).toBe(1);
    expect(pierceCount([{ shape: 'hole', diameterIn: 0.25, count: 200 }])).toBe(201);
    expect(
      pierceCount([
        { shape: 'hole', diameterIn: 1, count: 4 },
        { shape: 'obround', lengthIn: 2, widthIn: 1, count: 2 },
      ]),
    ).toBe(7);
  });
});

describe('laser hours (§5.2, §9 oracle)', () => {
  it('reproduces the golden 0.0052255 hours per part', () => {
    const { hoursPerPart } = laserHoursPerPart(goldenLaser);
    expect(hoursPerPart).toBeCloseTo(golden.intermediates.laser_hours_per_part, 8);
  });

  it("matches the workbook's per-100 display of 0.52255", () => {
    // §11.4 item 5: per 100 is a display convention, converted at the edge.
    const { hoursPerPart } = laserHoursPerPart(goldenLaser);
    expect(hoursPerPart * 100).toBeCloseTo(0.5225454545, 8);
  });

  it("breaks down to the worksheet's own cells", () => {
    const { detail } = laserHoursPerPart(goldenLaser);
    expect(detail.cutHrs).toBeCloseTo(0.004393939393939394, 12); // F29
    expect(detail.pierceHrs).toBeCloseTo(2.777777777777778e-5, 12); // B27
    expect(detail.intersectionHrs).toBeCloseTo(8.333333333333333e-5, 12); // F31
    expect(detail.rapidHrs).toBeCloseTo(1.6666666666666666e-4, 12); // F32
    expect(detail.palletHrs).toBeCloseTo(1.6666666666666666e-4, 12); // F33
  });

  it('charges no pallet change when one sheet already yields a whole batch', () => {
    const { detail } = laserHoursPerPart({ ...goldenLaser, partsPerSheet: 150 });
    expect(detail.palletHrs).toBe(0);
  });

  it('spreads the pallet change over the batch, not over the sheet', () => {
    // 60 s ÷ 100 parts, whatever the sheet yields — see the §5.2 note.
    for (const partsPerSheet of [2, 41.25, 99]) {
      const { detail } = laserHoursPerPart({ ...goldenLaser, partsPerSheet });
      expect(detail.palletHrs).toBeCloseTo(60 / 100 / 3600, 12);
    }
  });

  it('prices a part with no features at all', () => {
    const { hoursPerPart, detail } = laserHoursPerPart({
      ...goldenLaser,
      features: [],
      perimeterCutIn: 0,
      intersections: 0,
    });
    expect(detail.cutLengthIn).toBe(0);
    expect(detail.pierces).toBe(1); // the profile pierce still happens
    expect(hoursPerPart).toBeGreaterThan(0);
  });

  it('prices a 200-hole part, where pierces dominate', () => {
    const holes: CutFeature[] = [{ shape: 'hole', diameterIn: 0.25, count: 200 }];
    const { hoursPerPart, detail } = laserHoursPerPart({ ...goldenLaser, features: holes });

    expect(detail.pierces).toBe(201);
    expect(detail.cutLengthIn).toBeCloseTo(58 + Math.PI * 0.25 * 200, 6);
    // 201 pierces at 0.1 s plus 201 rapids at 0.6 s is 140.7 s of the total.
    expect(detail.pierceHrs + detail.rapidHrs).toBeCloseTo((201 * 0.7) / 3600, 10);
    expect(hoursPerPart).toBeGreaterThan(
      laserHoursPerPart(goldenLaser).hoursPerPart,
    );
  });

  it('applies the loss factor to the whole of the time', () => {
    const withLoss = laserHoursPerPart(goldenLaser).hoursPerPart;
    const without = laserHoursPerPart({ ...goldenLaser, lossFactor: 1 }).hoursPerPart;
    expect(withLoss / without).toBeCloseTo(1.08, 12);
  });

  it('yields no cut time rather than Infinity when the speed is missing', () => {
    const { detail } = laserHoursPerPart({ ...goldenLaser, cutSpeedInPerMin: 0 });
    expect(detail.cutHrs).toBe(0);
    expect(Number.isFinite(detail.cutHrs)).toBe(true);
  });
});

describe('punch hours (§5.3)', () => {
  const bridges = { name: 'Bridges', hitsPerHr: 5000, multiplier: 1 };
  const emboss = { name: 'Emboss', hitsPerHr: 3500, multiplier: 1 };

  it('prices 40 bridges and 4 embosses', () => {
    const { hoursPerPart, detail } = punchHoursPerPart({
      hits: [
        { ...bridges, countPerPart: 40 },
        { ...emboss, countPerPart: 4 },
      ],
      punchRateFactor: 1,
      partsPerBlank: 33,
      loadUnloadSecPerBlank: 40,
      lossFactor: 1,
    });

    const expectedHitHrs = 40 / 5000 + 4 / 3500;
    const expectedLoadUnload = 40 / 33 / 3600;
    expect(detail.chargeableHits).toBe(44);
    expect(detail.hitHrs).toBeCloseTo(expectedHitHrs, 10);
    expect(detail.loadUnloadHrs).toBeCloseTo(expectedLoadUnload, 10);
    expect(hoursPerPart).toBeCloseTo(expectedHitHrs + expectedLoadUnload, 10);
  });

  it('charges a tool multiplier per strike', () => {
    // A countersink costs three hits (§5.3 / the seeded tool table).
    const { detail } = punchHoursPerPart({
      hits: [{ name: 'Countersink', hitsPerHr: 4500, multiplier: 3, countPerPart: 10 }],
      punchRateFactor: 1,
      partsPerBlank: 1,
      loadUnloadSecPerBlank: 0,
      lossFactor: 1,
    });
    expect(detail.chargeableHits).toBe(30);
    expect(detail.hitHrs).toBeCloseTo(30 / 4500, 10);
  });

  it('slows down for a material that punches harder', () => {
    const base = {
      hits: [{ ...bridges, countPerPart: 100 }],
      partsPerBlank: 10,
      loadUnloadSecPerBlank: 0,
      lossFactor: 1,
    };
    const easy = punchHoursPerPart({ ...base, punchRateFactor: 1 }).hoursPerPart;
    const hard = punchHoursPerPart({ ...base, punchRateFactor: 0.6 }).hoursPerPart;
    expect(hard).toBeCloseTo(easy / 0.6, 10);
  });

  it('amortises load and unload over the blank', () => {
    const one = punchHoursPerPart({
      hits: [],
      punchRateFactor: 1,
      partsPerBlank: 1,
      loadUnloadSecPerBlank: 40,
      lossFactor: 1,
    });
    const many = punchHoursPerPart({
      hits: [],
      punchRateFactor: 1,
      partsPerBlank: 40,
      loadUnloadSecPerBlank: 40,
      lossFactor: 1,
    });
    expect(one.detail.loadUnloadHrs).toBeCloseTo(40 / 3600, 10);
    expect(many.detail.loadUnloadHrs).toBeCloseTo(one.detail.loadUnloadHrs / 40, 10);
  });

  it('yields no time rather than Infinity on a zero rate', () => {
    const { hoursPerPart } = punchHoursPerPart({
      hits: [{ ...bridges, hitsPerHr: 0, countPerPart: 10 }],
      punchRateFactor: 1,
      partsPerBlank: 0,
      loadUnloadSecPerBlank: 40,
      lossFactor: 1,
    });
    expect(hoursPerPart).toBe(0);
  });
});

describe('blanksPerSheet (§5.2)', () => {
  it('is fractional: 120-inch stock cut to 96 gives 1.25', () => {
    expect(blanksPerSheet(120, 96)).toBe(1.25);
  });

  it('falls back to one whole blank when the stock length is unknown', () => {
    expect(blanksPerSheet(null, 96)).toBe(1);
    expect(blanksPerSheet(0, 96)).toBe(1);
    expect(blanksPerSheet(120, 0)).toBe(1);
  });
});

describe('cuttingHoursForPart — resolution from config (§12)', () => {
  it('reproduces the golden laser hours through a ShopConfig', () => {
    const part = goldenPart();
    const result = cuttingHoursForPart({ part, quote: quoteFor(part) }, goldenConfig());

    expect(result.warnings).toHaveLength(0);
    expect(result.hoursPerPart).toBeCloseTo(golden.intermediates.laser_hours_per_part, 8);
    expect(result.detail['partsPerSheet']).toBeCloseTo(41.25, 10);
  });

  it('takes speed and pierce from the machine-material rate, not the material row', () => {
    const config = goldenConfig();
    const rate = config.machineMaterialRates[0];
    if (rate === undefined) throw new Error('fixture config has no machine-material rate');
    rate.cutSpeedInPerMin = 440; // twice as fast

    const part = goldenPart();
    const result = cuttingHoursForPart({ part, quote: quoteFor(part) }, config);
    const slower = golden.intermediates.laser_hours_per_part;
    expect(result.hoursPerPart).toBeLessThan(slower);
    expect(result.detail['cutHrs']).toBeCloseTo(58 / 440 / 60, 12);
  });

  it('takes the timing constants from the machine row', () => {
    const config = goldenConfig();
    const machine = config.machines[0];
    if (machine === undefined) throw new Error('fixture config has no machine');
    machine.lossFactor = 1;

    const part = goldenPart();
    const result = cuttingHoursForPart({ part, quote: quoteFor(part) }, config);
    expect(result.hoursPerPart).toBeCloseTo(golden.intermediates.laser_hours_per_part / 1.08, 10);
  });

  it('warns instead of throwing when the pairing has no rate', () => {
    const config = goldenConfig();
    config.machineMaterialRates = [];

    const part = goldenPart();
    const result = cuttingHoursForPart({ part, quote: quoteFor(part) }, config);
    expect(result.hoursPerPart).toBe(0);
    expect(result.warnings[0]?.code).toBe('missing-machine-material-rate');
    expect(result.warnings[0]?.message).toContain('Laser 1');
    expect(result.warnings[0]?.message).toContain(golden.material.name);
  });

  it('costs nothing and warns about nothing when there is no cutting', () => {
    const part: PartInput = { ...goldenPart(), cutting: { model: 'none' } };
    const result = cuttingHoursForPart({ part, quote: quoteFor(part) }, goldenConfig());
    expect(result.hoursPerPart).toBe(0);
    expect(result.warnings).toHaveLength(0);
  });

  it('warns when the cut entered does not match the machine', () => {
    const part: PartInput = { ...goldenPart(), cutting: { model: 'hitBased', hits: [] } };
    const result = cuttingHoursForPart({ part, quote: quoteFor(part) }, goldenConfig());
    expect(result.warnings[0]?.code).toBe('cutting-model-mismatch');
    expect(result.hoursPerPart).toBe(0);
  });

  it('warns on an unknown machine or material rather than pricing', () => {
    const base = goldenPart();
    const noMachine: PartInput = {
      ...base,
      nesting: { ...base.nesting, machineId: 'machine-nope' },
    };
    expect(
      cuttingHoursForPart({ part: noMachine, quote: quoteFor(noMachine) }, goldenConfig())
        .warnings[0]?.message,
    ).toContain('machine-nope');

    const noMaterial: PartInput = { ...base, materialId: 'material-nope' };
    expect(
      cuttingHoursForPart({ part: noMaterial, quote: quoteFor(noMaterial) }, goldenConfig())
        .warnings[0]?.message,
    ).toContain('material-nope');
  });

  it('warns when the part does not fit, since the nest sets the amortisation', () => {
    const part: PartInput = { ...goldenPart(), flatLengthIn: 60, flatWidthIn: 60 };
    const result = cuttingHoursForPart({ part, quote: quoteFor(part) }, goldenConfig());
    expect(result.warnings[0]?.code).toBe('part-does-not-fit');
    expect(result.hoursPerPart).toBe(0);
  });

  it('warns when the machine cannot cut the stock at all', () => {
    const config = goldenConfig();
    const rate = config.machineMaterialRates[0];
    if (rate === undefined) throw new Error('fixture config has no machine-material rate');
    rate.cutSpeedInPerMin = 0;

    const part = goldenPart();
    const result = cuttingHoursForPart({ part, quote: quoteFor(part) }, config);
    expect(result.warnings[0]?.code).toBe('material-not-cuttable');
  });
});

describe('cuttingHoursForPart — the punch path (§5.3)', () => {
  /** The golden config with its laser swapped for a turret punch. */
  function punchConfig() {
    const config = goldenConfig();
    const machine = config.machines[0];
    if (machine === undefined) throw new Error('fixture config has no machine');
    machine.kind = 'punch';
    machine.timeModel = 'hitBased';
    machine.lossFactor = 1;
    machine.hitRates = [
      { id: 'tool-bridges', name: 'Bridges', hitsPerHr: 5000, multiplier: 1 },
      { id: 'tool-emboss', name: 'Emboss', hitsPerHr: 3500, multiplier: 1 },
    ];
    return config;
  }

  function punchPart(): PartInput {
    return {
      ...goldenPart(),
      cutting: {
        model: 'hitBased',
        hits: [
          { hitRateId: 'tool-bridges', countPerPart: 40 },
          { hitRateId: 'tool-emboss', countPerPart: 4 },
        ],
      },
    };
  }

  it('prices 40 bridges and 4 embosses through a ShopConfig', () => {
    const part = punchPart();
    const result = cuttingHoursForPart({ part, quote: quoteFor(part) }, punchConfig());

    expect(result.warnings).toHaveLength(0);
    expect(result.detail['chargeableHits']).toBe(44);
    // Nested 33 up, so load/unload is 40 s spread across the blank.
    expect(result.detail['partsPerBlank']).toBe(golden.nesting.parts_per_blank);
    expect(result.hoursPerPart).toBeCloseTo(40 / 5000 + 4 / 3500 + 40 / 33 / 3600, 10);
  });

  it('skips a tool the machine does not have, and says so', () => {
    const part: PartInput = {
      ...goldenPart(),
      cutting: { model: 'hitBased', hits: [{ hitRateId: 'tool-nope', countPerPart: 10 }] },
    };
    const result = cuttingHoursForPart({ part, quote: quoteFor(part) }, punchConfig());
    expect(result.warnings[0]?.code).toBe('unknown-punch-tool');
    // Load/unload still applies: the blank was still handled.
    expect(result.detail['chargeableHits']).toBe(0);
  });

  it('refuses stock with a zero punch rate factor', () => {
    const config = punchConfig();
    const rate = config.machineMaterialRates[0];
    if (rate === undefined) throw new Error('fixture config has no machine-material rate');
    rate.punchRateFactor = 0; // the workbook seeds this against quarter-inch plate

    const part = punchPart();
    const result = cuttingHoursForPart({ part, quote: quoteFor(part) }, config);
    expect(result.warnings[0]?.code).toBe('material-not-cuttable');
    expect(result.hoursPerPart).toBe(0);
  });

  it('uses the same machine and material ids as the nest', () => {
    const config = punchConfig();
    expect(config.machines[0]?.id).toBe(GOLDEN_MACHINE_ID);
    expect(config.materials[0]?.id).toBe(GOLDEN_MATERIAL_ID);
  });
});
