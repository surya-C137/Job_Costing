/**
 * The audit log (§4 FR-6: "every quote save records who/when; config edits
 * are logged").
 *
 * Every function in this package that changes Settings, users or quotes on
 * someone's behalf takes an `Actor` and writes its audit row *inside its own
 * transaction*. That is the whole design: an audit entry that lives in the
 * route handler is one a new route forgets, and one written after the commit
 * is one a crash loses. Here the change and the record of it commit together
 * or not at all.
 */

import type { ShopQuoteDatabase } from './db.js';
import { auditLog } from './schema.js';

/** Who is making a change. The API supplies it from the session. */
export interface Actor {
  userId: string;
}

export interface AuditEntry {
  shopId: string;
  /** Null only for the system acting on its own — never for an API write. */
  actorUserId: string | null;
  /** Verb, dotted: `material.price.create`, `config.import`, `auth.login`. */
  action: string;
  entityTable?: string;
  entityId?: string;
  /** One line a person can read in a list without opening the JSON. */
  summary: string;
  /** The entity as it stood before, when there was one. */
  before?: unknown;
  /** The entity as it stands after, when there still is one. */
  after?: unknown;
}

export function recordAudit(db: ShopQuoteDatabase, entry: AuditEntry): void {
  db.insert(auditLog)
    .values({
      shopId: entry.shopId,
      actorUserId: entry.actorUserId,
      action: entry.action,
      entityTable: entry.entityTable ?? null,
      entityId: entry.entityId ?? null,
      summary: entry.summary,
      before: entry.before ?? null,
      after: entry.after ?? null,
    })
    .run();
}

/**
 * What changed between two versions of something, one entry per field, for an
 * audit summary: `["defaults.laborMarkup 1.2 → 1.25"]`. Nested objects are
 * walked; arrays and scalars compare as values. The owner reading the log sees
 * what moved without opening two JSON blobs side by side.
 */
export function describeChanges(
  before: unknown,
  after: unknown,
  ignore: readonly string[] = ['id'],
): string[] {
  const out: string[] = [];
  const walk = (a: unknown, b: unknown, path: string): void => {
    if (isPlainObject(a) && isPlainObject(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (path === '' && ignore.includes(key)) continue;
        walk(a[key], b[key], path === '' ? key : `${path}.${key}`);
      }
      return;
    }
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`${path} ${show(a)} → ${show(b)}`);
  };
  walk(before, after, '');
  return out;
}

/** The first few of `describeChanges()`, joined for a one-line summary. */
export function summarizeChanges(changes: readonly string[], limit = 4): string {
  const shown = changes.slice(0, limit).join('; ');
  return changes.length > limit ? `${shown}; and ${changes.length - limit} more` : shown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
  );
}

function show(value: unknown): string {
  const text = value === undefined ? '—' : JSON.stringify(value);
  return text.length > 40 ? `${text.slice(0, 37)}…` : text;
}
