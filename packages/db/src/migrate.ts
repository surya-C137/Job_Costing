/**
 * `npm run db:migrate` — apply every migration in `packages/db/drizzle`.
 *
 * The migrations themselves are generated from `schema.ts` by
 * `npm run db:generate` (drizzle-kit) and committed; this only runs them.
 * Applying an already-applied migration is a no-op, so the command is safe to
 * run on every deploy — which is what `deploy/` will do at Task 5.1.
 */

import { parseArgs } from 'node:util';

import { fail, isEntryPoint } from './cli.js';
import { openDatabase, runMigrations } from './db.js';

export function migrateCommand(argv: string[] = process.argv.slice(2)): number {
  const { values } = parseArgs({
    args: argv,
    options: { db: { type: 'string' } },
    allowPositionals: false,
  });

  const handle = openDatabase(values.db === undefined ? {} : { path: values.db });
  try {
    runMigrations(handle);
    const tables = handle.sqlite
      .prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'`)
      .get() as { n: number };
    console.log(`Migrated ${handle.path}`);
    console.log(`${tables.n} tables present, foreign keys on.`);
    return 0;
  } finally {
    handle.close();
  }
}

if (isEntryPoint(import.meta.url)) {
  let code = 0;
  try {
    code = migrateCommand();
  } catch (error) {
    code = fail(error);
  }
  process.exit(code);
}
