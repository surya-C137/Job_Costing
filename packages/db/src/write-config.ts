/**
 * `ShopConfig` → rows.
 *
 * This is the seed loader's real body, and it is deliberately not a
 * seed-JSON-to-SQL mapping. The seed files become a `ShopConfig` exactly once,
 * in calc's `shopConfigFromSeed()` — the same call the golden test makes with
 * no database in sight — and only then does anything get written. Two
 * consequences worth stating:
 *
 *   1. There is one mapping from the workbook's shape to the app's, not two,
 *      so the database cannot drift away from what the golden test proves.
 *   2. Task 2.2's `loadShopConfig()` is this function's inverse, which makes
 *      the round trip testable: seed a config, load it back, price §9 through
 *      it, get the same six numbers.
 *
 * It is also how a shop is created from an imported config JSON (§4 FR-1) —
 * same function, different source.
 *
 * **Ids are re-issued.** A `ShopConfig` from the seed carries slugs
 * (`material:g30-16-ga-0598`); §7 says stored ids are ULIDs. So every entity
 * gets a fresh ULID, the old id is kept in `source_key` for provenance, and
 * the returned map translates one to the other for anything that has to
 * follow a reference (a `PartInput`, an import).
 */

import { ulid } from 'ulid';

import type { MaterialRow, ShopConfig } from '@shopquote/calc';

import type { DatabaseHandle } from './db.js';
import {
  assemblyStandards,
  coatingModels,
  gaugeReference,
  intakeAliases,
  machineMaterialRates,
  machines,
  materialFamilies,
  materialPrices,
  materials,
  operations,
  platingSpecs,
  punchHitRates,
  shops,
  silkscreenTiers,
  stockSizes,
} from './schema.js';

export interface WriteConfigOptions {
  /** The shop's ULID. Generated when absent. */
  shopId?: string;
  /** Effective date for the material prices this config carries. The seed uses
   *  the workbook's own vintage rather than "now", because that is what the
   *  prices are (§6: "Prices are 2023-era"). */
  pricesEffectiveFrom: Date;
  /** Goes on every price row, e.g. "Seeded from Quote_Metal_Cost.xls". */
  priceNote?: string;
  /** Who entered the prices. Null for a seed: nobody typed them. */
  enteredByUserId?: string;
}

export interface WriteConfigResult {
  shopId: string;
  /** `ShopConfig` id → stored ULID, for every entity written. */
  ids: Map<string, string>;
  /** Rows written, by table, for the seed's summary output. */
  counts: Record<string, number>;
}

/** SQLite takes 32 766 bound parameters per statement; a wide table at 500
 *  rows would pass it. Chunking is cheaper than counting columns. */
const CHUNK = 200;

function insertMany<T>(rows: T[], insert: (chunk: T[]) => void): number {
  for (let i = 0; i < rows.length; i += CHUNK) {
    insert(rows.slice(i, i + CHUNK));
  }
  return rows.length;
}

/**
 * Write a whole `ShopConfig` as a new shop. One transaction: a half-written
 * catalog is worse than no catalog.
 */
export function writeShopConfig(
  handle: DatabaseHandle,
  config: ShopConfig,
  options: WriteConfigOptions,
): WriteConfigResult {
  const { db } = handle;
  const shopId = options.shopId ?? ulid();
  const ids = new Map<string, string>();
  const counts: Record<string, number> = {};

  /**
   * Issue a ULID for a config id and remember the pairing.
   *
   * A repeat is a defect in the config, not something to absorb: two entities
   * sharing an id means one of them is unreachable by reference and only one
   * row would be written. It surfaces here rather than as a primary-key
   * violation three tables later. (The seed hit exactly this — the workbook's
   * assembly sheet lists an action twice, which slugged to one key; the fix
   * was in the extractor, where duplicate operation names were already being
   * disambiguated.)
   */
  const idFor = (configId: string): string => {
    if (ids.has(configId)) {
      throw new Error(
        `Two entities in this ShopConfig share the id "${configId}". ` +
          `Ids must be unique across the config; fix the source that generated it.`,
      );
    }
    const fresh = ulid();
    ids.set(configId, fresh);
    return fresh;
  };

  /** Follow a reference to an entity written earlier in this run. */
  const ref = (configId: string): string => {
    const mapped = ids.get(configId);
    if (mapped === undefined) {
      throw new Error(
        `Config references "${configId}", which is not in this ShopConfig. ` +
          `Every id a material, machine or operation points at must exist before it can be stored.`,
      );
    }
    return mapped;
  };

  handle.sqlite.transaction(() => {
    const d = config.defaults;
    db.insert(shops)
      .values({
        id: shopId,
        name: d.shopName,
        unitSystem: d.unitSystem,
        currency: d.currency,
        validityDays: d.validityDays,
        quoteTerms: d.quoteTerms,
        defaultQuantityBreaks: [...d.defaultQuantityBreaks],
        shopFixedCostPerJobUsd: d.shopFixedCostPerJobUsd,
        laborMarkup: d.laborMarkup,
        materialMarkup: d.materialMarkup,
        nreRatePerHrUsd: d.nreRatePerHrUsd,
        nreMarkup: d.nreMarkup,
        minChargeStripIn: d.minChargeStripIn,
        parityMarkupInsideMinChargeMax: config.parity.markupInsideMinChargeMax,
        parityMachineTimeFactor: config.parity.machineTimeFactor,
        parityLegacyCoatingModel: config.parity.legacyCoatingModel,
        parityFinishesUnmarked: config.parity.finishesUnmarked,
        enabledModules: [...config.enabledModules],
        calcSchemaVersion: config.schemaVersion,
      })
      .run();
    counts['shops'] = 1;

    /* ---- material catalog ------------------------------------------- */

    counts['material_families'] = insertMany(
      config.families.map((f) => ({
        id: idFor(f.id),
        shopId,
        sourceKey: f.id,
        name: f.name,
        densityLbPerCuIn: f.densityLbPerCuIn,
        defaultScrapPricePerLbUsd: f.defaultScrapPricePerLbUsd,
      })),
      (chunk) => db.insert(materialFamilies).values(chunk).run(),
    );

    counts['gauge_reference'] = insertMany(
      config.gauges.map((g) => ({
        id: idFor(g.id),
        shopId,
        sourceKey: g.id,
        familyId: ref(g.familyId),
        label: g.label,
        thicknessIn: g.thicknessIn,
        lbPerSqFtOverride: g.lbPerSqFtOverride,
      })),
      (chunk) => db.insert(gaugeReference).values(chunk).run(),
    );

    counts['materials'] = insertMany(
      config.materials.map((m) => ({
        id: idFor(m.id),
        shopId,
        sourceKey: m.id,
        name: m.name,
        familyId: ref(m.familyId),
        form: m.form,
        thicknessIn: m.thicknessIn,
        lbPerSqFt: m.lbPerSqFt,
        surchargePct: m.surchargePct,
        scrapPricePerLbUsd: m.scrapPricePerLbUsd,
        standardLengthIn: m.standardLengthIn,
        active: m.active,
      })),
      (chunk) => db.insert(materials).values(chunk).run(),
    );

    // One price version per *priced* material. §7: a price change is a new row,
    // so this is version one of the history rather than a column on the
    // material. A material the shop stocks but has never priced simply has no
    // price row — which is how `loadShopConfig()` reads the null back, and how
    // the estimator ends up warned rather than quoted free steel (§12 rule 3).
    counts['material_prices'] = insertMany(
      config.materials
        .filter((m): m is MaterialRow & { pricePerLbUsd: number } => m.pricePerLbUsd !== null)
        .map((m) => ({
          id: ulid(),
          shopId,
          materialId: ref(m.id),
          pricePerLbUsd: m.pricePerLbUsd,
          sheetCostUsd: m.sheetCostUsd,
          sheetLbs: m.sheetLbs,
          effectiveFrom: options.pricesEffectiveFrom,
          ...(options.enteredByUserId === undefined
            ? {}
            : { enteredByUserId: options.enteredByUserId }),
          ...(options.priceNote === undefined ? {} : { note: options.priceNote }),
        })),
      (chunk) => db.insert(materialPrices).values(chunk).run(),
    );

    counts['stock_sizes'] = insertMany(
      config.stockSizes.map((s) => ({
        id: idFor(s.id),
        shopId,
        sourceKey: s.id,
        materialId: s.materialId === null ? null : ref(s.materialId),
        familyId: s.familyId === null ? null : ref(s.familyId),
        lengthIn: s.lengthIn,
        widthIn: s.widthIn,
        preferred: s.preferred,
      })),
      (chunk) => db.insert(stockSizes).values(chunk).run(),
    );

    /* ---- work centres ------------------------------------------------ */

    counts['machines'] = insertMany(
      config.machines.map((m) => ({
        id: idFor(m.id),
        shopId,
        sourceKey: m.id,
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
      })),
      (chunk) => db.insert(machines).values(chunk).run(),
    );

    counts['punch_hit_rates'] = insertMany(
      config.machines.flatMap((m) =>
        m.hitRates.map((h) => ({
          id: idFor(h.id),
          shopId,
          sourceKey: h.id,
          machineId: ref(m.id),
          name: h.name,
          hitsPerHr: h.hitsPerHr,
          multiplier: h.multiplier,
        })),
      ),
      (chunk) => db.insert(punchHitRates).values(chunk).run(),
    );

    counts['machine_material_rates'] = insertMany(
      config.machineMaterialRates.map((r) => ({
        id: ulid(),
        shopId,
        machineId: ref(r.machineId),
        materialId: ref(r.materialId),
        cutSpeedInPerMin: r.cutSpeedInPerMin,
        pierceSeconds: r.pierceSeconds,
        punchRateFactor: r.punchRateFactor,
      })),
      (chunk) => db.insert(machineMaterialRates).values(chunk).run(),
    );

    counts['operations'] = insertMany(
      config.operations.map((o) => ({
        id: idFor(o.id),
        shopId,
        sourceKey: o.id,
        name: o.name,
        machineId: o.machineId === null ? null : ref(o.machineId),
        kind: o.kind,
        setupHrs: o.setupHrs,
        standardPerHr: o.standardPerHr,
        standardUnit: o.standardUnit,
        ratePerHrUsd: o.ratePerHrUsd,
        active: o.active,
      })),
      (chunk) => db.insert(operations).values(chunk).run(),
    );

    /* ---- finishing --------------------------------------------------- */

    counts['plating_specs'] = insertMany(
      config.platingSpecs.map((p) => ({
        id: idFor(p.id),
        shopId,
        sourceKey: p.id,
        name: p.name,
        lotMinimumUsd: p.lotMinimumUsd,
        pricePerSqInUsd: p.pricePerSqInUsd,
        partMinimumUsd: p.partMinimumUsd,
        rohsCompliant: p.rohsCompliant,
        active: p.active,
      })),
      (chunk) => db.insert(platingSpecs).values(chunk).run(),
    );

    counts['coating_models'] = insertMany(
      config.coatingModels.map((c) => ({
        id: idFor(c.id),
        shopId,
        sourceKey: c.id,
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
      })),
      (chunk) => db.insert(coatingModels).values(chunk).run(),
    );

    counts['silkscreen_tiers'] = insertMany(
      config.silkscreenTiers.map((s) => ({
        id: idFor(s.id),
        shopId,
        sourceKey: s.id,
        name: s.name,
        screenCostUsd: s.screenCostUsd,
        printCostUsd: s.printCostUsd,
        active: s.active,
      })),
      (chunk) => db.insert(silkscreenTiers).values(chunk).run(),
    );

    counts['assembly_standards'] = insertMany(
      config.assemblyStandards.map((a) => ({
        id: idFor(a.id),
        shopId,
        sourceKey: a.id,
        section: a.section,
        action: a.action,
        standardSeconds: a.standardSeconds,
      })),
      (chunk) => db.insert(assemblyStandards).values(chunk).run(),
    );

    /* ---- intake aliases ---------------------------------------------- */

    // Aliases are a table rather than a JSON column (§12), so the three places
    // a `ShopConfig` carries them are flattened into one list here and grouped
    // back on the way out.
    const aliasRows = [
      ...config.families.flatMap((f) =>
        f.aliases.map((alias) => ({ kind: 'family' as const, targetId: ref(f.id), alias })),
      ),
      ...config.materials.flatMap((m) =>
        m.aliases.map((alias) => ({ kind: 'material' as const, targetId: ref(m.id), alias })),
      ),
      ...config.platingSpecs.flatMap((p) =>
        p.aliases.map((alias) => ({ kind: 'plating' as const, targetId: ref(p.id), alias })),
      ),
    ];
    counts['intake_aliases'] = insertMany(
      aliasRows.map((a) => ({ id: ulid(), shopId, ...a })),
      (chunk) => db.insert(intakeAliases).values(chunk).run(),
    );
  })();

  return { shopId, ids, counts };
}
