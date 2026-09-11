/**
 * The SQLite schema (REQUIREMENTS §3 domain model, §7 data rules).
 *
 * Two ideas hold this file together.
 *
 * **The catalog tables are the normalised form of `ShopConfig`, and nothing
 * more.** Everything from `shops` down to `assembly_standards` exists because
 * a field of `ShopConfig` needs somewhere to live; nothing is stored "because
 * the workbook had a column for it". That invariant is what makes Task 2.2
 * cheap and testable: `writeShopConfig()` turns a config into rows,
 * `loadShopConfig()` turns rows back into a config, and the golden test runs
 * through both. A table with no `ShopConfig` counterpart could not take part
 * in that round trip, so it would quietly rot.
 *
 * **Everything else is the app around the engine** — users, customers, quotes,
 * versions, attachments, audit. Those tables reference the catalog; the engine
 * never sees them.
 *
 * Conventions, from CLAUDE.md and §7:
 *   - ULID primary keys, generated here rather than by SQLite, so an id exists
 *     before the row is written.
 *   - `created_at` / `updated_at` on every table; `archived_at` on everything
 *     the owner can remove, because nothing is hard-deleted. Sessions, quote
 *     versions, config snapshots and the audit log are the exceptions: a
 *     session expires, and the other three are append-only history.
 *   - `shop_id` on every table (§12 rule 4), even though v1 deploys one shop.
 *   - Money is REAL dollars; lengths are inches; times are hours or seconds.
 *     Column names carry the unit.
 *   - Timestamps are epoch milliseconds, read back as `Date`.
 *   - Uniqueness on a soft-deletable table holds among *live* rows only
 *     (`liveOnly()` below), so an archived row never blocks its successor.
 */

import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { ulid } from 'ulid';

import type {
  CostStack,
  CuttingInput,
  FinishInput,
  HardwareLine,
  MachineKind,
  MachineTimeModel,
  MaterialForm,
  ModuleId,
  NestingInput,
  NreLine,
  OperationKind,
  OperationLine,
  QuoteInput,
  QuoteResult,
  ShopConfig,
  StandardUnit,
  UnitSystem,
} from '@shopquote/calc';

/* -------------------------------------------------------------------------
   Column helpers.

   Each is a *function*: a Drizzle column builder carries state, so sharing one
   instance between two tables would silently share its configuration.
   ------------------------------------------------------------------------- */

const primaryId = () =>
  text('id')
    .primaryKey()
    .$defaultFn(() => ulid());

const clock = () => new Date();

/** `created_at` + `updated_at`, on every table (CLAUDE.md). */
const stamps = () => ({
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(clock),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(clock)
    .$onUpdateFn(clock),
});

/** `stamps()` plus the soft-delete marker (§7 — nothing is hard-deleted). */
const softDelete = () => ({
  ...stamps(),
  archivedAt: integer('archived_at', { mode: 'timestamp_ms' }),
});

/** Multi-tenant key. Present in v1 so a hosted version later is a deployment
 *  choice rather than a migration (§12 rule 4). */
const shopFk = () =>
  text('shop_id')
    .notNull()
    .references(() => shops.id);

/**
 * Where a seeded or imported row came from — the id it carried in the
 * `ShopConfig` that produced it (`material:g30-16-ga-0598`, or another shop's
 * ULID). Provenance only: nothing joins on it, and an owner-created row leaves
 * it null.
 */
const sourceKey = () => text('source_key');

const bool = (name: string) => integer(name, { mode: 'boolean' });

/**
 * The predicate for a partial unique index: unique among rows not archived.
 *
 * Soft delete (§7) keeps a removed row in its table for the quotes that used
 * it, and a plain unique index keeps enforcing against it — so an archived
 * "CRS 16 GA" would block the owner from ever entering a new one, and a config
 * import that archives the old catalog could not write the new one beside it.
 * Written as raw SQL rather than through the column reference because SQLite
 * wants a bare column name in an index predicate.
 */
const liveOnly = () => sql`archived_at IS NULL`;

/* =========================================================================
   Shop, users, sessions
   ========================================================================= */

/**
 * One row per shop: `ShopDefaults`, the four parity flags and the enabled
 * module list (§3, §5.7, §12).
 *
 * Parity flags are four columns rather than one JSON blob because Settings
 * edits them one at a time and §5.7 gives each its own explanation text.
 */
export const shops = sqliteTable('shops', {
  id: primaryId(),
  name: text('name').notNull(),
  /** Path under `data/` to the logo printed on the quote PDF. */
  logoPath: text('logo_path'),
  /** Display and entry preference. The engine is always in/lb (§3). */
  unitSystem: text('unit_system').$type<UnitSystem>().notNull().default('imperial'),
  currency: text('currency').notNull().default('USD'),
  validityDays: integer('validity_days').notNull().default(30),
  quoteTerms: text('quote_terms').notNull().default(''),
  /** The quantity columns a quote prices, e.g. `[1,5,10,30,50,100]` (§3). */
  defaultQuantityBreaks: text('default_quantity_breaks', { mode: 'json' })
    .$type<number[]>()
    .notNull(),
  /** Optional flat charge per job, $. Seeds to 0 — the workbook's $20 is the
   *  setup roll-up, not a shop constant (§5.6). */
  shopFixedCostPerJobUsd: real('shop_fixed_cost_per_job_usd').notNull().default(0),
  laborMarkup: real('labor_markup').notNull(),
  materialMarkup: real('material_markup').notNull(),
  nreRatePerHrUsd: real('nre_rate_per_hr_usd').notNull(),
  nreMarkup: real('nre_markup').notNull(),
  /** Length of the minimum-charge strip, inches (§5.1). */
  minChargeStripIn: real('min_charge_strip_in').notNull(),
  /** Q1 — material markup applied inside the minimum-charge MAX (§5.7). */
  parityMarkupInsideMinChargeMax: bool('parity_markup_inside_min_charge_max')
    .notNull()
    .default(true),
  /** Q2 — machine time billed at this multiple. 0.6 is the workbook, 1.0 bills
   *  machine time as machine time. A number, not a flag (§5.4). */
  parityMachineTimeFactor: real('parity_machine_time_factor').notNull().default(0.6),
  /** Q3 — price coating off the perimeter with the workbook's constants. */
  parityLegacyCoatingModel: bool('parity_legacy_coating_model').notNull().default(true),
  /** Q4 — coating and silkscreen added after markups (§5.6). */
  parityFinishesUnmarked: bool('parity_finishes_unmarked').notNull().default(true),
  /** Cost modules this shop runs, by id (§12). */
  enabledModules: text('enabled_modules', { mode: 'json' }).$type<ModuleId[]>().notNull(),
  /** `ShopConfig.schemaVersion` this row was written for. */
  calcSchemaVersion: integer('calc_schema_version').notNull().default(1),
  ...softDelete(),
});

/** §4 FR-6. Roles are the three in §2; hashing lives in `password.ts`. */
export const users = sqliteTable(
  'users',
  {
    id: primaryId(),
    shopId: shopFk(),
    username: text('username').notNull(),
    email: text('email'),
    displayName: text('display_name'),
    role: text('role').$type<'estimator' | 'owner' | 'admin'>().notNull(),
    /** PHC-format string; the algorithm is named inside it (`password.ts`). */
    passwordHash: text('password_hash').notNull(),
    /** Set on the seeded admin, cleared once the owner picks their own. */
    mustChangePassword: bool('must_change_password').notNull().default(false),
    lastLoginAt: integer('last_login_at', { mode: 'timestamp_ms' }),
    ...softDelete(),
  },
  (t) => [uniqueIndex('users_shop_username_idx').on(t.shopId, t.username).where(liveOnly())],
);

/** Server-side sessions, 12 h (§7 security). No soft delete: a session that is
 *  over is gone. */
export const sessions = sqliteTable(
  'sessions',
  {
    id: primaryId(),
    shopId: shopFk(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    ...stamps(),
  },
  (t) => [index('sessions_user_idx').on(t.userId), index('sessions_expires_idx').on(t.expiresAt)],
);

/* =========================================================================
   Material catalog
   ========================================================================= */

/** `MaterialFamily` — steel, aluminium, acrylic, plywood (§3). */
export const materialFamilies = sqliteTable(
  'material_families',
  {
    id: primaryId(),
    shopId: shopFk(),
    sourceKey: sourceKey(),
    name: text('name').notNull(),
    /** lb/in³. Null when the shop works from areal weights only. */
    densityLbPerCuIn: real('density_lb_per_cu_in'),
    defaultScrapPricePerLbUsd: real('default_scrap_price_per_lb_usd').notNull().default(0),
    ...softDelete(),
  },
  (t) => [uniqueIndex('material_families_shop_name_idx').on(t.shopId, t.name).where(liveOnly())],
);

/** `GaugeEntry` — family × gauge label → decimal thickness (§3). */
export const gaugeReference = sqliteTable(
  'gauge_reference',
  {
    id: primaryId(),
    shopId: shopFk(),
    sourceKey: sourceKey(),
    familyId: text('family_id')
      .notNull()
      .references(() => materialFamilies.id),
    /** What the drawing says, e.g. "16 ga". */
    label: text('label').notNull(),
    thicknessIn: real('thickness_in').notNull(),
    /** Coated stock weighs more than thickness × density implies; when set
     *  this wins over the derived value. lb/ft². */
    lbPerSqFtOverride: real('lb_per_sq_ft_override'),
    ...softDelete(),
  },
  (t) => [
    uniqueIndex('gauge_reference_shop_family_label_idx')
      .on(t.shopId, t.familyId, t.label)
      .where(liveOnly()),
  ],
);

/**
 * `MaterialRow` — one stock item.
 *
 * No price column: $/lb is versioned in `material_prices` (§7), and a
 * `ShopConfig` carries whichever version was effective at its `asOf`. No
 * machine numbers either — speed, pierce and punch factor are properties of a
 * machine/material *pairing* (§3).
 */
export const materials = sqliteTable(
  'materials',
  {
    id: primaryId(),
    shopId: shopFk(),
    sourceKey: sourceKey(),
    name: text('name').notNull(),
    familyId: text('family_id')
      .notNull()
      .references(() => materialFamilies.id),
    form: text('form').$type<MaterialForm>().notNull().default('sheet'),
    thicknessIn: real('thickness_in'),
    /** Areal weight, lb/ft². Coated steels carry their coated weight (§5.1). */
    lbPerSqFt: real('lb_per_sq_ft').notNull(),
    /** Tariff/alloy surcharge as a fraction of $/lb (§11.2). */
    surchargePct: real('surcharge_pct').notNull().default(0),
    /** Scrap credit, $/lb. Supported, off by default (§11.4 item 4). */
    scrapPricePerLbUsd: real('scrap_price_per_lb_usd').notNull().default(0),
    /** Default cut length, inches (§5.1). */
    standardLengthIn: real('standard_length_in'),
    active: bool('active').notNull().default(true),
    ...softDelete(),
  },
  (t) => [
    uniqueIndex('materials_shop_name_idx').on(t.shopId, t.name).where(liveOnly()),
    index('materials_family_idx').on(t.familyId),
  ],
);

/**
 * Versioned $/lb (§7). A price change is a new row, never an update, so
 * re-pricing an old quote can ask what the price was on the day.
 *
 * `sheet_cost_usd` and `sheet_lbs` ride along because they are how the owner
 * actually arrives at a price — what a sheet cost and what it weighed (§11.2's
 * $/cwt entry). They are provenance *for this price*, which is why they are
 * here rather than on `materials`.
 */
export const materialPrices = sqliteTable(
  'material_prices',
  {
    id: primaryId(),
    shopId: shopFk(),
    materialId: text('material_id')
      .notNull()
      .references(() => materials.id),
    pricePerLbUsd: real('price_per_lb_usd').notNull(),
    sheetCostUsd: real('sheet_cost_usd'),
    sheetLbs: real('sheet_lbs'),
    effectiveFrom: integer('effective_from', { mode: 'timestamp_ms' }).notNull(),
    enteredByUserId: text('entered_by_user_id').references(() => users.id),
    note: text('note'),
    ...softDelete(),
  },
  (t) => [index('material_prices_material_effective_idx').on(t.materialId, t.effectiveFrom)],
);

/** `StockSize` — a size the shop can buy a material in (§3). Replaces any
 *  hardcoded sheet list. `material_id` null means it applies to the family. */
export const stockSizes = sqliteTable(
  'stock_sizes',
  {
    id: primaryId(),
    shopId: shopFk(),
    sourceKey: sourceKey(),
    materialId: text('material_id').references(() => materials.id),
    familyId: text('family_id').references(() => materialFamilies.id),
    lengthIn: real('length_in').notNull(),
    widthIn: real('width_in').notNull(),
    preferred: bool('preferred').notNull().default(false),
    ...softDelete(),
  },
  (t) => [index('stock_sizes_material_idx').on(t.materialId)],
);

/* =========================================================================
   Work centres
   ========================================================================= */

/**
 * `Machine` — a work centre. A shop with two lasers has two rows, each with
 * its own kerf, rate and speeds (§3).
 *
 * Every timing constant the workbook buried inside a formula is a column here.
 * `time_model` — not `kind` — is what selects the cost contributor, so adding
 * a waterjet is a Settings row rather than a code change (§12 rule 2).
 */
export const machines = sqliteTable(
  'machines',
  {
    id: primaryId(),
    shopId: shopFk(),
    sourceKey: sourceKey(),
    name: text('name').notNull(),
    /** Descriptive label; nothing branches on it (§3). */
    kind: text('kind').$type<MachineKind>().notNull(),
    /** Selects the contributor that prices this machine's time (§12). */
    timeModel: text('time_model').$type<MachineTimeModel>().notNull(),
    ratePerHrUsd: real('rate_per_hr_usd').notNull().default(0),
    setupHrsDefault: real('setup_hrs_default').notNull().default(0),
    /** Assist gas and other consumables, $/hr (§11.2). */
    consumablesPerHrUsd: real('consumables_per_hr_usd').notNull().default(0),
    maxSheetLengthIn: real('max_sheet_length_in'),
    maxSheetWidthIn: real('max_sheet_width_in'),
    /** Clamp strip lost off one width edge, inches (§5.1). */
    clampStripIn: real('clamp_strip_in').notNull().default(0),
    /** Kerf / part spacing added to each part dimension, inches. Settings
     *  data, not a parity flag — §5.7 Q5 was withdrawn for that reason. */
    kerfIn: real('kerf_in').notNull().default(0),
    palletChangeSec: real('pallet_change_sec').notNull().default(0),
    /** The batch a pallet change is spread over, and the sheet yield above
     *  which no change is needed inside it. One number for both (§5.2). */
    palletBatchParts: real('pallet_batch_parts').notNull().default(100),
    intersectionSec: real('intersection_sec').notNull().default(0),
    rapidSecPerPierce: real('rapid_sec_per_pierce').notNull().default(0),
    /** Multiplier on computed cut time for real-world losses, e.g. 1.08. */
    lossFactor: real('loss_factor').notNull().default(1),
    loadUnloadSecPerBlank: real('load_unload_sec_per_blank').notNull().default(0),
    active: bool('active').notNull().default(true),
    ...softDelete(),
  },
  (t) => [uniqueIndex('machines_shop_name_idx').on(t.shopId, t.name).where(liveOnly())],
);

/**
 * `MachineMaterialRate` — what one machine achieves in one material (§3).
 * This is where the workbook's speed, pierce and punch-factor columns went.
 * A missing pair warns the estimator; it never silently defaults (§12 rule 3).
 */
export const machineMaterialRates = sqliteTable(
  'machine_material_rates',
  {
    id: primaryId(),
    shopId: shopFk(),
    machineId: text('machine_id')
      .notNull()
      .references(() => machines.id),
    materialId: text('material_id')
      .notNull()
      .references(() => materials.id),
    cutSpeedInPerMin: real('cut_speed_in_per_min').notNull().default(0),
    pierceSeconds: real('pierce_seconds').notNull().default(0),
    /** Multiplier on hit rates for this stock's hardness. 0 = cannot be
     *  punched, which is a warning rather than a division by zero (§5.3). */
    punchRateFactor: real('punch_rate_factor').notNull().default(0),
    ...softDelete(),
  },
  (t) => [
    uniqueIndex('machine_material_rates_pair_idx').on(t.machineId, t.materialId).where(liveOnly()),
  ],
);

/** `PunchHitRate` — a tool's hit rate, per punch machine (§5.3). Ten tools in
 *  the workbook's seed; its "TOTAL HIT COUNT" row is a subtotal, not a tool. */
export const punchHitRates = sqliteTable(
  'punch_hit_rates',
  {
    id: primaryId(),
    shopId: shopFk(),
    sourceKey: sourceKey(),
    machineId: text('machine_id')
      .notNull()
      .references(() => machines.id),
    name: text('name').notNull(),
    hitsPerHr: real('hits_per_hr').notNull(),
    /** Some tools cost more than one hit per feature (countersink 3). */
    multiplier: real('multiplier').notNull().default(1),
    ...softDelete(),
  },
  (t) => [index('punch_hit_rates_machine_idx').on(t.machineId)],
);

/** `Operation` — setup + standard + rate (§5.4). `kind` selects quirk Q2's
 *  factor; `machine_id` is what a machine op takes its hours from. */
export const operations = sqliteTable(
  'operations',
  {
    id: primaryId(),
    shopId: shopFk(),
    sourceKey: sourceKey(),
    name: text('name').notNull(),
    machineId: text('machine_id').references(() => machines.id),
    kind: text('kind').$type<OperationKind>().notNull(),
    /** Setup per job, hours. Rolls into fixed cost (§5.6). */
    setupHrs: real('setup_hrs').notNull().default(0),
    /** Units per hour. Null for machine ops, whose hours come from §5.2/§5.3. */
    standardPerHr: real('standard_per_hr'),
    standardUnit: text('standard_unit').$type<StandardUnit>(),
    /** $/hr. Null means inherit from the linked machine. */
    ratePerHrUsd: real('rate_per_hr_usd'),
    active: bool('active').notNull().default(true),
    ...softDelete(),
  },
  // Not unique: the workbook carries "BRAKE, BEND" twice, at 222/hr and
  // 330/hr, and both are real standards the estimator picks between. A shop
  // may equally run two deburr benches at different rates.
  (t) => [index('operations_shop_name_idx').on(t.shopId, t.name)],
);

/* =========================================================================
   Finishing
   ========================================================================= */

/** `PlatingSpec` — the MAX(lot ÷ qty, $/in², part min) rule's data (§5.5). */
export const platingSpecs = sqliteTable(
  'plating_specs',
  {
    id: primaryId(),
    shopId: shopFk(),
    sourceKey: sourceKey(),
    name: text('name').notNull(),
    lotMinimumUsd: real('lot_minimum_usd').notNull().default(0),
    /** $ per square inch of finished area. A footprint rate that already has
     *  both faces in it — see §11.3; doubling the area would double the
     *  price. */
    pricePerSqInUsd: real('price_per_sq_in_usd').notNull().default(0),
    partMinimumUsd: real('part_minimum_usd').notNull().default(0),
    /** Null when unknown. False warns for a RoHS customer (§11.2). */
    rohsCompliant: bool('rohs_compliant'),
    active: bool('active').notNull().default(true),
    ...softDelete(),
  },
  (t) => [uniqueIndex('plating_specs_shop_name_idx').on(t.shopId, t.name).where(liveOnly())],
);

/**
 * `CoatingModel` — both models, so parity flag Q3 has a real alternative
 * rather than a hole (§11.3).
 *
 * The `legacy_*` group is the workbook's `rate × (perimeter ÷ coverage × S)`;
 * the `modern_*` group is the powder trade's coverage formula. Either group
 * being null means that model is not configured, which produces a warning
 * rather than a zero. There is no `active` column on purpose: `CoatingModel`
 * has no such field, so an active flag here could not survive the round trip
 * through `ShopConfig`. Archive the row instead.
 */
export const coatingModels = sqliteTable(
  'coating_models',
  {
    id: primaryId(),
    shopId: shopFk(),
    sourceKey: sourceKey(),
    name: text('name').notNull(),
    /** Floor charge per part, $. */
    minimumChargeUsd: real('minimum_charge_usd').notNull().default(0),
    legacyRateUsd: real('legacy_rate_usd'),
    legacyCoverage: real('legacy_coverage'),
    /** The workbook's unexplained 5 — §10 question 2. */
    legacySConstant: real('legacy_s_constant'),
    /** From the powder's data sheet. */
    modernSpecificGravity: real('modern_specific_gravity'),
    /** Target film build, mils, from the finish spec. */
    modernFilmThicknessMils: real('modern_film_thickness_mils'),
    /** Fraction of sprayed powder that lands on the part, 0–1, from the booth. */
    modernTransferEfficiency: real('modern_transfer_efficiency'),
    modernPowderPricePerLbUsd: real('modern_powder_price_per_lb_usd'),
    modernRackLaborUsdPerPart: real('modern_rack_labor_usd_per_part'),
    modernMaskingUsdPerFeature: real('modern_masking_usd_per_feature'),
    ...softDelete(),
  },
  (t) => [uniqueIndex('coating_models_shop_name_idx').on(t.shopId, t.name).where(liveOnly())],
);

/** `SilkscreenTier` — screen charge amortised, plus print cost per part. */
export const silkscreenTiers = sqliteTable(
  'silkscreen_tiers',
  {
    id: primaryId(),
    shopId: shopFk(),
    sourceKey: sourceKey(),
    name: text('name').notNull(),
    /** One-time screen charge, $. Null = customer supplies the screen. */
    screenCostUsd: real('screen_cost_usd'),
    printCostUsd: real('print_cost_usd').notNull().default(0),
    active: bool('active').notNull().default(true),
    ...softDelete(),
  },
  (t) => [uniqueIndex('silkscreen_tiers_shop_name_idx').on(t.shopId, t.name).where(liveOnly())],
);

/** `AssemblyStandard` — seconds per action (§3). */
export const assemblyStandards = sqliteTable(
  'assembly_standards',
  {
    id: primaryId(),
    shopId: shopFk(),
    sourceKey: sourceKey(),
    /** Grouping from the workbook's sheet, e.g. "HARDWARE / TIEWRAPS". */
    section: text('section'),
    action: text('action').notNull(),
    standardSeconds: real('standard_seconds').notNull(),
    ...softDelete(),
  },
  (t) => [index('assembly_standards_shop_idx').on(t.shopId)],
);

/* =========================================================================
   Intake
   ========================================================================= */

/**
 * Every alias the intake resolvers match against (§8, §12): the alternative
 * names a material, family or plating spec goes by, plus CSV header synonyms
 * and drawing keywords.
 *
 * They live in one table rather than as a JSON column on each row because §12
 * lists them as a single body of Settings data, and because Task 3.3's
 * resolver wants one indexed lookup rather than four.
 */
export const intakeAliases = sqliteTable(
  'intake_aliases',
  {
    id: primaryId(),
    shopId: shopFk(),
    /** What the alias points at. `csvHeader` and `drawingKeyword` have no
     *  target row — they map onto a field name held in `target_field`. */
    kind: text('kind')
      .$type<'material' | 'family' | 'plating' | 'csvHeader' | 'drawingKeyword'>()
      .notNull(),
    /** The catalog row this alias resolves to, when `kind` names one. */
    targetId: text('target_id'),
    /** The `PartInput` field a header or keyword maps onto, when it does. */
    targetField: text('target_field'),
    /** What the file or drawing says, matched case-insensitively. */
    alias: text('alias').notNull(),
    ...softDelete(),
  },
  (t) => [
    uniqueIndex('intake_aliases_shop_kind_alias_idx')
      .on(t.shopId, t.kind, t.alias)
      .where(liveOnly()),
    index('intake_aliases_target_idx').on(t.targetId),
  ],
);

/* =========================================================================
   Customers, parts, quotes
   ========================================================================= */

export const customers = sqliteTable(
  'customers',
  {
    id: primaryId(),
    shopId: shopFk(),
    name: text('name').notNull(),
    contactName: text('contact_name'),
    email: text('email'),
    phone: text('phone'),
    terms: text('terms'),
    /** Overrides the shop's markups for this customer (§3). */
    markupOverride: real('markup_override'),
    /** Warn when a non-RoHS finish is picked for this customer (§11.2). */
    rohsRequired: bool('rohs_required').notNull().default(false),
    notes: text('notes'),
    ...softDelete(),
  },
  (t) => [uniqueIndex('customers_shop_name_idx').on(t.shopId, t.name).where(liveOnly())],
);

/**
 * A part, as the estimator entered it (§3).
 *
 * Identity and the fields anything searches or filters on are columns; the
 * repeating structures — the cut-feature list, the operation lines, the finish
 * selections, hardware and NRE — are JSON typed to `PartInput`'s own members.
 *
 * That split is deliberate. Normalising the lists would mean five more tables,
 * a mapping layer to keep in step with `PartInput`, and a migration every time
 * the engine learns a new feature shape; nothing queries across them (no
 * screen asks "which parts have more than four bends"). Keeping identity in
 * columns means the quote log, part search and a material-usage report stay
 * ordinary SQL. Zod validates the JSON at the API boundary in Phase 3, and
 * `PartInput` is the shape it validates against.
 */
export const parts = sqliteTable(
  'parts',
  {
    id: primaryId(),
    shopId: shopFk(),
    /** Whose part this is. Null for a shop's own stock item. */
    customerId: text('customer_id').references(() => customers.id),
    partNumber: text('part_number').notNull(),
    rev: text('rev'),
    description: text('description'),
    materialId: text('material_id').references(() => materials.id),
    flatLengthIn: real('flat_length_in'),
    flatWidthIn: real('flat_width_in'),
    /** Net area after holes, in², for finishing. Falls back to blank area. */
    finishedAreaSqIn: real('finished_area_sq_in'),
    nesting: text('nesting', { mode: 'json' }).$type<NestingInput | null>(),
    cutting: text('cutting', { mode: 'json' }).$type<CuttingInput | null>(),
    operations: text('operations', { mode: 'json' }).$type<OperationLine[]>(),
    finish: text('finish', { mode: 'json' }).$type<FinishInput | null>(),
    hardware: text('hardware', { mode: 'json' }).$type<HardwareLine[]>(),
    nre: text('nre', { mode: 'json' }).$type<NreLine[]>(),
    /** §5.6 `sheet_extras` — freight-in, cut-to-size. $ per part. */
    materialExtrasUsd: real('material_extras_usd').notNull().default(0),
    /** §5.6 `setup_extra_labor` — fixturing, first article. $ per job. */
    setupExtraLaborUsd: real('setup_extra_labor_usd').notNull().default(0),
    notes: text('notes'),
    /** How the part got here: typed, a CSV row, a drawing, a DXF, a copy
     *  (§4 FR-3, §11.4 item 1). */
    source: text('source').$type<'manual' | 'csv' | 'pdf' | 'dxf' | 'copy'>(),
    ...softDelete(),
  },
  (t) => [
    index('parts_shop_number_idx').on(t.shopId, t.partNumber),
    index('parts_customer_idx').on(t.customerId),
  ],
);

/** A quote (§3). `quote_number` is the human sequence `Q-YYYY-NNNN`; the row's
 *  own identity is its ULID. */
export const quotes = sqliteTable(
  'quotes',
  {
    id: primaryId(),
    shopId: shopFk(),
    quoteNumber: text('quote_number').notNull(),
    customerId: text('customer_id').references(() => customers.id),
    status: text('status')
      .$type<'draft' | 'sent' | 'won' | 'lost' | 'expired'>()
      .notNull()
      .default('draft'),
    quoteDate: integer('quote_date', { mode: 'timestamp_ms' }).notNull(),
    validUntil: integer('valid_until', { mode: 'timestamp_ms' }),
    /** Terms as printed on this quote, snapshotted from the shop's at save. */
    terms: text('terms'),
    notes: text('notes'),
    /** Why it was won or lost, recorded on the status change (§4 FR-4). */
    wonLostReason: text('won_lost_reason'),
    /** Points at the newest `quote_versions.version_no`, so the editor can
     *  find the current state without a MAX() on every list render. */
    currentVersionNo: integer('current_version_no').notNull().default(0),
    createdByUserId: text('created_by_user_id').references(() => users.id),
    ...softDelete(),
  },
  (t) => [
    // Not live-only, unlike the catalog's names: a quote number is never
    // reused, archived or not. It is what a customer's PO refers back to.
    uniqueIndex('quotes_shop_number_idx').on(t.shopId, t.quoteNumber),
    index('quotes_customer_idx').on(t.customerId),
    index('quotes_status_date_idx').on(t.shopId, t.status, t.quoteDate),
  ],
);

/** A part on a quote, priced at its own quantity breaks (§3). `result` is the
 *  latest cost stack, kept here so the quote list renders without unpacking a
 *  snapshot; `quote_versions` holds the history. */
export const quoteLines = sqliteTable(
  'quote_lines',
  {
    id: primaryId(),
    shopId: shopFk(),
    quoteId: text('quote_id')
      .notNull()
      .references(() => quotes.id),
    partId: text('part_id')
      .notNull()
      .references(() => parts.id),
    sortOrder: integer('sort_order').notNull().default(0),
    /** Overrides the shop's default breaks for this line (§4 FR-2). */
    quantityBreaks: text('quantity_breaks', { mode: 'json' }).$type<number[]>().notNull(),
    /** Latest cost stack per break, from the most recent calc run. */
    result: text('result', { mode: 'json' }).$type<CostStack[] | null>(),
    leadTimeDays: integer('lead_time_days'),
    notes: text('notes'),
    ...softDelete(),
  },
  (t) => [index('quote_lines_quote_idx').on(t.quoteId, t.sortOrder)],
);

/**
 * The config a quote was priced with (§7), content-addressed.
 *
 * §4 FR-2 makes every autosave a version, and a `ShopConfig` carrying the whole
 * catalog is ~100 KB of JSON. Storing one copy per version would put tens of
 * megabytes a day into a file whose backup story is "copy it" — and every one
 * of those copies would be identical, because Settings changes a few times a
 * year while autosave fires every few seconds. So a snapshot is stored once per
 * distinct config and referenced by hash: a day of editing shares one row, and
 * re-pricing after a rate change writes exactly one more.
 */
export const configSnapshots = sqliteTable(
  'config_snapshots',
  {
    id: primaryId(),
    shopId: shopFk(),
    /** SHA-256 of the canonical JSON. Identity, not integrity. */
    hash: text('hash').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    config: text('config', { mode: 'json' }).$type<ShopConfig>().notNull(),
    ...stamps(),
  },
  (t) => [uniqueIndex('config_snapshots_shop_hash_idx').on(t.shopId, t.hash)],
);

/** One save of a quote: what was entered, what it was priced with, and what
 *  came out (§7). Append-only — this is the audit trail for pricing. */
export const quoteVersions = sqliteTable(
  'quote_versions',
  {
    id: primaryId(),
    shopId: shopFk(),
    quoteId: text('quote_id')
      .notNull()
      .references(() => quotes.id),
    versionNo: integer('version_no').notNull(),
    configSnapshotId: text('config_snapshot_id')
      .notNull()
      .references(() => configSnapshots.id),
    input: text('input', { mode: 'json' }).$type<QuoteInput>().notNull(),
    result: text('result', { mode: 'json' }).$type<QuoteResult>().notNull(),
    /** Why this version exists: an autosave, or an explicit re-price (§7). */
    reason: text('reason').$type<'save' | 'reprice' | 'copy'>().notNull().default('save'),
    createdByUserId: text('created_by_user_id').references(() => users.id),
    ...stamps(),
  },
  (t) => [uniqueIndex('quote_versions_quote_no_idx').on(t.quoteId, t.versionNo)],
);

/** A file on disk under `data/attachments/<quote>/` (§7). Never executed. */
export const attachments = sqliteTable(
  'attachments',
  {
    id: primaryId(),
    shopId: shopFk(),
    quoteId: text('quote_id').references(() => quotes.id),
    partId: text('part_id').references(() => parts.id),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    byteSize: integer('byte_size').notNull(),
    /** Content hash, so the same drawing on two parts is stored once. */
    sha256: text('sha256').notNull(),
    /** Path relative to the data directory. */
    storagePath: text('storage_path').notNull(),
    uploadedByUserId: text('uploaded_by_user_id').references(() => users.id),
    ...softDelete(),
  },
  (t) => [index('attachments_quote_idx').on(t.quoteId), index('attachments_part_idx').on(t.partId)],
);

/** Who changed what (§4 FR-6). Append-only: no update, no archive. */
export const auditLog = sqliteTable(
  'audit_log',
  {
    id: primaryId(),
    shopId: shopFk(),
    actorUserId: text('actor_user_id').references(() => users.id),
    /** Verb, e.g. "material.price.create", "quote.status.change". */
    action: text('action').notNull(),
    /** The table and row it happened to. */
    entityTable: text('entity_table'),
    entityId: text('entity_id'),
    /** One line a person can read. */
    summary: text('summary'),
    before: text('before', { mode: 'json' }),
    after: text('after', { mode: 'json' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(clock),
  },
  (t) => [
    index('audit_log_shop_created_idx').on(t.shopId, t.createdAt),
    index('audit_log_entity_idx').on(t.entityTable, t.entityId),
  ],
);
