/**
 * `ShopConfig` — everything about a shop that can differ, as data.
 *
 * REQUIREMENTS §3 (domain model) and §12 (what is data vs. what is code).
 * The rule §12 states and this file obeys: **code knows shapes, never
 * instances.** There is a `Machine` type; there is no `Laser`. There is a
 * `MaterialRow`; there is no `CRS16GA`. Every name, rate, speed and standard
 * in a running system came out of Settings, and a second shop is a different
 * `ShopConfig` rather than a different build.
 *
 * Money fields end in `Usd` and are dollars (CLAUDE.md: dollars, not cents,
 * 4-decimal internal precision). Lengths end in `In`, weights in `Lb`, times
 * in `Hrs` or `Sec`. Engine units are always inches/pounds/dollars/hours —
 * `unitSystem` below is a display and entry preference only.
 */

/** Which cost modules a shop has switched on (§12). Module ids are strings so
 *  a new trade's modules need no change here — see `registry.ts`. */
export type ModuleId = string;

/**
 * How a work centre's time is computed. This — not the machine's label — is
 * what selects a cost contributor, which is why adding a waterjet is a
 * Settings row rather than a code change (§12 rule 2).
 *
 * - `featureBased` — a path cut at a speed: laser, waterjet, plasma.
 * - `hitBased`     — a tool struck a number of times: turret punch.
 * - `none`         — no per-feature time: shear, brake, manual benches.
 */
export type MachineTimeModel = 'featureBased' | 'hitBased' | 'none';

/**
 * A machine's label, for grouping and for the Settings UI. Purely descriptive:
 * no formula branches on it (§3). `other` keeps the list open without a
 * migration; behaviour comes from `timeModel`.
 */
export type MachineKind =
  | 'laser'
  | 'punch'
  | 'waterjet'
  | 'plasma'
  | 'shear'
  | 'brake'
  | 'weld'
  | 'deburr'
  | 'other';

/** Stock form. `sheet` is the only one v1 prices; the rest are reserved so the
 *  schema does not have to change when bar or tube arrives (§3). */
export type MaterialForm = 'sheet' | 'plate' | 'bar' | 'tube' | 'purchased';

/** What an operation's `standardPerHr` counts, so the UI can label the input
 *  ("bends" vs "inches of weld") and calc can validate it (§3). */
export type StandardUnit = 'pieces' | 'inches' | 'sqIn';

/** Machine ops take their hours from a cutting model (§5.2/§5.3); manual ops
 *  divide a count by a standard (§5.4). Selects quirk Q2's factor. */
export type OperationKind = 'machine' | 'manual';

/** Display and data-entry preference only. The engine is always in/lb (§3). */
export type UnitSystem = 'imperial' | 'metric';

/** A material family — steel, aluminium, acrylic, plywood. Editable: a shop
 *  that cuts something this one has never seen adds a row (§3). */
export interface MaterialFamily {
  /** Stable id. ULID at runtime; the seed's slug before that. */
  id: string;
  /** Display name, e.g. "stainless". */
  name: string;
  /** Density, lb/in³. Used to derive lb/ft² from a gauge when no override. */
  densityLbPerCuIn: number | null;
  /** Default scrap credit, $/lb, for materials in this family. */
  defaultScrapPricePerLbUsd: number;
  /** Intake matching: "CRS", "A36", "HRPO" all resolve to steel (§3, §8). */
  aliases: string[];
}

/** One row of a gauge table: family + label → decimal thickness (§3). */
export interface GaugeEntry {
  id: string;
  /** `MaterialFamily.id` this gauge table belongs to. */
  familyId: string;
  /** What the drawing says, e.g. "16 ga". */
  label: string;
  /** Decimal thickness, inches. */
  thicknessIn: number;
  /** Coated stock weighs more than thickness × density implies; when set this
   *  wins over the derived value. lb/ft². */
  lbPerSqFtOverride: number | null;
}

/** A stock item the shop buys. Carries no machine-specific numbers — speeds
 *  and pierce times live in `MachineMaterialRate` (§3). */
export interface MaterialRow {
  id: string;
  /** Catalog name as the estimator reads it, e.g. "G30 16 GA (.0598)". */
  name: string;
  /** `MaterialFamily.id`. */
  familyId: string;
  /** Stock form. v1 prices `sheet`. */
  form: MaterialForm;
  /** Decimal thickness, inches. Null when the name carries no gauge. */
  thicknessIn: number | null;
  /** Areal weight, lb/ft². Coated steels carry their coated weight (§5.1). */
  lbPerSqFt: number;
  /**
   * Purchase price, $/lb. Versioned in the DB; a `ShopConfig` holds the one
   * effective at its `asOf` (§7).
   *
   * **Null when the shop stocks it but has not priced it.** The workbook has
   * fourteen such rows — the brushed stainless #4B range, quoted by asking the
   * supplier — and a shop mid-way through entering its catalog will have more.
   * The material module refuses to price a part on unpriced stock and says so
   * (§12 rule 3: missing data warns visibly, it never silently defaults). It
   * is emphatically not zero: free steel would quietly under-quote a job.
   */
  pricePerLbUsd: number | null;
  /** Tariff/alloy surcharge, as a fraction of `pricePerLbUsd` (§11.2). 0 = none. */
  surchargePct: number;
  /** Scrap credit, $/lb. Supported, off by default (§11.4 item 4). */
  scrapPricePerLbUsd: number;
  /** Default cut length when the estimator does not choose one, inches (§5.1). */
  standardLengthIn: number | null;
  /** Alternative names an intake file or drawing might use (§8). */
  aliases: string[];
  /** Provenance for `pricePerLbUsd`: what a sheet cost and what it weighed.
   *  The owner's own mental model when repricing (§11.2 $/cwt). Null when the
   *  workbook's columns held something else. */
  sheetCostUsd: number | null;
  /** Companion to `sheetCostUsd`, pounds. */
  sheetLbs: number | null;
  active: boolean;
}

/** A stock size the shop can buy a material in. Replaces any hardcoded sheet
 *  list (§3). */
export interface StockSize {
  id: string;
  /** Applies to one material; null means it applies to the whole family. */
  materialId: string | null;
  /** `MaterialFamily.id` when `materialId` is null. */
  familyId: string | null;
  /** Sheet length, inches. */
  lengthIn: number;
  /** Sheet width, inches. */
  widthIn: number;
  /** Offered first in the picker. */
  preferred: boolean;
}

/** A punch tool's hit rate. Stored per punch machine (§5.3) — ten tools in the
 *  workbook's seed, the "TOTAL HIT COUNT" row being a subtotal, not a tool. */
export interface PunchHitRate {
  id: string;
  /** Tool name, e.g. "Emboss". */
  name: string;
  /** Hits per hour this tool sustains. */
  hitsPerHr: number;
  /** Some tools cost more than one hit per feature (countersink 3, extrusion 2). */
  multiplier: number;
}

/**
 * A work centre. A shop with two lasers has two rows, each with its own kerf,
 * rate and speeds (§3).
 *
 * Every timing constant the workbook buried in a formula is a field here —
 * `intersectionSec`, `rapidSecPerPierce`, `palletChangeSec`,
 * `palletBatchParts`, `lossFactor`. A shuttle-table fibre laser has a
 * different pallet time; a shop with better nesting software has a different
 * loss factor. None of them may be a literal in calc (§5.2, §12 rule 1).
 */
export interface Machine {
  id: string;
  /** What the shop calls it: "Laser 1", "Pega 357". */
  name: string;
  /** Descriptive label; nothing branches on it (§3). */
  kind: MachineKind;
  /** Selects the cost contributor that prices this machine's time (§12). */
  timeModel: MachineTimeModel;
  /** Shop rate for time on this machine, $/hr. */
  ratePerHrUsd: number;
  /** Default setup per job, hours. An operation may override it. */
  setupHrsDefault: number;
  /** Assist gas and other consumables, $/hr, added to the rate (§11.2). */
  consumablesPerHrUsd: number;
  /** Largest sheet it takes, inches. Null = unconstrained. */
  maxSheetLengthIn: number | null;
  /** Companion to `maxSheetLengthIn`, inches. */
  maxSheetWidthIn: number | null;
  /** Clamp strip lost off one width edge, inches (§5.1). */
  clampStripIn: number;
  /** Kerf / part spacing added to each part dimension, inches (§5.1).
   *  This is where the workbook's 0.5 lives — it is Settings data, not a
   *  parity flag; §5.7 Q5 was withdrawn for that reason. */
  kerfIn: number;
  /** Pallet or table change, seconds, amortised over the parts on a sheet. */
  palletChangeSec: number;
  /**
   * The batch a pallet change is spread over, in parts, and the sheet yield
   * above which no change is needed inside that batch (§5.2). One number
   * doing both jobs because the workbook uses one number for both: it charges
   * `palletChangeSec ÷ 100` per part while a sheet yields fewer than 100.
   */
  palletBatchParts: number;
  /** Seconds lost per cut-path intersection (§5.2). */
  intersectionSec: number;
  /** Rapid traverse, seconds per pierce (§5.2). */
  rapidSecPerPierce: number;
  /** Multiplier on computed cut time for real-world losses, e.g. 1.08 (§5.2). */
  lossFactor: number;
  /** Load and unload, seconds per blank (§5.3). */
  loadUnloadSecPerBlank: number;
  /** Tool hit rates. Meaningful when `timeModel` is `hitBased`. */
  hitRates: PunchHitRate[];
  active: boolean;
}

/**
 * What one machine achieves in one material. This is where the workbook's
 * speed, pierce and punch-factor columns go — they are properties of a pairing,
 * not of a material (§3). A missing pair warns the estimator; it never
 * silently defaults (§12 rule 3).
 */
export interface MachineMaterialRate {
  /** `Machine.id`. */
  machineId: string;
  /** `MaterialRow.id`. */
  materialId: string;
  /** Cutting speed, inches per minute. */
  cutSpeedInPerMin: number;
  /** Time to pierce, seconds. */
  pierceSeconds: number;
  /** Multiplier on punch hit rates for this material's hardness. */
  punchRateFactor: number;
}

/** A catalog operation: setup + standard + rate (§5.4). */
export interface Operation {
  id: string;
  /** e.g. "BRAKE, BEND". */
  name: string;
  /** Work centre it runs on. When set, `ratePerHrUsd` may be inherited. */
  machineId: string | null;
  /** Machine ops take hours from a cutting model; manual ops from a standard. */
  kind: OperationKind;
  /** Setup per job, hours. Rolls into fixed cost (§5.6). */
  setupHrs: number;
  /** Units per hour. Null for machine ops, whose hours come from §5.2/§5.3. */
  standardPerHr: number | null;
  /** What `standardPerHr` counts. Null for machine ops. */
  standardUnit: StandardUnit | null;
  /** $/hr. Null means inherit from `machineId`. */
  ratePerHrUsd: number | null;
  active: boolean;
}

/** Outside plating or conversion coating (§5.5). */
export interface PlatingSpec {
  id: string;
  /** Spec as the drawing calls it, e.g. "ANODIZE, CHROMIC MIL-8625 TYPE I". */
  name: string;
  /** Superseded names that still appear on old drawings (§11.2). */
  aliases: string[];
  /** Minimum charge for the whole lot, $. */
  lotMinimumUsd: number;
  /** Price per square inch of finished area, $. */
  pricePerSqInUsd: number;
  /** Minimum charge per part, $. */
  partMinimumUsd: number;
  /** Null when unknown. False triggers a warning for a RoHS customer (§11.2). */
  rohsCompliant: boolean | null;
  active: boolean;
}

/** Powder or liquid coating. Carries both models so parity flag Q3 has a real
 *  alternative rather than a hole (§11.3). */
export interface CoatingModel {
  id: string;
  name: string;
  /** Floor charge per part, $. Zero when the shop has not set one. */
  minimumChargeUsd: number;
  /**
   * The workbook's model, reproduced under quirk Q3:
   * `cost = rateUsd × (perimeterIn ÷ coverage × sConstant)`. The three
   * constants are unexplained — §10 question 2 — which is why they sit under a
   * key that says "legacy" rather than posing as physics.
   */
  legacy: {
    rateUsd: number;
    coverage: number;
    sConstant: number;
  } | null;
  /**
   * The defensible model (§11.3), built on the powder industry's own coverage
   * formula rather than an opaque constant:
   *
   * ```
   * coverage ft²/lb = 192.3 ÷ specificGravity ÷ filmThicknessMils × transferEfficiency
   * cost = coatedArea ft² ÷ coverage × powderPricePerLbUsd + rack + masking
   * ```
   *
   * 192.3 ft² is what one pound of a specific-gravity-1.0 powder covers at
   * 1 mil with perfect transfer; the three inputs are the ones an owner
   * actually knows — the powder's data sheet gives specific gravity, the spec
   * gives film build, and the booth gives transfer efficiency (50–80% typical
   * on a first pass, higher with reclaim).
   *
   * Used when `parity.legacyCoatingModel` is off. Null until the owner fills
   * it in; the workbook has no source for any of it.
   */
  modern: {
    /** Specific gravity of the powder, from its data sheet. Typically 1.2–1.8. */
    specificGravity: number;
    /** Target film build, mils. Typically 2–3 for a functional finish. */
    filmThicknessMils: number;
    /** Fraction of sprayed powder that lands on the part, 0–1. */
    transferEfficiency: number;
    /** Powder price, $/lb. */
    powderPricePerLbUsd: number;
    /** Hanging and racking labour, $ per part. */
    rackLaborUsdPerPart: number;
    /** Masking labour and materials, $ per masked feature. */
    maskingUsdPerFeature: number;
  } | null;
}

/** One tier of the silkscreen price list (§5.5). */
export interface SilkscreenTier {
  id: string;
  name: string;
  /** One-time screen charge, $, amortised over the quantity. Null = customer
   *  supplies the screen. */
  screenCostUsd: number | null;
  /** Print cost per part, $. */
  printCostUsd: number;
  active: boolean;
}

/** Seconds for one assembly action (§3). */
export interface AssemblyStandard {
  id: string;
  /** Grouping from the workbook's sheet, e.g. "HARDWARE / TIEWRAPS". */
  section: string | null;
  /** e.g. "INSTALL NUT IN PLACE & TIGHTEN". */
  action: string;
  /** Standard time, seconds. */
  standardSeconds: number;
}

/**
 * Parity flags (§5.7). Four, not five: kerf became a `Machine` field, because
 * a value that differs between two shops in the same trade is Settings data
 * rather than a flag (§12 rule 1).
 *
 * Each defaults to the workbook and every one has a real alternative path —
 * §11.3 forbids `else → 0`.
 */
export interface ParityFlags {
  /** Q1 — material markup applied inside the minimum-charge MAX (§5.1). */
  markupInsideMinChargeMax: boolean;
  /**
   * Q2 — machine time is billed at this multiple. A number, not a boolean:
   * 0.6 reproduces the workbook's ×60 against manual ops' ×100, 1.0 bills
   * machine time as machine time, and an owner can dial anything between.
   */
  machineTimeFactor: number;
  /** Q3 — price coating off the perimeter with the workbook's constants,
   *  rather than off coated area (§5.5, §11.3). */
  legacyCoatingModel: boolean;
  /** Q4 — coating and silkscreen are added after markups (§5.6). */
  finishesUnmarked: boolean;
}

/** Shop-wide numbers and text (§3). */
export interface ShopDefaults {
  /** Appears on the quote PDF. */
  shopName: string;
  /** Display and entry preference. The engine is always in/lb. */
  unitSystem: UnitSystem;
  /** ISO 4217 code for display, e.g. "USD". Engine arithmetic is unitless. */
  currency: string;
  /** How long a quote is good for, days. */
  validityDays: number;
  /** Terms block printed on the quote. */
  quoteTerms: string;
  /**
   * The quantity columns a quote prices. Six slots the shop's customers
   * recognise, with editable contents — 250 and 500 are common now (§11.2,
   * §11.5). Never hardcode the values.
   */
  defaultQuantityBreaks: number[];
  /**
   * Optional flat charge added to every job, $. Seeds to 0.
   *
   * The workbook's `D13` = $20 is *not* this: it is the sum of the
   * per-operation fixed-dollar column, which for the golden part is the
   * laser's only setup. Treating it as a shop constant double-counts to $40
   * and misses every §9 price (§5.6).
   */
  shopFixedCostPerJobUsd: number;
  /** Multiplier on the material block (§5.6). */
  laborMarkup: number;
  /** Multiplier on the labor block (§5.6). */
  materialMarkup: number;
  /** Engineering/NRE labour, $/hr. */
  nreRatePerHrUsd: number;
  /** Multiplier on NRE. */
  nreMarkup: number;
  /** Length of the minimum-charge strip, inches (§5.1). */
  minChargeStripIn: number;
}

/**
 * The whole of what a shop configures. Assembled by
 * `@shopquote/db`'s `loadShopConfig()` and frozen into every quote version
 * (§7), so re-pricing an old quote is reconstructing its config, not guessing.
 */
export interface ShopConfig {
  /** Bumped when a config written by an older build would no longer load. */
  schemaVersion: 1;
  /** Which shop this is. Present in v1 even though it deploys single-tenant,
   *  so a hosted version later is a deployment choice (§12 rule 4). */
  shopId: string;
  defaults: ShopDefaults;
  families: MaterialFamily[];
  gauges: GaugeEntry[];
  materials: MaterialRow[];
  stockSizes: StockSize[];
  machines: Machine[];
  machineMaterialRates: MachineMaterialRate[];
  operations: Operation[];
  platingSpecs: PlatingSpec[];
  coatingModels: CoatingModel[];
  silkscreenTiers: SilkscreenTier[];
  assemblyStandards: AssemblyStandard[];
  parity: ParityFlags;
  /** Cost modules this shop runs, by id (§12). The roll-up walks these; it
   *  never imports a trade-specific module directly. */
  enabledModules: ModuleId[];
}
