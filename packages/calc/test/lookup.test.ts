import { describe, expect, it } from 'vitest';

import {
  effectiveRatePerHrUsd,
  findMachine,
  findMachineMaterialRate,
  findMaterial,
  findOperation,
} from '../src/lookup.js';
import type { Operation } from '../src/types/config.js';
import {
  GOLDEN_MACHINE_ID,
  GOLDEN_MATERIAL_ID,
  goldenConfig,
} from './helpers/golden-config.js';

/**
 * REQUIREMENTS §12 rule 3: missing data produces a visible warning, never a
 * silent default. These lookups are where that starts — every one of them
 * returns `undefined` rather than inventing a row, so the caller has to decide
 * what the estimator is told.
 */
describe('config lookups (§12 rule 3)', () => {
  const config = goldenConfig();

  it('finds catalog rows by id', () => {
    expect(findMaterial(config, GOLDEN_MATERIAL_ID)?.lbPerSqFt).toBeGreaterThan(0);
    expect(findMachine(config, GOLDEN_MACHINE_ID)?.name).toBe('Laser 1');
    expect(findOperation(config, 'operation-laser')?.kind).toBe('machine');
  });

  it('returns undefined for ids this shop does not have', () => {
    expect(findMaterial(config, 'material-nope')).toBeUndefined();
    expect(findMachine(config, 'machine-nope')).toBeUndefined();
    expect(findOperation(config, 'operation-nope')).toBeUndefined();
  });

  it('finds the machine-material pairing', () => {
    const rate = findMachineMaterialRate(config, GOLDEN_MACHINE_ID, GOLDEN_MATERIAL_ID);
    expect(rate?.cutSpeedInPerMin).toBeGreaterThan(0);
  });

  it('does not default a missing machine-material pairing', () => {
    // "No speed for Laser 2 x 304 SS 11 ga" is a warning the estimator acts
    // on, not a number calc makes up.
    expect(findMachineMaterialRate(config, 'machine-laser-2', GOLDEN_MATERIAL_ID)).toBeUndefined();
    expect(findMachineMaterialRate(config, GOLDEN_MACHINE_ID, 'material-nope')).toBeUndefined();
  });
});

describe('effective rate (§3)', () => {
  const config = goldenConfig();
  const base: Operation = {
    id: 'operation-test',
    name: 'TEST',
    machineId: null,
    kind: 'manual',
    setupHrs: 0,
    standardPerHr: 100,
    standardUnit: 'pieces',
    ratePerHrUsd: null,
    active: true,
  };

  it("uses the operation's own rate when it has one", () => {
    expect(effectiveRatePerHrUsd(config, { ...base, ratePerHrUsd: 75 })).toBe(75);
  });

  it('inherits the machine rate, with consumables folded in', () => {
    const machine = config.machines[0];
    if (machine === undefined) throw new Error('fixture config has no machine');
    machine.consumablesPerHrUsd = 12;

    const rate = effectiveRatePerHrUsd(config, { ...base, machineId: GOLDEN_MACHINE_ID });
    expect(rate).toBe(machine.ratePerHrUsd + 12);
  });

  it('has no rate when neither the operation nor a machine supplies one', () => {
    expect(effectiveRatePerHrUsd(config, base)).toBeUndefined();
    expect(effectiveRatePerHrUsd(config, { ...base, machineId: 'machine-nope' })).toBeUndefined();
  });
});
