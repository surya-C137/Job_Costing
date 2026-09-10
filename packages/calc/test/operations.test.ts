import { describe, expect, it } from 'vitest';

import {
  directLaborContributor,
  directLaborUsd,
  operationHoursPerPart,
  setupContributor,
  setupCostUsd,
} from '../src/operations.js';
import { machineId, materialId, operationId, shopConfigFromSeed } from '../src/seed.js';
import type { ShopConfig } from '../src/types/config.js';
import type { PartInput } from '../src/types/part.js';
import golden from './fixtures/golden-workbook.json' with { type: 'json' };
import { seedBundle } from './helpers/seed-bundle.js';

/**
 * REQUIREMENTS §5.4, against the seeded catalog.
 *
 * The load-bearing case is quirk Q2: machine time is billed at
 * `parity.machineTimeFactor`, manual time is not. It is a number rather than a
 * boolean precisely so these tests can dial it.
 */

const config = shopConfigFromSeed(seedBundle());

function part(overrides: Partial<PartInput> = {}): PartInput {
  return {
    id: 'part-ops',
    partNumber: 'OPS-TEST',
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
    operations: [],
    finish: {},
    hardware: [],
    nre: [],
    ...overrides,
  };
}

const inputFor = (p: PartInput) => ({ part: p, quote: { parts: [p], quantityBreaks: [1] } });

/** The seeded config with one parity flag moved. */
function withParity(over: Partial<ShopConfig['parity']>): ShopConfig {
  return { ...config, parity: { ...config.parity, ...over } };
}

describe('manual operation hours (§5.4)', () => {
  it('divides the count by the standard', () => {
    // 222 bends an hour, four bends on the part.
    expect(operationHoursPerPart(222, 4)).toBeCloseTo(4 / 222, 10);
  });

  it('costs nothing when there is no standard to divide by', () => {
    expect(operationHoursPerPart(null, 4)).toBe(0);
    expect(operationHoursPerPart(0, 4)).toBe(0);
  });
});

describe('setup, and the job fixed cost (§5.6)', () => {
  it('rolls up every operation’s setup', () => {
    const p = part({ operations: [{ operationId: operationId('laser'), countPerPart: 1 }] });
    // The laser is the only seeded operation carrying setup: 0.2 h × $100.
    expect(setupCostUsd(inputFor(p), config).usd).toBeCloseTo(20, 6);
  });

  it('adds the estimator’s own one-off labour', () => {
    const p = part({
      operations: [{ operationId: operationId('laser'), countPerPart: 1 }],
      setupExtraLaborUsd: 45,
    });
    expect(setupCostUsd(inputFor(p), config).usd).toBeCloseTo(65, 6);
  });

  it('amortises over the quantity, so a one-off carries all of it', () => {
    const p = part({ operations: [{ operationId: operationId('laser'), countPerPart: 1 }] });
    expect(setupContributor.compute(inputFor(p), config, 1).usdPerPart).toBeCloseTo(20, 6);
    expect(setupContributor.compute(inputFor(p), config, 50).usdPerPart).toBeCloseTo(0.4, 6);
  });

  it('adds the shop’s flat charge when one is set', () => {
    const flat = { ...config, defaults: { ...config.defaults, shopFixedCostPerJobUsd: 30 } };
    const p = part({ operations: [{ operationId: operationId('laser'), countPerPart: 1 }] });
    expect(setupContributor.compute(inputFor(p), flat, 1).usdPerPart).toBeCloseTo(50, 6);
  });

  it('prices nothing at a quantity of zero rather than dividing by it', () => {
    const p = part({ operations: [{ operationId: operationId('laser'), countPerPart: 1 }] });
    expect(setupContributor.compute(inputFor(p), config, 0).usdPerPart).toBe(0);
  });

  it('warns about an operation that is not in the catalog', () => {
    const p = part({ operations: [{ operationId: 'operation:nope', countPerPart: 1 }] });
    const { usd, warnings } = setupCostUsd(inputFor(p), config);
    expect(usd).toBe(0);
    expect(warnings[0]?.code).toBe('missing-standard');
  });

  it('warns about an operation with no rate and no machine to inherit one', () => {
    const rateless = {
      ...config,
      operations: config.operations.map((o) =>
        o.id === operationId('brake-bend') ? { ...o, ratePerHrUsd: null, machineId: null } : o,
      ),
    };
    const p = part({ operations: [{ operationId: operationId('brake-bend'), countPerPart: 4 }] });
    expect(setupCostUsd(inputFor(p), rateless).warnings[0]?.message).toContain('no rate');
  });
});

describe('direct labour and quirk Q2 (§5.4, §5.7)', () => {
  const lasered = part({ operations: [{ operationId: operationId('laser'), countPerPart: 1 }] });

  it('bills machine time at the parity factor', () => {
    const { usd, hoursPerPart } = directLaborUsd(inputFor(lasered), config);
    expect(hoursPerPart).toBeCloseTo(golden.intermediates.laser_hours_per_part, 8);
    // 0.0052255 h × $100 × 0.6 — the workbook's $0.31353.
    expect(usd).toBeCloseTo(0.3135272727272727, 8);
  });

  it('bills machine time as machine time with the flag at 1.0 (§11.3)', () => {
    const { usd } = directLaborUsd(inputFor(lasered), withParity({ machineTimeFactor: 1 }));
    // The flag's other side is a real number, not zero: 0.6 -> 1.0 is +66%.
    expect(usd).toBeCloseTo(0.3135272727272727 / 0.6, 8);
  });

  it('does not apply the factor to manual operations', () => {
    const bent = part({
      cutting: { model: 'none' },
      operations: [{ operationId: operationId('brake-bend'), countPerPart: 4 }],
    });
    const { usd } = directLaborUsd(inputFor(bent), config);
    // 4 bends at 222/hr and $75/hr, undiminished.
    expect(usd).toBeCloseTo((4 / 222) * 75, 8);
  });

  it('counts a linear standard in the operation’s own unit', () => {
    // WELD is seeded as inches, so the count is inches of weld.
    const welded = part({
      cutting: { model: 'none' },
      operations: [{ operationId: operationId('weld'), countPerPart: 11 }],
    });
    const weld = config.operations.find((o) => o.id === operationId('weld'));
    expect(weld?.standardUnit).toBe('inches');
    expect(directLaborUsd(inputFor(welded), config).usd).toBeCloseTo((11 / 200) * 75, 8);
  });

  it('charges the cutting time once, to the machine that did the cutting', () => {
    // Two machine operations on the part; only the laser ran the cut.
    const both = part({
      operations: [
        { operationId: operationId('laser'), countPerPart: 1 },
        { operationId: operationId('pega-50-x-72'), countPerPart: 1 },
      ],
    });
    const { hoursPerPart } = directLaborUsd(inputFor(both), config);
    expect(hoursPerPart).toBeCloseTo(golden.intermediates.laser_hours_per_part, 8);
  });

  it('warns when a manual operation has a count but no standard', () => {
    const standardless = {
      ...config,
      operations: config.operations.map((o) =>
        o.id === operationId('brake-bend') ? { ...o, standardPerHr: null } : o,
      ),
    };
    const bent = part({
      cutting: { model: 'none' },
      operations: [{ operationId: operationId('brake-bend'), countPerPart: 4 }],
    });
    const { usd, warnings } = directLaborUsd(inputFor(bent), standardless);
    expect(usd).toBe(0);
    expect(warnings.map((w) => w.code)).toContain('missing-standard');
  });

  it('passes the cutting resolver’s own warnings through', () => {
    const noRates = { ...config, machineMaterialRates: [] };
    const { warnings } = directLaborUsd(inputFor(lasered), noRates);
    expect(warnings.map((w) => w.code)).toContain('missing-machine-material-rate');
  });

  it('skips operations it already warned about, without pricing them', () => {
    const p = part({
      cutting: { model: 'none' },
      operations: [{ operationId: 'operation:nope', countPerPart: 1 }],
    });
    expect(directLaborUsd(inputFor(p), config).usd).toBe(0);
  });

  it('reports hours as detail for the estimator’s screen', () => {
    const result = directLaborContributor.compute(inputFor(lasered), config, 100);
    expect(result.detail?.['hoursPerPart']).toBeCloseTo(
      golden.intermediates.laser_hours_per_part,
      8,
    );
  });

  it('is the same at every quantity, unlike setup', () => {
    const one = directLaborContributor.compute(inputFor(lasered), config, 1).usdPerPart;
    const hundred = directLaborContributor.compute(inputFor(lasered), config, 100).usdPerPart;
    expect(one).toBeCloseTo(hundred, 12);
  });
});
