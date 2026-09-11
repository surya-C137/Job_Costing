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
 * **It is also how a config import lands (§4 FR-1).** With `replace: true` it
 * writes into a shop that already exists and makes that shop's catalog *equal*
 * the config: a row whose id the config carries is updated in place (and
 * un-archived, if it had been), a config entity with an id this shop has never
 * seen becomes a new row, and a live row the config does not mention is
 * archived — never deleted (§7). Matching on id is what makes the operation
 * safe to repeat: importing a shop's own export changes nothing, and open
 * quotes keep pointing at the materials they were entered against. Creating a
 * shop is the same walk over an empty shop, so there is one code path, and
 * the round-trip tests cover both.
 *
 * **Ids.** A `ShopConfig` from the seed carries slugs (`material:g30-16-ga`);
 * §7 says stored ids are ULIDs. So an entity without a matching row gets a
 * fresh ULID, keeps its config id in `source_key` for provenance, and the
 * returned map translates one to the other for anything that has to follow a
 * reference.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { ulid } from 'ulid';

import type { ShopConfig } from '@shopquote/calc';

import {
  assemblyColumns,
  coatingColumns,
  familyColumns,
  gaugeColumns,
  hitRateColumns,
  machineColumns,
  materialColumns,
  operationColumns,
  platingColumns,
  shopSettingsColumns,
  silkscreenColumns,
  stockSizeColumns,
  type CatalogTable,
} from './columns.js';
import { effectivePrices } from './config.js';
import type { DatabaseHandle } from './db.js';
import { DataError } from './errors.js';
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

/** One stored price version, as a config document carries it (§7). */
export interface PriceVersionInput {
  /** `MaterialRow.id` in the config being written. */
  materialId: string;
  pricePerLbUsd: number;
  sheetCostUsd: number | null;
  sheetLbs: number | null;
  effectiveFrom: Date;
  note: string | null;
}

export interface WriteConfigOptions {
  /** The shop's ULID. Generated when absent; required with `replace`. */
  shopId?: string;
  /** Effective date for a price the config carries that the shop does not
   *  already have in force. The seed uses the workbook's own vintage rather
   *  than "now", because that is what the prices are (§6). */
  pricesEffectiveFrom: Date;
  /** Goes on every price row this call derives from the config. */
  priceNote?: string;
  /** Who entered the prices. Absent for a seed: nobody typed them. */
  enteredByUserId?: string;
  /** Write into the existing shop `shopId` names, making its catalog equal
   *  this config, rather than creating a new shop. */
  replace?: boolean;
  /**
   * The full price history to store instead of deriving one version per
   * priced material. A config export carries it (BUILD-PLAN 4.2: "export JSON
   * contains both" versions). A version already stored is not written twice.
   */
  priceHistory?: readonly PriceVersionInput[];
}

export interface TableChanges {
  inserted: number;
  updated: number;
  archived: number;
}

export interface WriteConfigResult {
  shopId: string;
  /** `ShopConfig` id → stored id, for every entity written. A matched entity
   *  maps to itself. */
  ids: Map<string, string>;
  /** Rows the config holds, by table — the seed's summary output. For
   *  `material_prices`, the versions this call wrote. */
  counts: Record<string, number>;
  /** What actually moved, by table. A re-import of an unchanged config is all
   *  zeros, which is the property that makes import safe to repeat. */
  changes: Record<string, TableChanges>;
}

/** SQLite takes 32 766 bound parameters per statement; a wide table at 500
 *  rows would pass it. Chunking is cheaper than counting columns. */
const CHUNK = 200;

function chunks<T>(rows: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += CHUNK) out.push(rows.slice(i, i + CHUNK));
  return out;
}

type StoredRow = Record<string, unknown> & { id: string; archivedAt: Date | null };

/** Identity columns: set when a row is created, never rewritten by a sync. */
const IDENTITY = new Set(['id', 'shopId', 'sourceKey']);

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  return a === b || (a == null && b == null);
}

/** True when writing `next` over `stored` would change anything — including
 *  bringing an archived row back. */
function differs(next: Record<string, unknown>, stored: StoredRow): boolean {
  if (stored.archivedAt !== null) return true;
  return Object.keys(next).some((k) => !IDENTITY.has(k) && !sameValue(next[k], stored[k]));
}

function withoutIdentity(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([k]) => !IDENTITY.has(k)));
}

/**
 * Write a whole `ShopConfig`: as a new shop, or over an existing one with
 * `replace`. One transaction either way — a half-written catalog is worse than
 * no catalog.
 */
export function writeShopConfig(
  handle: DatabaseHandle,
  config: ShopConfig,
  options: WriteConfigOptions,
): WriteConfigResult {
  const { db } = handle;
  const replace = options.replace === true;
  if (replace && options.shopId === undefined) {
    throw new Error('writeShopConfig: `replace` needs the shopId of the shop to write into.');
  }
  const shopId = options.shopId ?? ulid();
  const ids = new Map<string, string>();
  const counts: Record<string, number> = {};
  const changes: Record<string, TableChanges> = {};
  const now = new Date();

  /** Ids of every row this shop already has in `table`, archived or not. A
   *  new shop has none, which is what makes creation the degenerate case. */
  const storedIds = (table: CatalogTable): Set<string> => {
    if (!replace) return new Set();
    const rows = db.select({ id: table.id }).from(table).where(eq(table.shopId, shopId)).all() as {
      id: string;
    }[];
    return new Set(rows.map((r) => r.id));
  };

  /**
   * The stored id for a config id: itself when this shop already has that
   * row, otherwise a fresh ULID.
   *
   * A repeat is a defect in the config, not something to absorb: two entities
   * sharing an id means one of them is unreachable by reference and only one
   * row would be written. It surfaces here rather than as a primary-key
   * violation three tables later. (The seed hit exactly this — the workbook's
   * assembly sheet lists an action twice, which slugged to one key; the fix
   * was in the extractor.)
   */
  const idFor = (configId: string, known: Set<string>): string => {
    if (ids.has(configId)) {
      throw new DataError(
        'invalid',
        `Two entities in this ShopConfig share the id "${configId}". ` +
          `Ids must be unique across the config; fix the source that generated it.`,
      );
    }
    const stored = known.has(configId) ? configId : ulid();
    ids.set(configId, stored);
    return stored;
  };

  /** Follow a reference to an entity mapped earlier in this run. */
  const ref = (configId: string): string => {
    const mapped = ids.get(configId);
    if (mapped === undefined) {
      throw new DataError(
        'invalid-reference',
        `Config references "${configId}", which is not in this ShopConfig. ` +
          `Every id a material, machine or operation points at must exist before it can be stored.`,
      );
    }
    return mapped;
  };

  /**
   * Make this shop's rows in `table` equal `rows`, whose ids are final.
   *
   * Live rows the config does not list are archived *first*: uniqueness holds
   * among live rows only (`schema.ts`), so a row being replaced by one with
   * the same name has to step aside before its successor is written.
   *
   * The `as never` casts are Drizzle being unable to type a write to "some
   * catalog table"; every row here was built by `columns.ts` for that table.
   */
  const sync = (
    name: string,
    table: CatalogTable,
    rows: (Record<string, unknown> & { id: string })[],
  ): void => {
    const stored = replace
      ? (db.select().from(table).where(eq(table.shopId, shopId)).all() as StoredRow[])
      : [];
    const byId = new Map(stored.map((r) => [r.id, r]));
    const listed = new Set(rows.map((r) => r.id));

    const stale = stored.filter((r) => r.archivedAt === null && !listed.has(r.id)).map((r) => r.id);
    for (const chunk of chunks(stale)) {
      db.update(table)
        .set({ archivedAt: now } as never)
        .where(inArray(table.id, chunk))
        .run();
    }

    let updated = 0;
    const fresh: typeof rows = [];
    for (const row of rows) {
      const existing = byId.get(row.id);
      if (existing === undefined) {
        fresh.push(row);
      } else if (differs(row, existing)) {
        db.update(table)
          .set({ ...withoutIdentity(row), archivedAt: null } as never)
          .where(eq(table.id, row.id))
          .run();
        updated += 1;
      }
    }
    for (const chunk of chunks(fresh)) {
      db.insert(table)
        .values(chunk as never)
        .run();
    }

    counts[name] = rows.length;
    changes[name] = { inserted: fresh.length, updated, archived: stale.length };
  };

  handle.sqlite.transaction(() => {
    /* ---- the shop row ------------------------------------------------ */

    const shopValues = {
      ...shopSettingsColumns(config.defaults, config.parity, config.enabledModules),
      calcSchemaVersion: config.schemaVersion,
    };

    if (replace) {
      const current = db.select().from(shops).where(eq(shops.id, shopId)).get();
      if (current === undefined) {
        throw new DataError('not-found', `No shop ${shopId} to write this config into.`);
      }
      const changed = Object.entries(shopValues).some(
        ([k, v]) => !sameValue(v, (current as Record<string, unknown>)[k]),
      );
      if (changed) db.update(shops).set(shopValues).where(eq(shops.id, shopId)).run();
      changes['shops'] = { inserted: 0, updated: changed ? 1 : 0, archived: 0 };
    } else {
      db.insert(shops)
        .values({ id: shopId, ...shopValues })
        .run();
      changes['shops'] = { inserted: 1, updated: 0, archived: 0 };
    }
    counts['shops'] = 1;

    /* ---- material catalog ------------------------------------------- */

    const familyIds = storedIds(materialFamilies);
    sync(
      'material_families',
      materialFamilies,
      config.families.map((f) => ({
        id: idFor(f.id, familyIds),
        shopId,
        sourceKey: f.id,
        ...familyColumns(f),
      })),
    );

    const gaugeIds = storedIds(gaugeReference);
    sync(
      'gauge_reference',
      gaugeReference,
      config.gauges.map((g) => ({
        id: idFor(g.id, gaugeIds),
        shopId,
        sourceKey: g.id,
        ...gaugeColumns(g, ref),
      })),
    );

    const materialIds = storedIds(materials);
    sync(
      'materials',
      materials,
      config.materials.map((m) => ({
        id: idFor(m.id, materialIds),
        shopId,
        sourceKey: m.id,
        ...materialColumns(m, ref),
      })),
    );

    writePrices();

    const stockSizeIds = storedIds(stockSizes);
    sync(
      'stock_sizes',
      stockSizes,
      config.stockSizes.map((s) => ({
        id: idFor(s.id, stockSizeIds),
        shopId,
        sourceKey: s.id,
        ...stockSizeColumns(s, ref),
      })),
    );

    /* ---- work centres ------------------------------------------------ */

    const machineIds = storedIds(machines);
    sync(
      'machines',
      machines,
      config.machines.map((m) => ({
        id: idFor(m.id, machineIds),
        shopId,
        sourceKey: m.id,
        ...machineColumns(m),
      })),
    );

    const hitRateIds = storedIds(punchHitRates);
    sync(
      'punch_hit_rates',
      punchHitRates,
      config.machines.flatMap((m) =>
        m.hitRates.map((h) => ({
          id: idFor(h.id, hitRateIds),
          shopId,
          sourceKey: h.id,
          machineId: ref(m.id),
          ...hitRateColumns(h),
        })),
      ),
    );

    writeMachineMaterialRates();

    const operationIds = storedIds(operations);
    sync(
      'operations',
      operations,
      config.operations.map((o) => ({
        id: idFor(o.id, operationIds),
        shopId,
        sourceKey: o.id,
        ...operationColumns(o, ref),
      })),
    );

    /* ---- finishing --------------------------------------------------- */

    const platingIds = storedIds(platingSpecs);
    sync(
      'plating_specs',
      platingSpecs,
      config.platingSpecs.map((p) => ({
        id: idFor(p.id, platingIds),
        shopId,
        sourceKey: p.id,
        ...platingColumns(p),
      })),
    );

    const coatingIds = storedIds(coatingModels);
    sync(
      'coating_models',
      coatingModels,
      config.coatingModels.map((c) => ({
        id: idFor(c.id, coatingIds),
        shopId,
        sourceKey: c.id,
        ...coatingColumns(c),
      })),
    );

    const silkscreenIds = storedIds(silkscreenTiers);
    sync(
      'silkscreen_tiers',
      silkscreenTiers,
      config.silkscreenTiers.map((s) => ({
        id: idFor(s.id, silkscreenIds),
        shopId,
        sourceKey: s.id,
        ...silkscreenColumns(s),
      })),
    );

    const assemblyIds = storedIds(assemblyStandards);
    sync(
      'assembly_standards',
      assemblyStandards,
      config.assemblyStandards.map((a) => ({
        id: idFor(a.id, assemblyIds),
        shopId,
        sourceKey: a.id,
        ...assemblyColumns(a),
      })),
    );

    writeAliases();
  })();

  return { shopId, ids, counts, changes };

  /* ---- the three tables that are not keyed by a config id ------------- */

  /**
   * Price versions (§7). A price change is a new row, never an update — so
   * this only ever inserts, and a price the shop already has in force is not
   * written again.
   *
   * With a history: every version in it that is not already stored. Without
   * one: a version for each priced material whose price differs from the one
   * in force at `pricesEffectiveFrom`. A material the shop stocks but has never
   * priced gets no row at all — which is how `loadShopConfig()` reads the null
   * back, and how the estimator ends up warned rather than quoted free steel
   * (§12 rule 3). A null in the config never deletes a stored price: history
   * only moves forward.
   */
  function writePrices(): void {
    const rows: (typeof materialPrices.$inferInsert)[] = [];

    if (options.priceHistory !== undefined) {
      const configMaterials = new Set(config.materials.map((m) => m.id));
      const stored = replace
        ? db
            .select()
            .from(materialPrices)
            .where(and(eq(materialPrices.shopId, shopId), isNull(materialPrices.archivedAt)))
            .all()
        : [];
      const seen = new Set(stored.map(versionKey));

      for (const v of options.priceHistory) {
        if (!configMaterials.has(v.materialId)) {
          throw new DataError(
            'invalid-reference',
            `Price history names material "${v.materialId}", which is not in this config.`,
          );
        }
        const row = {
          id: ulid(),
          shopId,
          materialId: ref(v.materialId),
          pricePerLbUsd: v.pricePerLbUsd,
          sheetCostUsd: v.sheetCostUsd,
          sheetLbs: v.sheetLbs,
          effectiveFrom: v.effectiveFrom,
          note: v.note,
        };
        const key = versionKey(row);
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push(row);
      }
    } else {
      const inForce = effectivePrices(db, shopId, options.pricesEffectiveFrom);
      for (const m of config.materials) {
        if (m.pricePerLbUsd === null) continue;
        const current = inForce.get(ref(m.id));
        const unchanged =
          current !== undefined &&
          current.pricePerLbUsd === m.pricePerLbUsd &&
          current.sheetCostUsd === m.sheetCostUsd &&
          current.sheetLbs === m.sheetLbs;
        if (unchanged) continue;
        rows.push({
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
        });
      }
    }

    for (const chunk of chunks(rows)) db.insert(materialPrices).values(chunk).run();
    counts['material_prices'] = rows.length;
    changes['material_prices'] = { inserted: rows.length, updated: 0, archived: 0 };
  }

  /** Speeds and pierce times, keyed by the machine/material pair (§3). */
  function writeMachineMaterialRates(): void {
    const wanted = config.machineMaterialRates.map((r) => ({
      shopId,
      machineId: ref(r.machineId),
      materialId: ref(r.materialId),
      cutSpeedInPerMin: r.cutSpeedInPerMin,
      pierceSeconds: r.pierceSeconds,
      punchRateFactor: r.punchRateFactor,
    }));
    const pair = (r: { machineId: string; materialId: string }) => `${r.machineId}|${r.materialId}`;

    const stored = replace
      ? db
          .select()
          .from(machineMaterialRates)
          .where(
            and(eq(machineMaterialRates.shopId, shopId), isNull(machineMaterialRates.archivedAt)),
          )
          .all()
      : [];
    const byPair = new Map(stored.map((r) => [pair(r), r]));
    const wantedPairs = new Set(wanted.map(pair));

    const stale = stored.filter((r) => !wantedPairs.has(pair(r))).map((r) => r.id);
    for (const chunk of chunks(stale)) {
      db.update(machineMaterialRates)
        .set({ archivedAt: now })
        .where(inArray(machineMaterialRates.id, chunk))
        .run();
    }

    let updated = 0;
    const fresh: (typeof machineMaterialRates.$inferInsert)[] = [];
    for (const row of wanted) {
      const existing = byPair.get(pair(row));
      if (existing === undefined) {
        fresh.push({ id: ulid(), ...row });
      } else if (differs(row, existing)) {
        db.update(machineMaterialRates)
          .set({
            cutSpeedInPerMin: row.cutSpeedInPerMin,
            pierceSeconds: row.pierceSeconds,
            punchRateFactor: row.punchRateFactor,
          })
          .where(eq(machineMaterialRates.id, existing.id))
          .run();
        updated += 1;
      }
    }
    for (const chunk of chunks(fresh)) db.insert(machineMaterialRates).values(chunk).run();

    counts['machine_material_rates'] = wanted.length;
    changes['machine_material_rates'] = {
      inserted: fresh.length,
      updated,
      archived: stale.length,
    };
  }

  /**
   * Aliases are a table rather than a JSON column (§12), so the three places a
   * `ShopConfig` carries them are flattened into one list here and grouped
   * back on the way out. Keyed by kind and spelling, which is what the table
   * holds unique. CSV-header and drawing-keyword aliases are not part of a
   * `ShopConfig` and are never touched.
   */
  function writeAliases(): void {
    type Kind = 'family' | 'material' | 'plating';
    const wanted: { kind: Kind; targetId: string; alias: string }[] = [
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
    const key = (a: { kind: string; alias: string }) => `${a.kind}|${a.alias}`;

    const stored = replace
      ? db
          .select()
          .from(intakeAliases)
          .where(
            and(
              eq(intakeAliases.shopId, shopId),
              isNull(intakeAliases.archivedAt),
              inArray(intakeAliases.kind, ['family', 'material', 'plating']),
            ),
          )
          .all()
      : [];
    const byKey = new Map(stored.map((a) => [key(a), a]));
    const wantedKeys = new Set(wanted.map(key));

    const stale = stored.filter((a) => !wantedKeys.has(key(a))).map((a) => a.id);
    for (const chunk of chunks(stale)) {
      db.update(intakeAliases)
        .set({ archivedAt: now })
        .where(inArray(intakeAliases.id, chunk))
        .run();
    }

    let updated = 0;
    const fresh: (typeof intakeAliases.$inferInsert)[] = [];
    for (const a of wanted) {
      const existing = byKey.get(key(a));
      if (existing === undefined) {
        fresh.push({ id: ulid(), shopId, ...a });
      } else if (existing.targetId !== a.targetId) {
        db.update(intakeAliases)
          .set({ targetId: a.targetId })
          .where(eq(intakeAliases.id, existing.id))
          .run();
        updated += 1;
      }
    }
    for (const chunk of chunks(fresh)) db.insert(intakeAliases).values(chunk).run();

    counts['intake_aliases'] = wanted.length;
    changes['intake_aliases'] = { inserted: fresh.length, updated, archived: stale.length };
  }
}

/** Two price rows are the same version when they say the same thing about the
 *  same material from the same moment. */
function versionKey(v: {
  materialId: string;
  pricePerLbUsd: number;
  sheetCostUsd?: number | null;
  sheetLbs?: number | null;
  effectiveFrom: Date;
}): string {
  return [
    v.materialId,
    v.effectiveFrom.getTime(),
    v.pricePerLbUsd,
    v.sheetCostUsd ?? null,
    v.sheetLbs ?? null,
  ].join('|');
}
