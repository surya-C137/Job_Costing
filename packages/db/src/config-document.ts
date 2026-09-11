/**
 * The config JSON (§4 FR-1, §8): a shop's whole configuration as one file —
 * "this is how the next shop starts".
 *
 * The file is a `ShopConfig` plus the two things a `ShopConfig` does not carry:
 *
 *   - **`priceHistory`** — every price version, not only the one in force. §7
 *     versions prices so their history is auditable, and an export that
 *     flattened it would lose exactly that (BUILD-PLAN 4.2's acceptance check:
 *     "export JSON contains both" versions).
 *   - **`exportedAt`** — the moment the config's prices were read, which is
 *     what the history is checked against on the way back in.
 *
 * Users are not in it. §12 lists them as Settings, but a password hash has no
 * business in a file that gets emailed to the next shop. Nor are customers or
 * quotes: this is configuration, not data.
 *
 * Import makes the shop's catalog equal the file — `writeShopConfig()`'s
 * `replace` says exactly what that means — and a hand-written file may leave
 * out the history and the timestamp: its prices then become versions effective
 * the moment it is imported.
 */

import { z } from 'zod';

import type { ShopConfig } from '@shopquote/calc';

import { recordAudit, type Actor } from './audit.js';
import { loadPriceHistory, loadShopConfig } from './config.js';
import { shopConfigSchema } from './config-schema.js';
import type { DatabaseHandle, ShopQuoteDatabase } from './db.js';
import { writeShopConfig, type TableChanges } from './write-config.js';

export const CONFIG_DOCUMENT_FORMAT = 'shopquote.config' as const;

/** A stored price version as the file carries it: no id, no author — those
 *  belong to the database it came from. */
export interface PriceVersionRecord {
  /** `MaterialRow.id` within the file's `config`. */
  materialId: string;
  pricePerLbUsd: number;
  sheetCostUsd: number | null;
  sheetLbs: number | null;
  effectiveFrom: Date;
  note: string | null;
}

export interface ConfigDocument {
  format: typeof CONFIG_DOCUMENT_FORMAT;
  schemaVersion: 1;
  /** When the config's prices were read. Null for a hand-written file. */
  exportedAt: Date | null;
  config: ShopConfig;
  /** Every price version, oldest first. Null when the file carries only the
   *  prices in `config`; those become versions effective at import. */
  priceHistory: PriceVersionRecord[] | null;
}

const amount = z.number().finite().nonnegative();

/** An ISO-8601 instant in JSON; a `Date` from a caller in the same process. */
const instant = z
  .union([z.string().datetime({ offset: true }), z.date()])
  .transform((value) => new Date(value));

const priceVersionRecordSchema = z
  .object({
    materialId: z.string().min(1),
    pricePerLbUsd: amount,
    sheetCostUsd: amount.nullable(),
    sheetLbs: amount.nullable(),
    effectiveFrom: instant,
    note: z.string().max(500).nullable(),
  })
  .strict();

export const configDocumentSchema = z
  .object({
    format: z.literal(CONFIG_DOCUMENT_FORMAT, {
      errorMap: () => ({
        message: `Not a ShopQuote config file: "format" must be "${CONFIG_DOCUMENT_FORMAT}".`,
      }),
    }),
    schemaVersion: z.literal(1, {
      errorMap: () => ({ message: 'This build reads config files with schemaVersion 1.' }),
    }),
    exportedAt: instant.nullable().default(null),
    config: shopConfigSchema,
    priceHistory: z.array(priceVersionRecordSchema).nullable().default(null),
  })
  .strict()
  .superRefine((document, ctx) => checkHistory(document, ctx)) satisfies z.ZodType<
  ConfigDocument,
  z.ZodTypeDef,
  unknown
>;

/**
 * A file's prices and its history have to tell the same story. If an owner
 * edits `config.materials[i].pricePerLbUsd` in a text editor and leaves the
 * history alone, importing one or the other silently would throw their edit
 * away or ignore the record — so neither happens, and the row is named.
 */
function checkHistory(document: ConfigDocument, ctx: z.RefinementCtx): void {
  const { priceHistory, exportedAt, config } = document;
  if (priceHistory === null) return;
  const issue = (path: (string | number)[], message: string): void => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
  };
  if (exportedAt === null) {
    issue(['exportedAt'], 'A file with a price history needs exportedAt, the moment it was read.');
    return;
  }

  const materialIds = new Set(config.materials.map((m) => m.id));
  priceHistory.forEach((v, i) => {
    if (!materialIds.has(v.materialId)) {
      issue(['priceHistory', i, 'materialId'], `No material "${v.materialId}" in this config.`);
    }
  });

  // In force at `exportedAt`: the last version on or before it. The export
  // lists versions oldest first with same-day ties in the order they were
  // entered, so a later entry wins a tie — as `effectivePrices()` does.
  const inForce = new Map<string, PriceVersionRecord>();
  for (const v of priceHistory) {
    if (v.effectiveFrom.getTime() > exportedAt.getTime()) continue;
    const current = inForce.get(v.materialId);
    if (current === undefined || v.effectiveFrom.getTime() >= current.effectiveFrom.getTime()) {
      inForce.set(v.materialId, v);
    }
  }

  config.materials.forEach((m, i) => {
    const v = inForce.get(m.id);
    const agrees =
      v === undefined
        ? m.pricePerLbUsd === null
        : v.pricePerLbUsd === m.pricePerLbUsd &&
          v.sheetCostUsd === m.sheetCostUsd &&
          v.sheetLbs === m.sheetLbs;
    if (!agrees) {
      issue(
        ['config', 'materials', i, 'pricePerLbUsd'],
        `"${m.name}" is priced ${m.pricePerLbUsd ?? 'unpriced'} here but ` +
          `${v?.pricePerLbUsd ?? 'unpriced'} in priceHistory as of exportedAt. Make them agree, ` +
          `or import the file as it was exported and enter the new price afterwards.`,
      );
    }
  });
}

/** The whole of a shop's configuration as of `at`, with every price version. */
export function exportShopConfig(
  db: ShopQuoteDatabase,
  shopId: string,
  at: Date = new Date(),
): ConfigDocument {
  const config = loadShopConfig(db, shopId, at);
  const inConfig = new Set(config.materials.map((m) => m.id));
  return {
    format: CONFIG_DOCUMENT_FORMAT,
    schemaVersion: 1,
    exportedAt: at,
    config,
    priceHistory: loadPriceHistory(db, shopId)
      .filter((v) => inConfig.has(v.materialId))
      .map((v) => ({
        materialId: v.materialId,
        pricePerLbUsd: v.pricePerLbUsd,
        sheetCostUsd: v.sheetCostUsd,
        sheetLbs: v.sheetLbs,
        effectiveFrom: v.effectiveFrom,
        note: v.note,
      })),
  };
}

export interface ImportOptions {
  actor: Actor;
  /** When derived prices take effect, for a file without a history. */
  at?: Date;
  /** Work out what would change, then roll it all back. */
  dryRun?: boolean;
}

export interface ImportResult {
  dryRun: boolean;
  /** What moved, by table. All zeros for a shop's own export re-imported. */
  changes: Record<string, TableChanges>;
  totals: TableChanges;
}

/** Thrown to unwind a dry run's transaction, carrying what it would have done. */
class DryRun extends Error {
  constructor(readonly result: ImportResult) {
    super('dry run');
  }
}

/**
 * Make a shop's configuration equal a (validated) config file.
 *
 * One transaction, audit row included. A dry run performs the whole import —
 * so its answer is the real answer, not an estimate — and then rolls it back.
 */
export function importShopConfig(
  handle: DatabaseHandle,
  shopId: string,
  document: ConfigDocument,
  options: ImportOptions,
): ImportResult {
  const dryRun = options.dryRun === true;
  try {
    return handle.sqlite.transaction(() => {
      const written = writeShopConfig(handle, document.config, {
        shopId,
        replace: true,
        pricesEffectiveFrom: options.at ?? new Date(),
        priceNote: 'Imported from a config file',
        enteredByUserId: options.actor.userId,
        ...(document.priceHistory === null ? {} : { priceHistory: document.priceHistory }),
      });

      const totals: TableChanges = { inserted: 0, updated: 0, archived: 0 };
      for (const c of Object.values(written.changes)) {
        totals.inserted += c.inserted;
        totals.updated += c.updated;
        totals.archived += c.archived;
      }
      const result: ImportResult = { dryRun, changes: written.changes, totals };

      recordAudit(handle.db, {
        shopId,
        actorUserId: options.actor.userId,
        action: 'config.import',
        entityTable: 'shops',
        entityId: shopId,
        summary:
          `Imported "${document.config.defaults.shopName}": ${totals.inserted} added, ` +
          `${totals.updated} changed, ${totals.archived} archived`,
        after: {
          changes: written.changes,
          exportedAt: document.exportedAt,
          fromShopId: document.config.shopId,
        },
      });

      if (dryRun) throw new DryRun(result);
      return result;
    })();
  } catch (error) {
    if (error instanceof DryRun) return error.result;
    throw error;
  }
}
