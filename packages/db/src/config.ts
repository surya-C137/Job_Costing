/**
 * Rows → `ShopConfig`, and quote snapshots.
 *
 * `loadShopConfig()` is the exact inverse of `write-config.ts`, and that is the
 * whole design: the catalog tables are the normalised form of `ShopConfig`, so
 * assembling one is a read and a reshape rather than a second opinion about
 * what the workbook meant. `test/golden.test.ts` prices the REQUIREMENTS §9
 * part through this path and gets the same six selling prices calc's own
 * golden test does — which is what proves seed, assembly and engine agree.
 *
 * **`asOf` is what makes re-pricing honest.** Prices are versioned (§7), so a
 * config is always a config *at a moment*: `loadShopConfig(db, shopId)` gives
 * today's rates, and `loadShopConfig(db, shopId, quote.quoteDate)` gives the
 * ones a quote was written against. Re-pricing is then an explicit act with an
 * explicit date, not an accident of when someone opened the file.
 *
 * Archived rows are left out everywhere. Soft delete (§7) means a material the
 * owner removed still exists for the quotes that used it — but it must not
 * appear in the catalog the estimator picks from today. Old quotes read their
 * frozen snapshot instead, which is what `saveSnapshot()` writes.
 */

import { createHash } from 'node:crypto';
import { and, eq, isNull, lte } from 'drizzle-orm';

import type {
  AssemblyStandard,
  CoatingModel,
  GaugeEntry,
  Machine,
  MachineMaterialRate,
  MaterialFamily,
  MaterialRow,
  Operation,
  PlatingSpec,
  PunchHitRate,
  QuoteInput,
  QuoteResult,
  ShopConfig,
  SilkscreenTier,
  StockSize,
} from '@shopquote/calc';
import { CALC_SCHEMA_VERSION } from '@shopquote/calc';

import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';

import type { DatabaseHandle, ShopQuoteDatabase } from './db.js';
import {
  assemblyStandards,
  coatingModels,
  configSnapshots,
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
  quoteVersions,
  quotes,
  shops,
  silkscreenTiers,
  stockSizes,
} from './schema.js';

/**
 * Assemble the engine's config for one shop, as it stood at `asOf`.
 *
 * Throws when the shop is not there: a missing shop is a wiring fault at
 * startup, not the kind of expected condition calc turns into a `Result`.
 * Everything *inside* the config that might be missing — a price, a machine
 * rate — is represented as missing and warned about at pricing time (§12
 * rule 3), never invented here.
 */
export function loadShopConfig(
  db: ShopQuoteDatabase,
  shopId: string,
  asOf: Date = new Date(),
): ShopConfig {
  const shop = db.select().from(shops).where(eq(shops.id, shopId)).get();
  if (shop === undefined) {
    throw new Error(`No shop ${shopId} in this database.`);
  }

  /** Every catalog read is "this shop's, not archived". Soft delete (§7) means
   *  a removed row still exists for the quotes that used it, but it must not
   *  appear in the catalog anyone picks from today. */
  const live = <S extends SQLiteColumn, A extends SQLiteColumn>(table: {
    shopId: S;
    archivedAt: A;
  }) => and(eq(table.shopId, shopId), isNull(table.archivedAt));

  const aliases = aliasIndex(db, shopId);

  const familyRows = db.select().from(materialFamilies).where(live(materialFamilies)).all();
  const families: MaterialFamily[] = familyRows
    .map((f) => ({
      id: f.id,
      name: f.name,
      densityLbPerCuIn: f.densityLbPerCuIn,
      defaultScrapPricePerLbUsd: f.defaultScrapPricePerLbUsd,
      aliases: aliases.get(f.id) ?? [],
    }))
    .sort(byName);

  const gauges: GaugeEntry[] = db
    .select()
    .from(gaugeReference)
    .where(live(gaugeReference))
    .all()
    .map((g) => ({
      id: g.id,
      familyId: g.familyId,
      label: g.label,
      thicknessIn: g.thicknessIn,
      lbPerSqFtOverride: g.lbPerSqFtOverride,
    }))
    .sort((a, b) => a.familyId.localeCompare(b.familyId) || a.thicknessIn - b.thicknessIn);

  const prices = effectivePrices(db, shopId, asOf);
  const materialRows = db.select().from(materials).where(live(materials)).all();
  const materialList: MaterialRow[] = materialRows
    .map((m) => {
      const price = prices.get(m.id);
      return {
        id: m.id,
        name: m.name,
        familyId: m.familyId,
        form: m.form,
        thicknessIn: m.thicknessIn,
        lbPerSqFt: m.lbPerSqFt,
        // No effective price version at `asOf` means this stock has no $/lb —
        // either the shop never priced it, or every version is dated later.
        // Null travels; the material module warns and refuses to cost the part.
        pricePerLbUsd: price?.pricePerLbUsd ?? null,
        surchargePct: m.surchargePct,
        scrapPricePerLbUsd: m.scrapPricePerLbUsd,
        standardLengthIn: m.standardLengthIn,
        aliases: aliases.get(m.id) ?? [],
        sheetCostUsd: price?.sheetCostUsd ?? null,
        sheetLbs: price?.sheetLbs ?? null,
        active: m.active,
      };
    })
    .sort(byName);

  const stockSizeList: StockSize[] = db
    .select()
    .from(stockSizes)
    .where(live(stockSizes))
    .all()
    .map((s) => ({
      id: s.id,
      materialId: s.materialId,
      familyId: s.familyId,
      lengthIn: s.lengthIn,
      widthIn: s.widthIn,
      preferred: s.preferred,
    }));

  const hitRatesByMachine = new Map<string, PunchHitRate[]>();
  for (const h of db.select().from(punchHitRates).where(live(punchHitRates)).all()) {
    const list = hitRatesByMachine.get(h.machineId) ?? [];
    list.push({ id: h.id, name: h.name, hitsPerHr: h.hitsPerHr, multiplier: h.multiplier });
    hitRatesByMachine.set(h.machineId, list);
  }

  const machineList: Machine[] = db
    .select()
    .from(machines)
    .where(live(machines))
    .all()
    .map((m) => ({
      id: m.id,
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
      hitRates: hitRatesByMachine.get(m.id) ?? [],
      active: m.active,
    }))
    .sort(byName);

  const rates: MachineMaterialRate[] = db
    .select()
    .from(machineMaterialRates)
    .where(live(machineMaterialRates))
    .all()
    .map((r) => ({
      machineId: r.machineId,
      materialId: r.materialId,
      cutSpeedInPerMin: r.cutSpeedInPerMin,
      pierceSeconds: r.pierceSeconds,
      punchRateFactor: r.punchRateFactor,
    }));

  const operationList: Operation[] = db
    .select()
    .from(operations)
    .where(live(operations))
    .all()
    .map((o) => ({
      id: o.id,
      name: o.name,
      machineId: o.machineId,
      kind: o.kind,
      setupHrs: o.setupHrs,
      standardPerHr: o.standardPerHr,
      standardUnit: o.standardUnit,
      ratePerHrUsd: o.ratePerHrUsd,
      active: o.active,
    }))
    .sort(
      (a, b) => a.name.localeCompare(b.name) || (a.standardPerHr ?? 0) - (b.standardPerHr ?? 0),
    );

  const plating: PlatingSpec[] = db
    .select()
    .from(platingSpecs)
    .where(live(platingSpecs))
    .all()
    .map((p) => ({
      id: p.id,
      name: p.name,
      aliases: aliases.get(p.id) ?? [],
      lotMinimumUsd: p.lotMinimumUsd,
      pricePerSqInUsd: p.pricePerSqInUsd,
      partMinimumUsd: p.partMinimumUsd,
      rohsCompliant: p.rohsCompliant,
      active: p.active,
    }))
    .sort(byName);

  const coating: CoatingModel[] = db
    .select()
    .from(coatingModels)
    .where(live(coatingModels))
    .all()
    .map((c) => ({
      id: c.id,
      name: c.name,
      minimumChargeUsd: c.minimumChargeUsd,
      // A model is configured for a parity path or it is not; a half-filled
      // group would price off whichever constants happened to be there. The
      // engine warns on null and prices nothing (§11.3 — never `else → 0`).
      legacy:
        c.legacyRateUsd === null || c.legacyCoverage === null || c.legacySConstant === null
          ? null
          : {
              rateUsd: c.legacyRateUsd,
              coverage: c.legacyCoverage,
              sConstant: c.legacySConstant,
            },
      modern:
        c.modernSpecificGravity === null ||
        c.modernFilmThicknessMils === null ||
        c.modernTransferEfficiency === null ||
        c.modernPowderPricePerLbUsd === null
          ? null
          : {
              specificGravity: c.modernSpecificGravity,
              filmThicknessMils: c.modernFilmThicknessMils,
              transferEfficiency: c.modernTransferEfficiency,
              powderPricePerLbUsd: c.modernPowderPricePerLbUsd,
              rackLaborUsdPerPart: c.modernRackLaborUsdPerPart ?? 0,
              maskingUsdPerFeature: c.modernMaskingUsdPerFeature ?? 0,
            },
    }))
    .sort(byName);

  const silkscreen: SilkscreenTier[] = db
    .select()
    .from(silkscreenTiers)
    .where(live(silkscreenTiers))
    .all()
    .map((s) => ({
      id: s.id,
      name: s.name,
      screenCostUsd: s.screenCostUsd,
      printCostUsd: s.printCostUsd,
      active: s.active,
    }))
    .sort(byName);

  const assembly: AssemblyStandard[] = db
    .select()
    .from(assemblyStandards)
    .where(live(assemblyStandards))
    .all()
    .map((a) => ({
      id: a.id,
      section: a.section,
      action: a.action,
      standardSeconds: a.standardSeconds,
    }));

  return {
    schemaVersion: CALC_SCHEMA_VERSION,
    shopId: shop.id,
    defaults: {
      shopName: shop.name,
      unitSystem: shop.unitSystem,
      currency: shop.currency,
      validityDays: shop.validityDays,
      quoteTerms: shop.quoteTerms,
      defaultQuantityBreaks: [...shop.defaultQuantityBreaks],
      shopFixedCostPerJobUsd: shop.shopFixedCostPerJobUsd,
      laborMarkup: shop.laborMarkup,
      materialMarkup: shop.materialMarkup,
      nreRatePerHrUsd: shop.nreRatePerHrUsd,
      nreMarkup: shop.nreMarkup,
      minChargeStripIn: shop.minChargeStripIn,
    },
    families,
    gauges,
    materials: materialList,
    stockSizes: stockSizeList,
    machines: machineList,
    machineMaterialRates: rates,
    operations: operationList,
    platingSpecs: plating,
    coatingModels: coating,
    silkscreenTiers: silkscreen,
    assemblyStandards: assembly,
    parity: {
      markupInsideMinChargeMax: shop.parityMarkupInsideMinChargeMax,
      machineTimeFactor: shop.parityMachineTimeFactor,
      legacyCoatingModel: shop.parityLegacyCoatingModel,
      finishesUnmarked: shop.parityFinishesUnmarked,
    },
    enabledModules: [...shop.enabledModules],
  };
}

/** Sort catalogs the way a picker shows them. Order does not affect pricing —
 *  the engine looks everything up by id — but a stable one makes an exported
 *  config diffable and a Settings table predictable. */
function byName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name);
}

/** Every alias, grouped by the row it points at (§8, §12). */
function aliasIndex(db: ShopQuoteDatabase, shopId: string): Map<string, string[]> {
  const index = new Map<string, string[]>();
  const rows = db
    .select()
    .from(intakeAliases)
    .where(and(eq(intakeAliases.shopId, shopId), isNull(intakeAliases.archivedAt)))
    .all();
  for (const row of rows) {
    if (row.targetId === null) continue;
    const list = index.get(row.targetId) ?? [];
    list.push(row.alias);
    index.set(row.targetId, list);
  }
  for (const list of index.values()) list.sort();
  return index;
}

interface EffectivePrice {
  pricePerLbUsd: number;
  sheetCostUsd: number | null;
  sheetLbs: number | null;
  effectiveFrom: Date;
}

/**
 * The price version in force at `asOf`, per material (§7).
 *
 * Ties break on the row written last, which is what an owner correcting a
 * typo the same afternoon expects. A material with no row on or before `asOf`
 * is simply absent from the map.
 */
function effectivePrices(
  db: ShopQuoteDatabase,
  shopId: string,
  asOf: Date,
): Map<string, EffectivePrice> {
  const rows = db
    .select()
    .from(materialPrices)
    .where(
      and(
        eq(materialPrices.shopId, shopId),
        isNull(materialPrices.archivedAt),
        lte(materialPrices.effectiveFrom, asOf),
      ),
    )
    .all();

  const best = new Map<string, EffectivePrice & { createdAt: Date }>();
  for (const row of rows) {
    const current = best.get(row.materialId);
    const newer =
      current === undefined ||
      row.effectiveFrom.getTime() > current.effectiveFrom.getTime() ||
      (row.effectiveFrom.getTime() === current.effectiveFrom.getTime() &&
        row.createdAt.getTime() >= current.createdAt.getTime());
    if (newer) {
      best.set(row.materialId, {
        pricePerLbUsd: row.pricePerLbUsd,
        sheetCostUsd: row.sheetCostUsd,
        sheetLbs: row.sheetLbs,
        effectiveFrom: row.effectiveFrom,
        createdAt: row.createdAt,
      });
    }
  }
  return best;
}

/* =========================================================================
   Snapshots
   ========================================================================= */

/** JSON with object keys in a fixed order, so the same config hashes the same
 *  however it was assembled. Arrays keep their order — it is data. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(',')}}`;
}

/** Content address for a config. Identity, not integrity — it is what lets a
 *  day of autosaves share one stored snapshot. */
export function configHash(config: ShopConfig): string {
  return createHash('sha256').update(canonicalJson(config)).digest('hex');
}

export interface SaveSnapshotArgs {
  quoteId: string;
  /** The config the quote was priced with — frozen here (§7). */
  config: ShopConfig;
  /** What the estimator entered. */
  input: QuoteInput;
  /** What `computeQuote()` returned for it. */
  result: QuoteResult;
  /** Why this version exists. Defaults to an ordinary save. */
  reason?: 'save' | 'reprice' | 'copy';
  createdByUserId?: string;
}

export interface SaveSnapshotResult {
  versionId: string;
  /** 1 for the first save of a quote, then up. */
  versionNo: number;
  configSnapshotId: string;
  configHash: string;
  /** False when this config had not been stored before. A day of editing with
   *  Settings untouched reuses one row; changing a rate writes the next. */
  reusedSnapshot: boolean;
}

/**
 * Freeze one save of a quote: the inputs, the result, and the config it was
 * priced with (§7).
 *
 * The config is stored once per distinct config and referenced by hash. §4
 * FR-2 makes every autosave a version, and a `ShopConfig` carrying a whole
 * catalog is ~100 KB of JSON — copying it per version would put tens of
 * megabytes a day into a file whose backup story is "copy it", and every copy
 * would be identical, because Settings changes a few times a year while
 * autosave fires every few seconds.
 *
 * One transaction, so a version can never point at a snapshot that is not
 * there, and `quotes.current_version_no` can never disagree with the versions
 * that exist.
 */
export function saveSnapshot(handle: DatabaseHandle, args: SaveSnapshotArgs): SaveSnapshotResult {
  const { db } = handle;

  return handle.sqlite.transaction(() => {
    const quote = db
      .select({ id: quotes.id, shopId: quotes.shopId, currentVersionNo: quotes.currentVersionNo })
      .from(quotes)
      .where(eq(quotes.id, args.quoteId))
      .get();
    if (quote === undefined) {
      throw new Error(`No quote ${args.quoteId}: a snapshot has to belong to something.`);
    }

    const hash = configHash(args.config);
    const existing = db
      .select({ id: configSnapshots.id })
      .from(configSnapshots)
      .where(and(eq(configSnapshots.shopId, quote.shopId), eq(configSnapshots.hash, hash)))
      .get();

    let snapshotId = existing?.id;
    if (snapshotId === undefined) {
      snapshotId = db
        .insert(configSnapshots)
        .values({
          shopId: quote.shopId,
          hash,
          schemaVersion: args.config.schemaVersion,
          config: args.config,
        })
        .returning({ id: configSnapshots.id })
        .get().id;
    }

    const versionNo = quote.currentVersionNo + 1;
    const version = db
      .insert(quoteVersions)
      .values({
        shopId: quote.shopId,
        quoteId: quote.id,
        versionNo,
        configSnapshotId: snapshotId,
        input: args.input,
        result: args.result,
        reason: args.reason ?? 'save',
        ...(args.createdByUserId === undefined ? {} : { createdByUserId: args.createdByUserId }),
      })
      .returning({ id: quoteVersions.id })
      .get();

    db.update(quotes).set({ currentVersionNo: versionNo }).where(eq(quotes.id, quote.id)).run();

    return {
      versionId: version.id,
      versionNo,
      configSnapshotId: snapshotId,
      configHash: hash,
      reusedSnapshot: existing !== undefined,
    };
  })();
}

export interface LoadedSnapshot {
  versionId: string;
  versionNo: number;
  reason: 'save' | 'reprice' | 'copy';
  createdAt: Date;
  config: ShopConfig;
  input: QuoteInput;
  result: QuoteResult;
}

/**
 * Read a frozen version back — the newest by default, or one by number.
 *
 * This is what re-opening an old quote uses. A quote priced in March shows
 * March's rates and March's price, whatever Settings says today; §7's "re-
 * pricing is explicit" is only true if the old numbers are still reachable.
 */
export function loadSnapshot(
  db: ShopQuoteDatabase,
  quoteId: string,
  versionNo?: number,
): LoadedSnapshot | undefined {
  const rows = db
    .select()
    .from(quoteVersions)
    .innerJoin(configSnapshots, eq(quoteVersions.configSnapshotId, configSnapshots.id))
    .where(
      versionNo === undefined
        ? eq(quoteVersions.quoteId, quoteId)
        : and(eq(quoteVersions.quoteId, quoteId), eq(quoteVersions.versionNo, versionNo)),
    )
    .all();

  let newest: (typeof rows)[number] | undefined;
  for (const row of rows) {
    if (newest === undefined || row.quote_versions.versionNo > newest.quote_versions.versionNo) {
      newest = row;
    }
  }
  if (newest === undefined) return undefined;

  return {
    versionId: newest.quote_versions.id,
    versionNo: newest.quote_versions.versionNo,
    reason: newest.quote_versions.reason,
    createdAt: newest.quote_versions.createdAt,
    config: newest.config_snapshots.config,
    input: newest.quote_versions.input,
    result: newest.quote_versions.result,
  };
}
