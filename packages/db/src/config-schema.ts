/**
 * Zod schemas for `ShopConfig` — the shape of the config JSON (§8: "full
 * export/import; schema versioned, schemaVersion: 1") and of every Settings
 * write the API accepts.
 *
 * They mirror calc's interfaces rather than replace them, as `seed-files.ts`
 * does: calc owns the shape, and each schema `satisfies` the calc type it
 * validates, so the build fails if the two drift apart.
 *
 * Two layers of checking, because they catch different mistakes:
 *
 *   - **Per field.** Types, and the ranges that are physics rather than
 *     opinion: nothing a shop enters is negative, and a number calc divides
 *     by — a loss factor, a standard, a coverage — cannot be zero. Bounds that
 *     would be shop policy (a "sensible" markup) are not here; §12 says those
 *     are the owner's.
 *   - **Across the config** (`shopConfigSchema`'s refinement). Ids unique,
 *     every reference resolving inside the same config, names unique wherever
 *     the database holds them unique. A config that failed these would fail
 *     half-way through `writeShopConfig()` on a constraint; here it fails up
 *     front, naming the row.
 */

import { z } from 'zod';

import {
  defaultRegistry,
  type AssemblyStandard,
  type CoatingModel,
  type GaugeEntry,
  type Machine,
  type MachineKind,
  type MachineMaterialRate,
  type MachineTimeModel,
  type MaterialFamily,
  type MaterialForm,
  type MaterialRow,
  type ModuleId,
  type Operation,
  type OperationKind,
  type ParityFlags,
  type PlatingSpec,
  type PunchHitRate,
  type ShopConfig,
  type ShopDefaults,
  type SilkscreenTier,
  type StandardUnit,
  type StockSize,
  type UnitSystem,
} from '@shopquote/calc';

/* -------------------------------------------------------------------------
   Enumerations, checked against calc's unions in both directions: `satisfies`
   rejects a value calc does not have, and `Exhaustive` rejects a list missing
   one it does — so a machine kind calc adds cannot be refused here by
   omission.
   ------------------------------------------------------------------------- */

type Exhaustive<T, U extends readonly unknown[]> = [Exclude<T, U[number]>] extends [never]
  ? U
  : never;

const MATERIAL_FORMS = [
  'sheet',
  'plate',
  'bar',
  'tube',
  'purchased',
] as const satisfies readonly MaterialForm[];
const MACHINE_KINDS = [
  'laser',
  'punch',
  'waterjet',
  'plasma',
  'shear',
  'brake',
  'weld',
  'deburr',
  'other',
] as const satisfies readonly MachineKind[];
const TIME_MODELS = [
  'featureBased',
  'hitBased',
  'none',
] as const satisfies readonly MachineTimeModel[];
const OPERATION_KINDS = ['machine', 'manual'] as const satisfies readonly OperationKind[];
const STANDARD_UNITS = ['pieces', 'inches', 'sqIn'] as const satisfies readonly StandardUnit[];
const UNIT_SYSTEMS = ['imperial', 'metric'] as const satisfies readonly UnitSystem[];

const _exhaustive: [
  Exhaustive<MaterialForm, typeof MATERIAL_FORMS>,
  Exhaustive<MachineKind, typeof MACHINE_KINDS>,
  Exhaustive<MachineTimeModel, typeof TIME_MODELS>,
  Exhaustive<OperationKind, typeof OPERATION_KINDS>,
  Exhaustive<StandardUnit, typeof STANDARD_UNITS>,
  Exhaustive<UnitSystem, typeof UNIT_SYSTEMS>,
] = [MATERIAL_FORMS, MACHINE_KINDS, TIME_MODELS, OPERATION_KINDS, STANDARD_UNITS, UNIT_SYSTEMS];

/* -------------------------------------------------------------------------
   Field types
   ------------------------------------------------------------------------- */

const id = z.string().min(1).max(200);
const name = z.string().min(1).max(200);
const alias = z.string().min(1).max(100);
/** Money, lengths, times, rates: nothing a shop enters is below zero. */
const amount = z.number().finite().nonnegative();
/** Something calc divides by, or multiplies a whole price by. Zero would be a
 *  division by zero or a part quoted at nothing. */
const positive = z.number().finite().positive();

/* -------------------------------------------------------------------------
   Entities
   ------------------------------------------------------------------------- */

export const materialFamilySchema = z
  .object({
    id,
    name,
    densityLbPerCuIn: positive.nullable(),
    defaultScrapPricePerLbUsd: amount,
    aliases: z.array(alias),
  })
  .strict() satisfies z.ZodType<MaterialFamily, z.ZodTypeDef, unknown>;

export const gaugeEntrySchema = z
  .object({
    id,
    familyId: id,
    label: z.string().min(1).max(50),
    thicknessIn: positive,
    lbPerSqFtOverride: positive.nullable(),
  })
  .strict() satisfies z.ZodType<GaugeEntry, z.ZodTypeDef, unknown>;

export const materialRowSchema = z
  .object({
    id,
    name,
    familyId: id,
    form: z.enum(MATERIAL_FORMS),
    thicknessIn: positive.nullable(),
    // Zero is legitimate: the workbook's "NO MATERIAL SELECTED" placeholder.
    lbPerSqFt: amount,
    // Null is legitimate and is not zero: stocked, never priced (§3).
    pricePerLbUsd: amount.nullable(),
    surchargePct: amount,
    scrapPricePerLbUsd: amount,
    standardLengthIn: positive.nullable(),
    aliases: z.array(alias),
    sheetCostUsd: amount.nullable(),
    sheetLbs: amount.nullable(),
    active: z.boolean(),
  })
  .strict() satisfies z.ZodType<MaterialRow, z.ZodTypeDef, unknown>;

export const stockSizeSchema = z
  .object({
    id,
    materialId: id.nullable(),
    familyId: id.nullable(),
    lengthIn: positive,
    widthIn: positive,
    preferred: z.boolean(),
  })
  .strict() satisfies z.ZodType<StockSize, z.ZodTypeDef, unknown>;

export const punchHitRateSchema = z
  .object({ id, name, hitsPerHr: positive, multiplier: positive })
  .strict() satisfies z.ZodType<PunchHitRate, z.ZodTypeDef, unknown>;

export const machineSchema = z
  .object({
    id,
    name,
    kind: z.enum(MACHINE_KINDS),
    timeModel: z.enum(TIME_MODELS),
    ratePerHrUsd: amount,
    setupHrsDefault: amount,
    consumablesPerHrUsd: amount,
    maxSheetLengthIn: positive.nullable(),
    maxSheetWidthIn: positive.nullable(),
    clampStripIn: amount,
    kerfIn: amount,
    palletChangeSec: amount,
    palletBatchParts: positive,
    intersectionSec: amount,
    rapidSecPerPierce: amount,
    lossFactor: positive,
    loadUnloadSecPerBlank: amount,
    hitRates: z.array(punchHitRateSchema),
    active: z.boolean(),
  })
  .strict() satisfies z.ZodType<Machine, z.ZodTypeDef, unknown>;

export const machineMaterialRateSchema = z
  .object({
    machineId: id,
    materialId: id,
    cutSpeedInPerMin: amount,
    pierceSeconds: amount,
    // Zero means "cannot be punched" — a warning in calc, not a divisor (§5.3).
    punchRateFactor: amount,
  })
  .strict() satisfies z.ZodType<MachineMaterialRate, z.ZodTypeDef, unknown>;

export const operationSchema = z
  .object({
    id,
    name,
    machineId: id.nullable(),
    kind: z.enum(OPERATION_KINDS),
    setupHrs: amount,
    standardPerHr: positive.nullable(),
    standardUnit: z.enum(STANDARD_UNITS).nullable(),
    ratePerHrUsd: amount.nullable(),
    active: z.boolean(),
  })
  .strict() satisfies z.ZodType<Operation, z.ZodTypeDef, unknown>;

export const platingSpecSchema = z
  .object({
    id,
    name,
    aliases: z.array(alias),
    lotMinimumUsd: amount,
    pricePerSqInUsd: amount,
    partMinimumUsd: amount,
    rohsCompliant: z.boolean().nullable(),
    active: z.boolean(),
  })
  .strict() satisfies z.ZodType<PlatingSpec, z.ZodTypeDef, unknown>;

export const coatingModelSchema = z
  .object({
    id,
    name,
    minimumChargeUsd: amount,
    legacy: z
      .object({ rateUsd: amount, coverage: positive, sConstant: amount })
      .strict()
      .nullable(),
    modern: z
      .object({
        specificGravity: positive,
        filmThicknessMils: positive,
        transferEfficiency: z
          .number()
          .finite()
          .gt(0)
          .lte(1, 'A fraction of the powder sprayed, above 0 and at most 1.'),
        powderPricePerLbUsd: amount,
        rackLaborUsdPerPart: amount,
        maskingUsdPerFeature: amount,
      })
      .strict()
      .nullable(),
  })
  .strict() satisfies z.ZodType<CoatingModel, z.ZodTypeDef, unknown>;

export const silkscreenTierSchema = z
  .object({ id, name, screenCostUsd: amount.nullable(), printCostUsd: amount, active: z.boolean() })
  .strict() satisfies z.ZodType<SilkscreenTier, z.ZodTypeDef, unknown>;

export const assemblyStandardSchema = z
  .object({
    id,
    section: z.string().max(200).nullable(),
    action: z.string().min(1).max(300),
    standardSeconds: amount,
  })
  .strict() satisfies z.ZodType<AssemblyStandard, z.ZodTypeDef, unknown>;

/* -------------------------------------------------------------------------
   Shop-wide settings
   ------------------------------------------------------------------------- */

export const parityFlagsSchema = z
  .object({
    markupInsideMinChargeMax: z.boolean(),
    machineTimeFactor: amount.max(
      5,
      'A multiple of machine time: 0.6 is the workbook, 1.0 bills machine time as it runs. ' +
        'Anything above 5 is almost certainly the workbook’s ×60 typed in as 60.',
    ),
    legacyCoatingModel: z.boolean(),
    finishesUnmarked: z.boolean(),
  })
  .strict() satisfies z.ZodType<ParityFlags, z.ZodTypeDef, unknown>;

export const quantityBreaksSchema = z
  .array(z.number().int().positive())
  .min(1)
  .max(12)
  .refine(
    (breaks) => breaks.every((q, i) => i === 0 || q > (breaks[i - 1] ?? 0)),
    'Quantity breaks go in increasing order, each once.',
  );

export const shopDefaultsSchema = z
  .object({
    shopName: name,
    unitSystem: z.enum(UNIT_SYSTEMS),
    currency: z.string().regex(/^[A-Z]{3}$/, 'A three-letter ISO 4217 code, e.g. USD.'),
    validityDays: z.number().int().min(0).max(3650),
    quoteTerms: z.string().max(20_000),
    defaultQuantityBreaks: quantityBreaksSchema,
    shopFixedCostPerJobUsd: amount,
    laborMarkup: positive,
    materialMarkup: positive,
    nreRatePerHrUsd: amount,
    nreMarkup: positive,
    minChargeStripIn: amount,
  })
  .strict() satisfies z.ZodType<ShopDefaults, z.ZodTypeDef, unknown>;

/** Module ids this build ships. A config naming one it does not is refused
 *  here rather than priced as though the module's cost were zero (§12 rule 3). */
export const enabledModulesSchema = z.array(z.string().min(1)).superRefine((modules, ctx) => {
  const known = defaultRegistry.ids();
  const seen = new Set<string>();
  modules.forEach((module, i) => {
    if (!known.includes(module)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [i],
        message: `This build has no cost module "${module}". It knows: ${known.join(', ')}.`,
      });
    }
    if (seen.has(module)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i], message: 'Listed twice.' });
    }
    seen.add(module);
  });
}) satisfies z.ZodType<ModuleId[], z.ZodTypeDef, unknown>;

/* -------------------------------------------------------------------------
   The whole config
   ------------------------------------------------------------------------- */

export const shopConfigSchema = z
  .object({
    schemaVersion: z.literal(1, {
      errorMap: () => ({ message: 'This build reads ShopConfig schemaVersion 1.' }),
    }),
    shopId: id,
    defaults: shopDefaultsSchema,
    families: z.array(materialFamilySchema),
    gauges: z.array(gaugeEntrySchema),
    materials: z.array(materialRowSchema),
    stockSizes: z.array(stockSizeSchema),
    machines: z.array(machineSchema),
    machineMaterialRates: z.array(machineMaterialRateSchema),
    operations: z.array(operationSchema),
    platingSpecs: z.array(platingSpecSchema),
    coatingModels: z.array(coatingModelSchema),
    silkscreenTiers: z.array(silkscreenTierSchema),
    assemblyStandards: z.array(assemblyStandardSchema),
    parity: parityFlagsSchema,
    enabledModules: enabledModulesSchema,
  })
  .strict()
  .superRefine((config, ctx) => checkConfig(config, ctx)) satisfies z.ZodType<
  ShopConfig,
  z.ZodTypeDef,
  unknown
>;

type Path = (string | number)[];

/** The cross-row rules: what `writeShopConfig()` and the database would
 *  otherwise discover one constraint violation at a time. */
function checkConfig(config: ShopConfig, ctx: z.RefinementCtx): void {
  const issue = (path: Path, message: string): void => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
  };

  // Ids are unique across the whole config, not per list: `writeShopConfig()`
  // keeps one id map for every entity.
  const claimed = new Map<string, string>();
  const claim = (entityId: string, path: Path): void => {
    const first = claimed.get(entityId);
    if (first === undefined) claimed.set(entityId, path.slice(0, -1).join('.'));
    else issue(path, `The id "${entityId}" is already used by ${first}.`);
  };
  const claimAll = (key: string, rows: readonly { id: string }[]): void =>
    rows.forEach((row, i) => claim(row.id, [key, i, 'id']));
  claimAll('families', config.families);
  claimAll('gauges', config.gauges);
  claimAll('materials', config.materials);
  claimAll('stockSizes', config.stockSizes);
  claimAll('machines', config.machines);
  config.machines.forEach((m, i) =>
    m.hitRates.forEach((h, j) => claim(h.id, ['machines', i, 'hitRates', j, 'id'])),
  );
  claimAll('operations', config.operations);
  claimAll('platingSpecs', config.platingSpecs);
  claimAll('coatingModels', config.coatingModels);
  claimAll('silkscreenTiers', config.silkscreenTiers);
  claimAll('assemblyStandards', config.assemblyStandards);

  // Every reference resolves inside this config.
  const familyIds = new Set(config.families.map((f) => f.id));
  const materialIds = new Set(config.materials.map((m) => m.id));
  const machineIds = new Set(config.machines.map((m) => m.id));
  const resolves = (known: Set<string>, ref: string | null, path: Path, noun: string): void => {
    if (ref !== null && !known.has(ref)) issue(path, `No ${noun} "${ref}" in this config.`);
  };
  config.gauges.forEach((g, i) =>
    resolves(familyIds, g.familyId, ['gauges', i, 'familyId'], 'material family'),
  );
  config.materials.forEach((m, i) =>
    resolves(familyIds, m.familyId, ['materials', i, 'familyId'], 'material family'),
  );
  config.stockSizes.forEach((s, i) => {
    resolves(materialIds, s.materialId, ['stockSizes', i, 'materialId'], 'material');
    resolves(familyIds, s.familyId, ['stockSizes', i, 'familyId'], 'material family');
  });
  const pairs = new Set<string>();
  config.machineMaterialRates.forEach((r, i) => {
    resolves(machineIds, r.machineId, ['machineMaterialRates', i, 'machineId'], 'machine');
    resolves(materialIds, r.materialId, ['machineMaterialRates', i, 'materialId'], 'material');
    const pair = `${r.machineId}|${r.materialId}`;
    if (pairs.has(pair)) {
      issue(['machineMaterialRates', i], 'This machine and material already have a rate row.');
    }
    pairs.add(pair);
  });
  config.operations.forEach((o, i) =>
    resolves(machineIds, o.machineId, ['operations', i, 'machineId'], 'machine'),
  );

  // Names are unique wherever the database holds them unique. Operations are
  // not: the workbook has two BRAKE, BEND rows at different standards.
  const uniqueNames = (key: string, rows: readonly { name: string }[], noun: string): void => {
    const seen = new Set<string>();
    rows.forEach((row, i) => {
      if (seen.has(row.name)) issue([key, i, 'name'], `Two ${noun}s are called "${row.name}".`);
      seen.add(row.name);
    });
  };
  uniqueNames('families', config.families, 'material family');
  uniqueNames('materials', config.materials, 'material');
  uniqueNames('machines', config.machines, 'machine');
  uniqueNames('platingSpecs', config.platingSpecs, 'plating spec');
  uniqueNames('coatingModels', config.coatingModels, 'coating model');
  uniqueNames('silkscreenTiers', config.silkscreenTiers, 'silkscreen tier');

  const gaugeLabels = new Set<string>();
  config.gauges.forEach((g, i) => {
    const key = `${g.familyId}|${g.label}`;
    if (gaugeLabels.has(key))
      issue(['gauges', i, 'label'], `This family already has "${g.label}".`);
    gaugeLabels.add(key);
  });

  // One alias, one target, per kind — or the intake resolver could not choose.
  const uniqueAliases = (key: string, rows: readonly { aliases: string[] }[]): void => {
    const seen = new Set<string>();
    rows.forEach((row, i) =>
      row.aliases.forEach((a, j) => {
        if (seen.has(a)) issue([key, i, 'aliases', j], `The alias "${a}" is claimed twice.`);
        seen.add(a);
      }),
    );
  };
  uniqueAliases('families', config.families);
  uniqueAliases('materials', config.materials);
  uniqueAliases('platingSpecs', config.platingSpecs);
}
