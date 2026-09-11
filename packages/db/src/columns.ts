/**
 * Entity → columns, for every catalog entity, in one place.
 *
 * Two writers turn calc's entities into rows: `writeShopConfig()` for a whole
 * config, and `catalog.ts` for one row from a Settings form. They share these
 * mappers, so a field added to `MaterialRow` is stored the same way by both —
 * or, if someone forgets it, forgotten by both, which the round-trip test in
 * `config.test.ts` then catches.
 *
 * `ref` translates a config id into a stored one. `writeShopConfig()` passes
 * its id map; a single-row write passes stored ids straight through
 * (`sameId`), having already checked that they are live.
 */

import type {
  AssemblyStandard,
  CoatingModel,
  GaugeEntry,
  Machine,
  MaterialFamily,
  MaterialRow,
  ModuleId,
  Operation,
  ParityFlags,
  PlatingSpec,
  PunchHitRate,
  ShopDefaults,
  SilkscreenTier,
  StockSize,
} from '@shopquote/calc';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';

/** The columns every soft-deletable catalog table shares. */
export type CatalogTable = SQLiteTable & {
  id: SQLiteColumn;
  shopId: SQLiteColumn;
  archivedAt: SQLiteColumn;
};

export type Ref = (id: string) => string;

/** For a write whose ids are stored ids already. */
export const sameId: Ref = (id) => id;

/** The `shops` row: `ShopDefaults`, the four parity flags, the module list. */
export function shopSettingsColumns(
  defaults: ShopDefaults,
  parity: ParityFlags,
  enabledModules: readonly ModuleId[],
) {
  return {
    name: defaults.shopName,
    unitSystem: defaults.unitSystem,
    currency: defaults.currency,
    validityDays: defaults.validityDays,
    quoteTerms: defaults.quoteTerms,
    defaultQuantityBreaks: [...defaults.defaultQuantityBreaks],
    shopFixedCostPerJobUsd: defaults.shopFixedCostPerJobUsd,
    laborMarkup: defaults.laborMarkup,
    materialMarkup: defaults.materialMarkup,
    nreRatePerHrUsd: defaults.nreRatePerHrUsd,
    nreMarkup: defaults.nreMarkup,
    minChargeStripIn: defaults.minChargeStripIn,
    parityMarkupInsideMinChargeMax: parity.markupInsideMinChargeMax,
    parityMachineTimeFactor: parity.machineTimeFactor,
    parityLegacyCoatingModel: parity.legacyCoatingModel,
    parityFinishesUnmarked: parity.finishesUnmarked,
    enabledModules: [...enabledModules],
  };
}

export function familyColumns(f: Omit<MaterialFamily, 'id' | 'aliases'>) {
  return {
    name: f.name,
    densityLbPerCuIn: f.densityLbPerCuIn,
    defaultScrapPricePerLbUsd: f.defaultScrapPricePerLbUsd,
  };
}

export function gaugeColumns(g: Omit<GaugeEntry, 'id'>, ref: Ref) {
  return {
    familyId: ref(g.familyId),
    label: g.label,
    thicknessIn: g.thicknessIn,
    lbPerSqFtOverride: g.lbPerSqFtOverride,
  };
}

/** No price: $/lb is versioned in `material_prices` (§7). No aliases: those
 *  are rows of `intake_aliases`. */
export function materialColumns(
  m: Omit<MaterialRow, 'id' | 'aliases' | 'pricePerLbUsd' | 'sheetCostUsd' | 'sheetLbs'>,
  ref: Ref,
) {
  return {
    name: m.name,
    familyId: ref(m.familyId),
    form: m.form,
    thicknessIn: m.thicknessIn,
    lbPerSqFt: m.lbPerSqFt,
    surchargePct: m.surchargePct,
    scrapPricePerLbUsd: m.scrapPricePerLbUsd,
    standardLengthIn: m.standardLengthIn,
    active: m.active,
  };
}

export function stockSizeColumns(s: Omit<StockSize, 'id'>, ref: Ref) {
  return {
    materialId: s.materialId === null ? null : ref(s.materialId),
    familyId: s.familyId === null ? null : ref(s.familyId),
    lengthIn: s.lengthIn,
    widthIn: s.widthIn,
    preferred: s.preferred,
  };
}

export function machineColumns(m: Omit<Machine, 'id' | 'hitRates'>) {
  return {
    name: m.name,
    kind: m.kind,
    timeModel: m.timeModel,
    ratePerHrUsd: m.ratePerHrUsd,
    setupHrsDefault: m.setupHrsDefault,
    consumablesPerHrUsd: m.consumablesPerHrUsd,
    maxSheetLengthIn: m.maxSheetLengthIn,
    maxSheetWidthIn: m.maxSheetWidthIn,
    clampStripIn: m.clampStripIn,
    kerfIn: m.kerfIn,
    palletChangeSec: m.palletChangeSec,
    palletBatchParts: m.palletBatchParts,
    intersectionSec: m.intersectionSec,
    rapidSecPerPierce: m.rapidSecPerPierce,
    lossFactor: m.lossFactor,
    loadUnloadSecPerBlank: m.loadUnloadSecPerBlank,
    active: m.active,
  };
}

export function hitRateColumns(h: Omit<PunchHitRate, 'id'>) {
  return { name: h.name, hitsPerHr: h.hitsPerHr, multiplier: h.multiplier };
}

export function operationColumns(o: Omit<Operation, 'id'>, ref: Ref) {
  return {
    name: o.name,
    machineId: o.machineId === null ? null : ref(o.machineId),
    kind: o.kind,
    setupHrs: o.setupHrs,
    standardPerHr: o.standardPerHr,
    standardUnit: o.standardUnit,
    ratePerHrUsd: o.ratePerHrUsd,
    active: o.active,
  };
}

export function platingColumns(p: Omit<PlatingSpec, 'id' | 'aliases'>) {
  return {
    name: p.name,
    lotMinimumUsd: p.lotMinimumUsd,
    pricePerSqInUsd: p.pricePerSqInUsd,
    partMinimumUsd: p.partMinimumUsd,
    rohsCompliant: p.rohsCompliant,
    active: p.active,
  };
}

/** Both model groups, all-or-nothing: `loadShopConfig()` reads a group back
 *  only when every column in it is set. */
export function coatingColumns(c: Omit<CoatingModel, 'id'>) {
  return {
    name: c.name,
    minimumChargeUsd: c.minimumChargeUsd,
    legacyRateUsd: c.legacy?.rateUsd ?? null,
    legacyCoverage: c.legacy?.coverage ?? null,
    legacySConstant: c.legacy?.sConstant ?? null,
    modernSpecificGravity: c.modern?.specificGravity ?? null,
    modernFilmThicknessMils: c.modern?.filmThicknessMils ?? null,
    modernTransferEfficiency: c.modern?.transferEfficiency ?? null,
    modernPowderPricePerLbUsd: c.modern?.powderPricePerLbUsd ?? null,
    modernRackLaborUsdPerPart: c.modern?.rackLaborUsdPerPart ?? null,
    modernMaskingUsdPerFeature: c.modern?.maskingUsdPerFeature ?? null,
  };
}

export function silkscreenColumns(s: Omit<SilkscreenTier, 'id'>) {
  return {
    name: s.name,
    screenCostUsd: s.screenCostUsd,
    printCostUsd: s.printCostUsd,
    active: s.active,
  };
}

export function assemblyColumns(a: Omit<AssemblyStandard, 'id'>) {
  return { section: a.section, action: a.action, standardSeconds: a.standardSeconds };
}
