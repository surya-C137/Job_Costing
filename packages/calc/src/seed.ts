/**
 * Seed JSON → `ShopConfig`.
 *
 * `scripts/extract-workbook.py` writes `packages/db/seed/*.json` in the
 * workbook's own shape. REQUIREMENTS §3 puts the app's data somewhere else —
 * machines are work centres with their own timing constants, and speeds and
 * pierce times belong to a machine/material *pairing* rather than to the
 * material row. This is where one becomes the other.
 *
 * It lives in calc, not in `@shopquote/db`, because two callers need the same
 * mapping and neither should own it alone: Task 1.4's golden test runs with no
 * database at all, and Task 2.1's `seed.ts` loads the same files into SQLite.
 * Writing it twice would let them drift, and the golden test would stop proving
 * anything about what the database holds.
 *
 * Pure, like everything else here: the caller reads the files, this takes the
 * parsed objects. That is the same split `intake/` uses — parsers outside,
 * resolution inside — and it is what keeps calc's dependency count at zero.
 */

import type {
  AssemblyStandard,
  CoatingModel,
  GaugeEntry,
  Machine,
  MachineMaterialRate,
  MaterialFamily,
  MaterialRow,
  ModuleId,
  Operation,
  ParityFlags,
  PlatingSpec,
  ShopConfig,
  ShopDefaults,
  SilkscreenTier,
  StockSize,
} from './types/config.js';

/* -------------------------------------------------------------------------
   The seed files' own shapes. Snake_case because that is what the extractor
   emits; the rename to camelCase is this module's job.
   ------------------------------------------------------------------------- */

export interface SeedMaterial {
  key: string;
  name: string;
  family: string;
  thickness_in: number | null;
  lb_per_sq_ft: number;
  /** Null where the workbook priced the row by asking the supplier. */
  price_per_lb: number | null;
  std_length_in: number | null;
  speed_in_min: number | null;
  pierce_s: number | null;
  punch_rate_factor: number | null;
  sheet_cost: number | null;
  sheet_lbs: number | null;
  active: boolean;
}

export interface SeedOperation {
  key: string;
  name: string;
  kind: 'machine' | 'manual';
  machine_key: string | null;
  setup_hrs: number | null;
  standard_per_hr: number | null;
  standard_unit: 'pieces' | 'inches' | 'sqIn' | null;
  rate_per_hr: number | null;
  active: boolean;
}

export interface SeedMachine {
  key: string;
  name: string;
  kind: string;
  time_model: 'featureBased' | 'hitBased' | 'none';
  rate_per_hr: number | null;
  clamp_in: number | null;
  kerf_in: number | null;
  load_unload_s_per_blank: number | null;
  pallet_change_s: number | null;
  pallet_batch_parts: number | null;
  intersection_s: number | null;
  rapid_s_per_pierce: number | null;
  loss_factor: number | null;
}

export interface SeedPunchTool {
  key: string;
  name: string;
  multiplier: number | null;
  hit_rate_per_hr: number | null;
}

export interface SeedPlating {
  key: string;
  spec: string;
  lot_min_charge: number | null;
  price_per_sq_in: number | null;
  part_min: number | null;
  active: boolean;
}

export interface SeedCoating {
  models: {
    key: string;
    name: string;
    legacy: { s_constant: number | null; coverage: number | null; rate: number | null } | null;
    modern: null;
  }[];
  adders: Record<string, { label: string; rate: number | null }>;
  liquid_texture_adder_pct: number;
}

export interface SeedSilkscreen {
  key: string;
  spec: string;
  screen_cost: number | null;
  print_cost: number | null;
  active: boolean;
}

export interface SeedAssembly {
  key: string;
  section: string | null;
  action: string;
  std_seconds: number;
}

export interface SeedDefaults {
  shop_fixed_cost_per_job: number;
  labor_markup: number;
  material_markup: number;
  nre_rate_per_hr: number;
  nre_markup: number;
  min_charge_strip_in: number;
  default_qty_breaks: number[];
  sheet_widths_in: number[];
}

export interface SeedBlanks {
  standard_blank_lengths_in: number[];
  sheet_widths_in: number[];
}

/** Everything `shopConfigFromSeed()` reads. One property per seed file. */
export interface SeedBundle {
  materials: SeedMaterial[];
  operations: SeedOperation[];
  machines: SeedMachine[];
  punchTools: { tools: SeedPunchTool[]; load_unload_s_per_blank: number };
  plating: SeedPlating[];
  coating: SeedCoating;
  silkscreen: SeedSilkscreen[];
  assemblyStandards: SeedAssembly[];
  blanks: SeedBlanks;
  defaults: SeedDefaults;
}

/** Overrides for values the workbook has no source for. */
export interface SeedOptions {
  /** Defaults to `shop-seed`. */
  shopId?: string;
  /** Defaults to the workbook's behaviour on every flag (§5.7). */
  parity?: Partial<ParityFlags>;
  /** Defaults to every sheet-metal module. */
  enabledModules?: ModuleId[];
  /** Shop name for the quote header. */
  shopName?: string;
}

/** Ids are the seed's own slugs, namespaced so a `materialId` can never
 *  accidentally match a `machineId`. The DB swaps these for ULIDs (§7). */
const id = (kind: string, key: string): string => `${kind}:${key}`;

export const materialId = (key: string): string => id('material', key);
export const machineId = (key: string): string => id('machine', key);
export const operationId = (key: string): string => id('operation', key);
export const familyId = (key: string): string => id('family', key);

/** The workbook's family strings, as `MaterialFamily` rows. Densities are left
 *  null: the workbook carries lb/ft² directly and never needs to derive it. */
function familiesFrom(materials: SeedMaterial[]): MaterialFamily[] {
  const names = [...new Set(materials.map((m) => m.family))].sort();
  return names.map((name) => ({
    id: familyId(name),
    name,
    densityLbPerCuIn: null,
    defaultScrapPricePerLbUsd: 0,
    aliases: [],
  }));
}

/**
 * Machines, from the workbook's clamp/kerf pairs plus the timing constants
 * recovered from the LASER WORKSHEET. The punch machine takes the hit-rate
 * table (§5.3); the laser has none.
 */
function machinesFrom(seed: SeedBundle): Machine[] {
  return seed.machines.map((m) => ({
    id: machineId(m.key),
    name: m.name,
    kind: (m.kind === 'laser' || m.kind === 'punch' ? m.kind : 'other') as Machine['kind'],
    timeModel: m.time_model,
    ratePerHrUsd: m.rate_per_hr ?? 0,
    setupHrsDefault: 0,
    consumablesPerHrUsd: 0,
    maxSheetLengthIn: null,
    maxSheetWidthIn: null,
    clampStripIn: m.clamp_in ?? 0,
    kerfIn: m.kerf_in ?? 0,
    palletChangeSec: m.pallet_change_s ?? 0,
    palletBatchParts: m.pallet_batch_parts ?? 100,
    intersectionSec: m.intersection_s ?? 0,
    rapidSecPerPierce: m.rapid_s_per_pierce ?? 0,
    lossFactor: m.loss_factor ?? 1,
    loadUnloadSecPerBlank: m.load_unload_s_per_blank ?? 0,
    hitRates:
      m.time_model === 'hitBased'
        ? seed.punchTools.tools.map((t) => ({
            id: id('tool', t.key),
            name: t.name,
            hitsPerHr: t.hit_rate_per_hr ?? 0,
            multiplier: t.multiplier ?? 1,
          }))
        : [],
    active: true,
  }));
}

/**
 * The machine × material grid, from the workbook's speed, pierce and
 * punch-factor columns.
 *
 * This is the move §3 asks for: those three are properties of a *pairing*, not
 * of a material — a fibre laser and a CO₂ laser cut the same stock at
 * different speeds. The workbook could not express that because it had one
 * machine of each kind, so its material row is denormalised. Every
 * feature-based machine gets the speed/pierce columns and every hit-based one
 * the punch factor; the owner then corrects whichever rows are wrong, and a
 * pairing that is genuinely missing warns instead of defaulting (§12 rule 3).
 */
function ratesFrom(seed: SeedBundle): MachineMaterialRate[] {
  const rates: MachineMaterialRate[] = [];
  for (const machine of seed.machines) {
    for (const material of seed.materials) {
      rates.push({
        machineId: machineId(machine.key),
        materialId: materialId(material.key),
        cutSpeedInPerMin: material.speed_in_min ?? 0,
        pierceSeconds: material.pierce_s ?? 0,
        punchRateFactor: material.punch_rate_factor ?? 0,
      });
    }
  }
  return rates;
}

function materialsFrom(seed: SeedBundle): MaterialRow[] {
  return seed.materials.map((m) => ({
    id: materialId(m.key),
    name: m.name,
    familyId: familyId(m.family),
    form: 'sheet' as const,
    thicknessIn: m.thickness_in,
    lbPerSqFt: m.lb_per_sq_ft,
    pricePerLbUsd: m.price_per_lb,
    surchargePct: 0,
    scrapPricePerLbUsd: 0,
    standardLengthIn: m.std_length_in,
    aliases: [],
    sheetCostUsd: m.sheet_cost,
    sheetLbs: m.sheet_lbs,
    active: m.active,
  }));
}

function operationsFrom(seed: SeedBundle): Operation[] {
  return seed.operations.map((o) => ({
    id: operationId(o.key),
    name: o.name,
    machineId: o.machine_key === null ? null : machineId(o.machine_key),
    kind: o.kind,
    setupHrs: o.setup_hrs ?? 0,
    standardPerHr: o.standard_per_hr,
    standardUnit: o.standard_unit,
    ratePerHrUsd: o.rate_per_hr,
    active: o.active,
  }));
}

/** Stock sizes, from the widths the shop buys crossed with each material's own
 *  standard length (§3 — this replaces any hardcoded sheet list). */
function stockSizesFrom(seed: SeedBundle): StockSize[] {
  const sizes: StockSize[] = [];
  for (const material of seed.materials) {
    if (material.std_length_in === null) continue;
    for (const widthIn of seed.blanks.sheet_widths_in) {
      sizes.push({
        id: id('stock', `${material.key}-${widthIn}`),
        materialId: materialId(material.key),
        familyId: null,
        lengthIn: material.std_length_in,
        widthIn,
        preferred: widthIn === 48,
      });
    }
  }
  return sizes;
}

function platingFrom(seed: SeedBundle): PlatingSpec[] {
  return seed.plating.map((p) => ({
    id: id('plating', p.key),
    name: p.spec,
    aliases: [],
    lotMinimumUsd: p.lot_min_charge ?? 0,
    pricePerSqInUsd: p.price_per_sq_in ?? 0,
    partMinimumUsd: p.part_min ?? 0,
    rohsCompliant: null,
    active: p.active,
  }));
}

function coatingFrom(seed: SeedBundle): CoatingModel[] {
  return seed.coating.models.map((c) => ({
    id: id('coating', c.key),
    name: c.name,
    // W67 held the loaded quote's own cost, not a floor, so there is no
    // seeded minimum (see docs/discovery.md).
    minimumChargeUsd: 0,
    legacy:
      c.legacy === null || c.legacy.s_constant === null
        ? null
        : {
            rateUsd: c.legacy.rate ?? 0,
            coverage: c.legacy.coverage ?? 0,
            sConstant: c.legacy.s_constant,
          },
    // §11.3's model has no source in a 1998 workbook; the owner fills it in.
    modern: null,
  }));
}

function silkscreenFrom(seed: SeedBundle): SilkscreenTier[] {
  return seed.silkscreen.map((t) => ({
    id: id('silkscreen', t.key),
    name: t.spec,
    screenCostUsd: t.screen_cost,
    printCostUsd: t.print_cost ?? 0,
    active: t.active,
  }));
}

function assemblyFrom(seed: SeedBundle): AssemblyStandard[] {
  return seed.assemblyStandards.map((a) => ({
    id: id('assembly', a.key),
    section: a.section,
    action: a.action,
    standardSeconds: a.std_seconds,
  }));
}

function defaultsFrom(seed: SeedBundle, options: SeedOptions): ShopDefaults {
  return {
    shopName: options.shopName ?? 'Seed Shop',
    unitSystem: 'imperial',
    currency: 'USD',
    validityDays: 30,
    quoteTerms: '',
    defaultQuantityBreaks: [...seed.defaults.default_qty_breaks],
    shopFixedCostPerJobUsd: seed.defaults.shop_fixed_cost_per_job,
    laborMarkup: seed.defaults.labor_markup,
    materialMarkup: seed.defaults.material_markup,
    nreRatePerHrUsd: seed.defaults.nre_rate_per_hr,
    nreMarkup: seed.defaults.nre_markup,
    minChargeStripIn: seed.defaults.min_charge_strip_in,
  };
}

/** Every module this build ships, which is what the seeded shop runs. */
export const ALL_SHEET_METAL_MODULES: ModuleId[] = [
  'sheetMetal.nesting',
  'sheetMetal.materialExtras',
  'sheetMetal.hardware',
  'sheetMetal.plating',
  'sheetMetal.setup',
  'sheetMetal.nre',
  'sheetMetal.directLabor',
  'sheetMetal.coating',
  'sheetMetal.silkscreen',
];

/**
 * Assemble a `ShopConfig` from the parsed seed files.
 *
 * Gauge tables come out empty: the workbook carries lb/ft² on every material
 * row and never looks a gauge up, so there is nothing to seed. Task 2.1's
 * `seed-blank.ts` is where a shop with no workbook gets real gauge tables.
 */
export function shopConfigFromSeed(seed: SeedBundle, options: SeedOptions = {}): ShopConfig {
  const gauges: GaugeEntry[] = [];
  return {
    schemaVersion: 1,
    shopId: options.shopId ?? 'shop-seed',
    defaults: defaultsFrom(seed, options),
    families: familiesFrom(seed.materials),
    gauges,
    materials: materialsFrom(seed),
    stockSizes: stockSizesFrom(seed),
    machines: machinesFrom(seed),
    machineMaterialRates: ratesFrom(seed),
    operations: operationsFrom(seed),
    platingSpecs: platingFrom(seed),
    coatingModels: coatingFrom(seed),
    silkscreenTiers: silkscreenFrom(seed),
    assemblyStandards: assemblyFrom(seed),
    parity: {
      markupInsideMinChargeMax: true,
      machineTimeFactor: 0.6,
      legacyCoatingModel: true,
      finishesUnmarked: true,
      ...options.parity,
    },
    enabledModules: options.enabledModules ?? [...ALL_SHEET_METAL_MODULES],
  };
}
