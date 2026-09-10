import { describe, expect, it } from 'vitest';

import {
  ALL_SHEET_METAL_MODULES,
  machineId,
  materialId,
  operationId,
  shopConfigFromSeed,
  type SeedBundle,
} from '../src/seed.js';
import { seedBundle } from './helpers/seed-bundle.js';

/**
 * REQUIREMENTS §3 and §12 — turning the workbook's shape into the app's.
 *
 * The sparse-bundle cases below are not hypothetical. A shop onboarding
 * without a workbook (Task 2.1's `seed-blank.ts`) hands over exactly this:
 * names and little else. Every fallback here should produce a config that
 * loads and warns, rather than one that throws or quietly invents a rate.
 */

/** A bundle with nothing filled in beyond what the types demand. */
function sparseBundle(): SeedBundle {
  return {
    materials: [
      {
        key: 'mystery',
        name: 'MYSTERY STOCK',
        family: 'other',
        thickness_in: null,
        lb_per_sq_ft: 1,
        price_per_lb: 1,
        std_length_in: null,
        speed_in_min: null,
        pierce_s: null,
        punch_rate_factor: null,
        sheet_cost: null,
        sheet_lbs: null,
        active: true,
      },
    ],
    operations: [
      {
        key: 'bench',
        name: 'BENCH',
        kind: 'manual',
        machine_key: null,
        setup_hrs: null,
        standard_per_hr: null,
        standard_unit: null,
        rate_per_hr: null,
        active: true,
      },
    ],
    machines: [
      {
        key: 'mystery-machine',
        name: 'Mystery Machine',
        kind: 'sawing',
        time_model: 'none',
        rate_per_hr: null,
        clamp_in: null,
        kerf_in: null,
        load_unload_s_per_blank: null,
        pallet_change_s: null,
        pallet_batch_parts: null,
        intersection_s: null,
        rapid_s_per_pierce: null,
        loss_factor: null,
      },
    ],
    punchTools: {
      tools: [{ key: 't', name: 'T', multiplier: null, hit_rate_per_hr: null }],
      load_unload_s_per_blank: 40,
    },
    plating: [
      {
        key: 'p',
        spec: 'SOME PLATING',
        lot_min_charge: null,
        price_per_sq_in: null,
        part_min: null,
        active: true,
      },
    ],
    coating: {
      models: [
        { key: 'bare', name: 'Bare', legacy: null, modern: null },
        {
          key: 'partial',
          name: 'Partial',
          legacy: { s_constant: null, coverage: 75, rate: null },
          modern: null,
        },
      ],
      adders: {},
      liquid_texture_adder_pct: 0.5,
    },
    silkscreen: [
      { key: 's', spec: 'SOME SCREEN', screen_cost: null, print_cost: null, active: false },
    ],
    assemblyStandards: [{ key: 'a', section: null, action: 'DO A THING', std_seconds: 5 }],
    blanks: { standard_blank_lengths_in: [48], sheet_widths_in: [36, 48] },
    defaults: {
      shop_fixed_cost_per_job: 0,
      labor_markup: 1,
      material_markup: 1,
      nre_rate_per_hr: 0,
      nre_markup: 1,
      min_charge_strip_in: 12,
      default_qty_breaks: [1],
      sheet_widths_in: [48],
    },
  };
}

describe('the seeded workbook (§3)', () => {
  const config = shopConfigFromSeed(seedBundle());

  it('derives a family row per distinct family string', () => {
    const names = config.families.map((f) => f.name);
    expect(names).toContain('galv');
    expect(names).toContain('aluminum');
    expect(new Set(names).size).toBe(names.length);
  });

  it('links a machine operation to the machine it runs on', () => {
    const laser = config.operations.find((o) => o.id === operationId('laser'));
    expect(laser?.machineId).toBe(machineId('laser'));
    expect(laser?.kind).toBe('machine');

    const bend = config.operations.find((o) => o.id === operationId('brake-bend'));
    expect(bend?.machineId).toBeNull();
    expect(bend?.standardUnit).toBe('pieces');
  });

  it('crosses stock widths with each material own standard length', () => {
    const g30 = config.stockSizes.filter((s) => s.materialId === materialId('g30-16-ga-0598'));
    expect(g30).toHaveLength(3); // 36, 48, 60
    expect(g30.every((s) => s.lengthIn === 120)).toBe(true);
    expect(g30.filter((s) => s.preferred)).toHaveLength(1);
  });

  it('builds a rate for every machine and material pairing', () => {
    expect(config.machineMaterialRates).toHaveLength(
      config.machines.length * config.materials.length,
    );
  });

  it('leaves gauge tables empty, the workbook carrying lb/ft² directly', () => {
    expect(config.gauges).toEqual([]);
  });

  it('defaults to the workbook on every parity flag (§5.7)', () => {
    expect(config.parity).toEqual({
      markupInsideMinChargeMax: true,
      machineTimeFactor: 0.6,
      legacyCoatingModel: true,
      finishesUnmarked: true,
    });
  });

  it('enables the whole sheet-metal trade', () => {
    expect(config.enabledModules).toEqual(ALL_SHEET_METAL_MODULES);
  });

  it('keeps the six quantity breaks the shop customers know (§11.5)', () => {
    expect(config.defaults.defaultQuantityBreaks).toEqual([1, 5, 10, 30, 50, 100]);
  });

  it('carries price provenance where the workbook had it', () => {
    const withProvenance = config.materials.filter((m) => m.sheetCostUsd !== null);
    expect(withProvenance.length).toBeGreaterThan(0);
    for (const m of withProvenance) {
      expect(m.sheetLbs).not.toBeNull();
    }
  });
});

describe('options a caller can override', () => {
  it('takes a shop id, name, parity and module list', () => {
    const config = shopConfigFromSeed(seedBundle(), {
      shopId: 'shop-two',
      shopName: 'Second Shop',
      parity: { machineTimeFactor: 1, legacyCoatingModel: false },
      enabledModules: ['sheetMetal.nesting'],
    });
    expect(config.shopId).toBe('shop-two');
    expect(config.defaults.shopName).toBe('Second Shop');
    expect(config.parity.machineTimeFactor).toBe(1);
    expect(config.parity.legacyCoatingModel).toBe(false);
    // Untouched flags keep the workbook's behaviour.
    expect(config.parity.markupInsideMinChargeMax).toBe(true);
    expect(config.enabledModules).toEqual(['sheetMetal.nesting']);
  });
});

describe('a sparse bundle, as a shop with no workbook would supply (§12 rule 3)', () => {
  const config = shopConfigFromSeed(sparseBundle());

  it('loads without throwing', () => {
    expect(config.schemaVersion).toBe(1);
    expect(config.shopId).toBe('shop-seed');
    expect(config.defaults.shopName).toBe('Seed Shop');
  });

  it('turns missing machine numbers into neutral values, not invented ones', () => {
    const machine = config.machines[0];
    expect(machine?.ratePerHrUsd).toBe(0);
    expect(machine?.clampStripIn).toBe(0);
    expect(machine?.kerfIn).toBe(0);
    expect(machine?.palletChangeSec).toBe(0);
    expect(machine?.intersectionSec).toBe(0);
    expect(machine?.rapidSecPerPierce).toBe(0);
    // A loss factor of 1 is the only safe default: it changes nothing.
    expect(machine?.lossFactor).toBe(1);
    expect(machine?.palletBatchParts).toBe(100);
    expect(machine?.loadUnloadSecPerBlank).toBe(0);
  });

  it('files an unrecognised machine kind as other rather than guessing', () => {
    expect(config.machines[0]?.kind).toBe('other');
    expect(config.machines[0]?.timeModel).toBe('none');
  });

  it('gives a non-punch machine no tool table', () => {
    expect(config.machines[0]?.hitRates).toEqual([]);
  });

  it('gives a punch machine the tools, defaulting a missing rate to zero', () => {
    const withPunch = shopConfigFromSeed({
      ...sparseBundle(),
      machines: [{ ...sparseBundle().machines[0]!, time_model: 'hitBased' }],
    });
    const tools = withPunch.machines[0]?.hitRates;
    expect(tools).toHaveLength(1);
    expect(tools?.[0]?.hitsPerHr).toBe(0);
    expect(tools?.[0]?.multiplier).toBe(1);
  });

  it('skips stock sizes for a material with no standard length', () => {
    expect(config.stockSizes).toEqual([]);
  });

  it('zeroes a rate rather than dropping the pairing', () => {
    const rate = config.machineMaterialRates[0];
    expect(rate?.cutSpeedInPerMin).toBe(0);
    expect(rate?.pierceSeconds).toBe(0);
    expect(rate?.punchRateFactor).toBe(0);
  });

  it('keeps an operation with no setup, standard or rate, and marks it so', () => {
    const op = config.operations[0];
    expect(op?.setupHrs).toBe(0);
    expect(op?.standardPerHr).toBeNull();
    expect(op?.standardUnit).toBeNull();
    expect(op?.ratePerHrUsd).toBeNull();
  });

  it('zeroes plating numbers rather than inventing a rate', () => {
    const spec = config.platingSpecs[0];
    expect(spec?.lotMinimumUsd).toBe(0);
    expect(spec?.pricePerSqInUsd).toBe(0);
    expect(spec?.partMinimumUsd).toBe(0);
    expect(spec?.rohsCompliant).toBeNull();
  });

  it('leaves a coating model without an S constant unparameterised', () => {
    // finish.ts turns this into a visible warning rather than a price of zero.
    expect(config.coatingModels[0]?.legacy).toBeNull();
    expect(config.coatingModels[1]?.legacy).toBeNull();
    expect(config.coatingModels[0]?.modern).toBeNull();
    expect(config.coatingModels[0]?.minimumChargeUsd).toBe(0);
  });

  it('keeps a null screen charge, which means the customer supplies it', () => {
    expect(config.silkscreenTiers[0]?.screenCostUsd).toBeNull();
    expect(config.silkscreenTiers[0]?.printCostUsd).toBe(0);
    expect(config.silkscreenTiers[0]?.active).toBe(false);
  });

  it('keeps an assembly standard with no section', () => {
    expect(config.assemblyStandards[0]?.section).toBeNull();
    expect(config.assemblyStandards[0]?.standardSeconds).toBe(5);
  });
});
