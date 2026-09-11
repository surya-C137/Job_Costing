/**
 * Settings writes, one row at a time (§4 FR-1): the shop's own numbers, and
 * the catalogs an owner edits from a form — materials and their prices,
 * operations, plating, coating, silkscreen, assembly standards.
 *
 * Every function here:
 *
 *   - takes the calc entity's own shape, less what the database issues, so
 *     the API, the Settings screens and an exported config speak one language;
 *   - checks that each reference is a live row of *this* shop;
 *   - answers with the entity as `loadShopConfig()` now sees it — the one
 *     authority on what a stored row means — rather than echoing its input;
 *   - writes its audit entry in its own transaction (`audit.ts`).
 *
 * **A price is never edited.** §7 versions them: `addMaterialPrice()` inserts,
 * and nothing in this package updates or deletes a `material_prices` row.
 *
 * **Archiving** (§7 soft delete) takes with it the rows that mean nothing
 * without their parent — a material's machine rates and stock sizes, anything's
 * aliases — so the name and the aliases are free to use again at once.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { ulid } from 'ulid';

import type {
  AssemblyStandard,
  CoatingModel,
  MaterialRow,
  ModuleId,
  Operation,
  ParityFlags,
  PlatingSpec,
  ShopConfig,
  ShopDefaults,
  SilkscreenTier,
} from '@shopquote/calc';

import { describeChanges, recordAudit, summarizeChanges, type Actor } from './audit.js';
import {
  assemblyColumns,
  coatingColumns,
  materialColumns,
  operationColumns,
  platingColumns,
  sameId,
  shopSettingsColumns,
  silkscreenColumns,
  type CatalogTable,
} from './columns.js';
import { loadPriceHistory, loadShopConfig, toPriceVersion, type PriceVersion } from './config.js';
import type { DatabaseHandle, ShopQuoteDatabase } from './db.js';
import { DataError } from './errors.js';
import {
  assemblyStandards,
  coatingModels,
  intakeAliases,
  machineMaterialRates,
  machines,
  materialFamilies,
  materialPrices,
  materials,
  operations,
  platingSpecs,
  shops,
  silkscreenTiers,
  stockSizes,
} from './schema.js';

/** A material as a form edits it. No price: that is `addMaterialPrice()`. */
export type MaterialInput = Omit<MaterialRow, 'id' | 'pricePerLbUsd' | 'sheetCostUsd' | 'sheetLbs'>;
export type OperationInput = Omit<Operation, 'id'>;
export type PlatingSpecInput = Omit<PlatingSpec, 'id'>;
export type CoatingModelInput = Omit<CoatingModel, 'id'>;
export type SilkscreenTierInput = Omit<SilkscreenTier, 'id'>;
export type AssemblyStandardInput = Omit<AssemblyStandard, 'id'>;

/** A new price version (§7). */
export interface PriceInput {
  pricePerLbUsd: number;
  /** What a sheet cost and what it weighed: how the owner arrived at the
   *  price (§11.2). Provenance for this version, not a property of the stock. */
  sheetCostUsd: number | null;
  sheetLbs: number | null;
  /** May be in the future — a supplier's announced increase. */
  effectiveFrom: Date;
  note: string | null;
}

/** The parts of a `ShopConfig` that live on the shop row. */
export interface ShopSettings {
  defaults: ShopDefaults;
  parity: ParityFlags;
  enabledModules: ModuleId[];
}

export function shopSettingsOf(config: ShopConfig): ShopSettings {
  return {
    defaults: config.defaults,
    parity: config.parity,
    enabledModules: config.enabledModules,
  };
}

/**
 * The Settings "Shop" page: name, units, markups, breaks, the parity flags,
 * the modules switched on. The catalogs are not here; each has its own writes,
 * so saving the shop page from a stale tab cannot undo a material someone
 * added in another.
 */
export function updateShopSettings(
  handle: DatabaseHandle,
  shopId: string,
  settings: ShopSettings,
  actor: Actor,
): ShopConfig {
  return handle.sqlite.transaction(() => {
    const { db } = handle;
    const before = shopSettingsOf(loadShopConfig(db, shopId));
    db.update(shops)
      .set(shopSettingsColumns(settings.defaults, settings.parity, settings.enabledModules))
      .where(eq(shops.id, shopId))
      .run();
    const config = loadShopConfig(db, shopId);
    const after = shopSettingsOf(config);
    const changed = describeChanges(before, after);

    recordAudit(db, {
      shopId,
      actorUserId: actor.userId,
      action: 'config.update',
      entityTable: 'shops',
      entityId: shopId,
      summary:
        changed.length === 0
          ? 'Saved shop settings; nothing changed'
          : `Changed ${summarizeChanges(changed)}`,
      before,
      after,
    });
    return config;
  })();
}

/* =========================================================================
   One catalog, described once
   ========================================================================= */

type AliasKind = 'family' | 'material' | 'plating';

interface Resource<I, E extends I & { id: string }> {
  /** For messages: "material", "plating spec". */
  noun: string;
  /** Audit verb prefix: `material` → `material.create`. */
  action: string;
  table: CatalogTable;
  tableName: string;
  pick: (config: ShopConfig) => readonly E[];
  columns: (input: I) => Record<string, unknown>;
  /** What a person calls this row. */
  label: (input: I) => string;
  checkReferences?: (db: ShopQuoteDatabase, shopId: string, input: I) => void;
  aliases?: { kind: AliasKind; of: (input: I) => readonly string[] };
  /** Archive the rows that mean nothing once this one is gone. */
  cascade?: (db: ShopQuoteDatabase, id: string, at: Date) => void;
}

/*
 * The `as never` casts below are Drizzle being unable to type a write to "some
 * catalog table". Every value written was built by that table's own mapper in
 * `columns.ts`.
 */

function createRow<I, E extends I & { id: string }>(
  r: Resource<I, E>,
  handle: DatabaseHandle,
  shopId: string,
  input: I,
  actor: Actor,
  alsoWrite?: (db: ShopQuoteDatabase, id: string) => void,
): E {
  return handle.sqlite.transaction(() => {
    const { db } = handle;
    r.checkReferences?.(db, shopId, input);
    const id = ulid();
    uniquely(r, input, () =>
      db
        .insert(r.table)
        .values({ id, shopId, ...r.columns(input) } as never)
        .run(),
    );
    if (r.aliases !== undefined)
      replaceAliases(db, shopId, r.aliases.kind, id, r.aliases.of(input));
    alsoWrite?.(db, id);

    const created = findLive(r, db, shopId, id);
    recordAudit(db, {
      shopId,
      actorUserId: actor.userId,
      action: `${r.action}.create`,
      entityTable: r.tableName,
      entityId: id,
      summary: `Added ${r.noun} "${r.label(created)}"`,
      after: created,
    });
    return created;
  })();
}

function updateRow<I, E extends I & { id: string }>(
  r: Resource<I, E>,
  handle: DatabaseHandle,
  shopId: string,
  id: string,
  input: I,
  actor: Actor,
): E {
  return handle.sqlite.transaction(() => {
    const { db } = handle;
    const before = findLive(r, db, shopId, id);
    r.checkReferences?.(db, shopId, input);
    uniquely(r, input, () =>
      db
        .update(r.table)
        .set(r.columns(input) as never)
        .where(eq(r.table.id, id))
        .run(),
    );
    if (r.aliases !== undefined)
      replaceAliases(db, shopId, r.aliases.kind, id, r.aliases.of(input));

    const after = findLive(r, db, shopId, id);
    const changed = describeChanges(before, after);
    recordAudit(db, {
      shopId,
      actorUserId: actor.userId,
      action: `${r.action}.update`,
      entityTable: r.tableName,
      entityId: id,
      summary:
        changed.length === 0
          ? `Saved ${r.noun} "${r.label(after)}"; nothing changed`
          : `Updated ${r.noun} "${r.label(after)}": ${summarizeChanges(changed)}`,
      before,
      after,
    });
    return after;
  })();
}

function archiveRow<I, E extends I & { id: string }>(
  r: Resource<I, E>,
  handle: DatabaseHandle,
  shopId: string,
  id: string,
  actor: Actor,
): void {
  handle.sqlite.transaction(() => {
    const { db } = handle;
    const before = findLive(r, db, shopId, id);
    const at = new Date();
    db.update(r.table)
      .set({ archivedAt: at } as never)
      .where(eq(r.table.id, id))
      .run();
    if (r.aliases !== undefined) archiveAliases(db, shopId, r.aliases.kind, id, at);
    r.cascade?.(db, id, at);

    recordAudit(db, {
      shopId,
      actorUserId: actor.userId,
      action: `${r.action}.archive`,
      entityTable: r.tableName,
      entityId: id,
      summary: `Removed ${r.noun} "${r.label(before)}"`,
      before,
    });
  })();
}

/** The entity as the engine would see it, or not-found. Archived rows are not
 *  found: soft delete is invisible to everything but old snapshots. */
function findLive<I, E extends I & { id: string }>(
  r: Resource<I, E>,
  db: ShopQuoteDatabase,
  shopId: string,
  id: string,
): E {
  const entity = r.pick(loadShopConfig(db, shopId)).find((e) => e.id === id);
  if (entity === undefined) throw new DataError('not-found', `No ${r.noun} ${id} in this shop.`);
  return entity;
}

/** Turn a unique-index violation into the sentence the owner needs. */
function uniquely<I, E extends I & { id: string }>(
  r: Resource<I, E>,
  input: I,
  write: () => void,
): void {
  try {
    write();
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new DataError('conflict', `There is already a ${r.noun} called "${r.label(input)}".`, {
        field: 'name',
      });
    }
    throw error;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE'
  );
}

function requireLive(
  db: ShopQuoteDatabase,
  table: CatalogTable,
  shopId: string,
  id: string,
  noun: string,
  field: string,
): void {
  const row = db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.id, id), eq(table.shopId, shopId), isNull(table.archivedAt)))
    .get();
  if (row === undefined) {
    throw new DataError('invalid-reference', `No ${noun} ${id} in this shop.`, { field });
  }
}

/** Make one row's aliases of one kind exactly `aliases` (§8). An alias another
 *  row already answers to is refused: the intake resolver could not choose. */
function replaceAliases(
  db: ShopQuoteDatabase,
  shopId: string,
  kind: AliasKind,
  targetId: string,
  aliases: readonly string[],
): void {
  const wanted = [...new Set(aliases)];
  const live = db
    .select()
    .from(intakeAliases)
    .where(
      and(
        eq(intakeAliases.shopId, shopId),
        eq(intakeAliases.kind, kind),
        isNull(intakeAliases.archivedAt),
      ),
    )
    .all();
  const mine = live.filter((a) => a.targetId === targetId);
  const taken = new Set(live.filter((a) => a.targetId !== targetId).map((a) => a.alias));

  for (const alias of wanted) {
    if (taken.has(alias)) {
      throw new DataError('conflict', `Another ${kind} already answers to "${alias}".`, {
        field: 'aliases',
        alias,
      });
    }
  }

  const at = new Date();
  for (const stale of mine.filter((a) => !wanted.includes(a.alias))) {
    db.update(intakeAliases).set({ archivedAt: at }).where(eq(intakeAliases.id, stale.id)).run();
  }
  const have = new Set(mine.map((a) => a.alias));
  const fresh = wanted.filter((alias) => !have.has(alias));
  if (fresh.length > 0) {
    db.insert(intakeAliases)
      .values(fresh.map((alias) => ({ id: ulid(), shopId, kind, targetId, alias })))
      .run();
  }
}

function archiveAliases(
  db: ShopQuoteDatabase,
  shopId: string,
  kind: AliasKind,
  targetId: string,
  at: Date,
): void {
  db.update(intakeAliases)
    .set({ archivedAt: at })
    .where(
      and(
        eq(intakeAliases.shopId, shopId),
        eq(intakeAliases.kind, kind),
        eq(intakeAliases.targetId, targetId),
        isNull(intakeAliases.archivedAt),
      ),
    )
    .run();
}

/* =========================================================================
   The six catalogs
   ========================================================================= */

const material: Resource<MaterialInput, MaterialRow> = {
  noun: 'material',
  action: 'material',
  table: materials,
  tableName: 'materials',
  pick: (config) => config.materials,
  columns: (m) => materialColumns(m, sameId),
  label: (m) => m.name,
  checkReferences: (db, shopId, m) =>
    requireLive(db, materialFamilies, shopId, m.familyId, 'material family', 'familyId'),
  aliases: { kind: 'material', of: (m) => m.aliases },
  cascade: (db, id, at) => {
    db.update(machineMaterialRates)
      .set({ archivedAt: at })
      .where(and(eq(machineMaterialRates.materialId, id), isNull(machineMaterialRates.archivedAt)))
      .run();
    db.update(stockSizes)
      .set({ archivedAt: at })
      .where(and(eq(stockSizes.materialId, id), isNull(stockSizes.archivedAt)))
      .run();
  },
};

const operation: Resource<OperationInput, Operation> = {
  noun: 'operation',
  action: 'operation',
  table: operations,
  tableName: 'operations',
  pick: (config) => config.operations,
  columns: (o) => operationColumns(o, sameId),
  label: (o) => o.name,
  checkReferences: (db, shopId, o) => {
    if (o.machineId !== null) {
      requireLive(db, machines, shopId, o.machineId, 'machine', 'machineId');
    }
  },
};

const plating: Resource<PlatingSpecInput, PlatingSpec> = {
  noun: 'plating spec',
  action: 'plating',
  table: platingSpecs,
  tableName: 'plating_specs',
  pick: (config) => config.platingSpecs,
  columns: (p) => platingColumns(p),
  label: (p) => p.name,
  aliases: { kind: 'plating', of: (p) => p.aliases },
};

const coating: Resource<CoatingModelInput, CoatingModel> = {
  noun: 'coating model',
  action: 'coating',
  table: coatingModels,
  tableName: 'coating_models',
  pick: (config) => config.coatingModels,
  columns: (c) => coatingColumns(c),
  label: (c) => c.name,
};

const silkscreen: Resource<SilkscreenTierInput, SilkscreenTier> = {
  noun: 'silkscreen tier',
  action: 'silkscreen',
  table: silkscreenTiers,
  tableName: 'silkscreen_tiers',
  pick: (config) => config.silkscreenTiers,
  columns: (s) => silkscreenColumns(s),
  label: (s) => s.name,
};

const assembly: Resource<AssemblyStandardInput, AssemblyStandard> = {
  noun: 'assembly standard',
  action: 'assembly',
  table: assemblyStandards,
  tableName: 'assembly_standards',
  pick: (config) => config.assemblyStandards,
  columns: (a) => assemblyColumns(a),
  label: (a) => a.action,
};

/* ---- materials, and their prices ---------------------------------------- */

/** Add a material, with its first price version when one is given. */
export function createMaterial(
  handle: DatabaseHandle,
  shopId: string,
  input: MaterialInput,
  actor: Actor,
  price?: PriceInput,
): MaterialRow {
  return createRow(material, handle, shopId, input, actor, (db, id) => {
    if (price !== undefined) insertPrice(db, shopId, id, price, actor.userId);
  });
}

export function updateMaterial(
  handle: DatabaseHandle,
  shopId: string,
  id: string,
  input: MaterialInput,
  actor: Actor,
): MaterialRow {
  return updateRow(material, handle, shopId, id, input, actor);
}

export function archiveMaterial(
  handle: DatabaseHandle,
  shopId: string,
  id: string,
  actor: Actor,
): void {
  archiveRow(material, handle, shopId, id, actor);
}

/**
 * A new price version (§7) — an insert, always. The previous version stays
 * exactly as it was, so a quote priced against it can still be explained.
 */
export function addMaterialPrice(
  handle: DatabaseHandle,
  shopId: string,
  materialId: string,
  price: PriceInput,
  actor: Actor,
): PriceVersion {
  return handle.sqlite.transaction(() => {
    const { db } = handle;
    const before = findLive(material, db, shopId, materialId);
    const version = insertPrice(db, shopId, materialId, price, actor.userId);
    recordAudit(db, {
      shopId,
      actorUserId: actor.userId,
      action: 'material.price.create',
      entityTable: 'material_prices',
      entityId: version.id,
      summary:
        `${before.name}: ${usd(price.pricePerLbUsd)}/lb from ${day(price.effectiveFrom)}` +
        (before.pricePerLbUsd === null ? ' (first price)' : ` (was ${usd(before.pricePerLbUsd)})`),
      before: { materialId, pricePerLbUsd: before.pricePerLbUsd },
      after: version,
    });
    return version;
  })();
}

/** Every price version of one live material, oldest first. */
export function materialPriceHistory(
  db: ShopQuoteDatabase,
  shopId: string,
  materialId: string,
): PriceVersion[] {
  findLive(material, db, shopId, materialId);
  return loadPriceHistory(db, shopId, materialId);
}

function insertPrice(
  db: ShopQuoteDatabase,
  shopId: string,
  materialId: string,
  price: PriceInput,
  enteredByUserId: string,
): PriceVersion {
  const row = db
    .insert(materialPrices)
    .values({
      id: ulid(),
      shopId,
      materialId,
      pricePerLbUsd: price.pricePerLbUsd,
      sheetCostUsd: price.sheetCostUsd,
      sheetLbs: price.sheetLbs,
      effectiveFrom: price.effectiveFrom,
      note: price.note,
      enteredByUserId,
    })
    .returning()
    .get();
  return toPriceVersion(row);
}

const usd = (n: number): string => `$${Number(n.toFixed(4))}`;
const day = (d: Date): string => d.toISOString().slice(0, 10);

/* ---- the other five ------------------------------------------------------ */

export function createOperation(
  handle: DatabaseHandle,
  shopId: string,
  input: OperationInput,
  actor: Actor,
): Operation {
  return createRow(operation, handle, shopId, input, actor);
}
export function updateOperation(
  handle: DatabaseHandle,
  shopId: string,
  id: string,
  input: OperationInput,
  actor: Actor,
): Operation {
  return updateRow(operation, handle, shopId, id, input, actor);
}
export function archiveOperation(
  handle: DatabaseHandle,
  shopId: string,
  id: string,
  actor: Actor,
): void {
  archiveRow(operation, handle, shopId, id, actor);
}

export function createPlatingSpec(
  handle: DatabaseHandle,
  shopId: string,
  input: PlatingSpecInput,
  actor: Actor,
): PlatingSpec {
  return createRow(plating, handle, shopId, input, actor);
}
export function updatePlatingSpec(
  handle: DatabaseHandle,
  shopId: string,
  id: string,
  input: PlatingSpecInput,
  actor: Actor,
): PlatingSpec {
  return updateRow(plating, handle, shopId, id, input, actor);
}
export function archivePlatingSpec(
  handle: DatabaseHandle,
  shopId: string,
  id: string,
  actor: Actor,
): void {
  archiveRow(plating, handle, shopId, id, actor);
}

export function createCoatingModel(
  handle: DatabaseHandle,
  shopId: string,
  input: CoatingModelInput,
  actor: Actor,
): CoatingModel {
  return createRow(coating, handle, shopId, input, actor);
}
export function updateCoatingModel(
  handle: DatabaseHandle,
  shopId: string,
  id: string,
  input: CoatingModelInput,
  actor: Actor,
): CoatingModel {
  return updateRow(coating, handle, shopId, id, input, actor);
}
export function archiveCoatingModel(
  handle: DatabaseHandle,
  shopId: string,
  id: string,
  actor: Actor,
): void {
  archiveRow(coating, handle, shopId, id, actor);
}

export function createSilkscreenTier(
  handle: DatabaseHandle,
  shopId: string,
  input: SilkscreenTierInput,
  actor: Actor,
): SilkscreenTier {
  return createRow(silkscreen, handle, shopId, input, actor);
}
export function updateSilkscreenTier(
  handle: DatabaseHandle,
  shopId: string,
  id: string,
  input: SilkscreenTierInput,
  actor: Actor,
): SilkscreenTier {
  return updateRow(silkscreen, handle, shopId, id, input, actor);
}
export function archiveSilkscreenTier(
  handle: DatabaseHandle,
  shopId: string,
  id: string,
  actor: Actor,
): void {
  archiveRow(silkscreen, handle, shopId, id, actor);
}

export function createAssemblyStandard(
  handle: DatabaseHandle,
  shopId: string,
  input: AssemblyStandardInput,
  actor: Actor,
): AssemblyStandard {
  return createRow(assembly, handle, shopId, input, actor);
}
export function updateAssemblyStandard(
  handle: DatabaseHandle,
  shopId: string,
  id: string,
  input: AssemblyStandardInput,
  actor: Actor,
): AssemblyStandard {
  return updateRow(assembly, handle, shopId, id, input, actor);
}
export function archiveAssemblyStandard(
  handle: DatabaseHandle,
  shopId: string,
  id: string,
  actor: Actor,
): void {
  archiveRow(assembly, handle, shopId, id, actor);
}
