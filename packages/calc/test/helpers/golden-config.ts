/**
 * A `ShopConfig` and `PartInput` for the REQUIREMENTS §9 golden case, built
 * from `fixtures/golden-workbook.json`.
 *
 * Every workbook-derived number comes out of the fixture. The few that are not
 * in it are marked below: they are §5.2 timing constants that the material
 * module never touches, and Task 1.3 will pin them against the laser oracle.
 *
 * Each call returns a fresh object graph, so a test that switches a material
 * off cannot leak into the next one.
 */

import type {
  Machine,
  MaterialRow,
  ShopConfig,
} from '../../src/types/config.js';
import type { PartInput, QuoteInput } from '../../src/types/part.js';
import golden from '../fixtures/golden-workbook.json' with { type: 'json' };

export const GOLDEN_MATERIAL_ID = 'material-g30-16ga';
export const GOLDEN_MACHINE_ID = 'machine-laser-1';
export const GOLDEN_FAMILY_ID = 'family-galv';

/** The §9 material, as a catalog row. */
function material(): MaterialRow {
  return {
    id: GOLDEN_MATERIAL_ID,
    name: golden.material.name,
    familyId: GOLDEN_FAMILY_ID,
    form: 'sheet',
    thicknessIn: 0.0598,
    lbPerSqFt: golden.material.lb_per_sq_ft,
    pricePerLbUsd: golden.material.price_per_lb,
    surchargePct: 0,
    scrapPricePerLbUsd: 0,
    standardLengthIn: golden.material.std_length_in,
    aliases: [],
    sheetCostUsd: null,
    sheetLbs: null,
    active: true,
  };
}

/** The work centre the §9 part is cut on. */
function machine(): Machine {
  return {
    id: GOLDEN_MACHINE_ID,
    name: 'Laser 1',
    kind: 'laser',
    timeModel: 'featureBased',
    ratePerHrUsd: golden.laser_op.rate_per_hr,
    setupHrsDefault: golden.laser_op.setup_hrs,
    consumablesPerHrUsd: 0,
    maxSheetLengthIn: null,
    maxSheetWidthIn: null,
    clampStripIn: golden.nesting.clamp_in,
    kerfIn: golden.nesting.kerf_in,
    palletChangeSec: golden.laser.pallet_change_s,
    // Not in the fixture: §5.2's stated constants. Task 1.3 pins them against
    // the laser oracle (0.0052255 h/part), which is what actually proves them.
    palletBatchParts: 100,
    intersectionSec: 0.3,
    rapidSecPerPierce: 0.6,
    lossFactor: 1.08,
    loadUnloadSecPerBlank: 40,
    hitRates: [],
    active: true,
  };
}

/** A `ShopConfig` holding just enough to price the §9 part. */
export function goldenConfig(): ShopConfig {
  return {
    schemaVersion: 1,
    shopId: 'shop-golden',
    defaults: {
      shopName: 'Golden Test Shop',
      unitSystem: 'imperial',
      currency: 'USD',
      validityDays: 30,
      quoteTerms: '',
      defaultQuantityBreaks: [...golden.quantity_breaks],
      shopFixedCostPerJobUsd: golden.config.shop_fixed_cost_per_job,
      laborMarkup: golden.config.labor_markup,
      materialMarkup: golden.config.material_markup,
      nreRatePerHrUsd: 100,
      nreMarkup: 1.3,
      minChargeStripIn: golden.config.min_charge_strip_in,
    },
    families: [
      {
        id: GOLDEN_FAMILY_ID,
        name: 'galvanized',
        densityLbPerCuIn: 0.2836,
        defaultScrapPricePerLbUsd: 0,
        aliases: ['G30', 'galv'],
      },
    ],
    gauges: [],
    materials: [material()],
    stockSizes: [
      {
        id: 'stock-48x120',
        materialId: GOLDEN_MATERIAL_ID,
        familyId: null,
        lengthIn: golden.material.std_length_in,
        widthIn: golden.nesting.stock_width_in,
        preferred: true,
      },
    ],
    machines: [machine()],
    machineMaterialRates: [
      {
        machineId: GOLDEN_MACHINE_ID,
        materialId: GOLDEN_MATERIAL_ID,
        cutSpeedInPerMin: golden.material.speed_in_min,
        pierceSeconds: golden.material.pierce_s,
        punchRateFactor: 1,
      },
    ],
    operations: [
      {
        id: 'operation-laser',
        name: 'LASER',
        machineId: GOLDEN_MACHINE_ID,
        kind: 'machine',
        setupHrs: golden.laser_op.setup_hrs,
        standardPerHr: null,
        standardUnit: null,
        ratePerHrUsd: golden.laser_op.rate_per_hr,
        active: true,
      },
    ],
    platingSpecs: [],
    coatingModels: [],
    silkscreenTiers: [],
    assemblyStandards: [],
    parity: {
      markupInsideMinChargeMax: true,
      machineTimeFactor: 0.6,
      legacyCoatingModel: true,
      finishesUnmarked: true,
    },
    enabledModules: ['sheetMetal.nesting'],
  };
}

/** The §9 part, as the estimator would have entered it. */
export function goldenPart(): PartInput {
  return {
    id: 'part-golden',
    partNumber: 'G30-GOLDEN',
    materialId: GOLDEN_MATERIAL_ID,
    flatLengthIn: golden.part.flat_length_in,
    flatWidthIn: golden.part.flat_width_in,
    nesting: {
      machineId: GOLDEN_MACHINE_ID,
      stockWidthIn: golden.nesting.stock_width_in,
      blankLengthIn: golden.nesting.blank_length_in,
    },
    cutting: {
      model: 'featureBased',
      features: [],
      perimeterCutIn: golden.laser.perimeter_cut_in,
      intersections: golden.laser.intersections,
    },
    operations: [{ operationId: 'operation-laser', countPerPart: 1 }],
    finish: {},
    hardware: [],
    nre: [],
  };
}

/** Wraps a part in a quote priced at the §9 breaks. */
export function quoteFor(part: PartInput): QuoteInput {
  return {
    parts: [part],
    quantityBreaks: [...golden.quantity_breaks],
  };
}
