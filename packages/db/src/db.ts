/**
 * Opening the database, and running migrations against it.
 *
 * SQLite because the whole backup story is "copy the file" (§2), and
 * better-sqlite3 because it is synchronous: every query in this app is a
 * local file read, and pretending otherwise buys nothing.
 *
 * The pragmas are not decoration. `foreign_keys` is off by default in SQLite,
 * which would make every `references()` in `schema.ts` a comment; BUILD-PLAN
 * 2.1 asks for them on, and §7's soft-delete rule assumes the graph stays
 * whole.
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { dirname } from 'node:path';

import { defaultDbPath, ensureDir, migrationsDir } from './paths.js';
import * as schema from './schema.js';

export type Schema = typeof schema;

/** A Drizzle handle over `schema.ts`. */
export type ShopQuoteDatabase = ReturnType<typeof drizzle<Schema>>;

/** The Drizzle handle plus the raw connection, which migrations and `VACUUM`
 *  need, and a `close()` that tests can call in `afterEach`. */
export interface DatabaseHandle {
  db: ShopQuoteDatabase;
  sqlite: Database.Database;
  /** Absolute path, or `:memory:`. */
  path: string;
  close(): void;
}

export interface OpenOptions {
  /** Defaults to `SHOPQUOTE_DB_PATH`, else `<repo>/data/shopquote.db`. Pass
   *  `':memory:'` for a test database. */
  path?: string;
  /** Fail instead of creating a new file. Used by commands that should be
   *  operating on an existing, migrated database. */
  mustExist?: boolean;
}

/**
 * Open (and create if needed) the database, with the pragmas this app relies
 * on:
 *
 *   - `foreign_keys = ON` — SQLite defaults this off, per connection.
 *   - `journal_mode = WAL` — a reader (the PDF renderer) does not block the
 *     estimator's next autosave. Ignored for `:memory:`.
 *   - `synchronous = NORMAL` — the safe pairing with WAL: a crash can lose the
 *     last transaction, a power cut cannot corrupt the file.
 *   - `busy_timeout` — the API and the nightly backup do overlap.
 */
export function openDatabase(options: OpenOptions = {}): DatabaseHandle {
  const path = options.path ?? defaultDbPath();
  if (path !== ':memory:') ensureDir(dirname(path));

  const sqlite = new Database(path, options.mustExist === true ? { fileMustExist: true } : {});
  sqlite.pragma('foreign_keys = ON');
  if (path !== ':memory:') sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('busy_timeout = 5000');

  const db = drizzle(sqlite, { schema });
  return {
    db,
    sqlite,
    path,
    close: () => sqlite.close(),
  };
}

/** Apply every migration in `packages/db/drizzle` that has not run yet. */
export function runMigrations(handle: DatabaseHandle): void {
  migrate(handle.db, { migrationsFolder: migrationsDir });
}

/** Open a fresh in-memory database with the schema already applied. Tests use
 *  this; so does anything that wants to price without touching disk. */
export function openMigratedMemoryDatabase(): DatabaseHandle {
  const handle = openDatabase({ path: ':memory:' });
  runMigrations(handle);
  return handle;
}
