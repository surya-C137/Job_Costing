import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openDatabase } from '../src/db.js';
import { migrateCommand } from '../src/migrate.js';
import { defaultDbPath } from '../src/paths.js';
import { materials, shops } from '../src/schema.js';
import { seedBlankCommand } from '../src/seed-blank.js';
import { seedCommand } from '../src/seed.js';

/**
 * BUILD-PLAN 2.1's acceptance check, as a test:
 *
 *     npm run db:migrate && npm run db:seed  →  a database with ≥ 80 materials
 *     and an operations table
 *
 * The commands are run against a temporary file rather than `data/`, but they
 * are the same functions the npm scripts call — including the summary output,
 * because a seed that prints nothing is a seed you cannot tell from a no-op.
 */
describe('command line', () => {
  let dir: string;
  let logged: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shopquote-db-'));
    logged = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
    // Keeps a generated bootstrap password out of the test output.
    process.env['SHOPQUOTE_ADMIN_PASSWORD'] = 'test-password';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env['SHOPQUOTE_ADMIN_PASSWORD'];
    rmSync(dir, { recursive: true, force: true });
  });

  it('migrates then seeds, and reports what it wrote', () => {
    const path = join(dir, 'shopquote.db');

    expect(migrateCommand(['--db', path])).toBe(0);
    expect(existsSync(path)).toBe(true);
    expect(logged.join('\n')).toMatch(/tables present, foreign keys on/);

    logged.length = 0;
    expect(seedCommand(['--db', path])).toBe(0);

    const handle = openDatabase({ path, mustExist: true });
    try {
      expect(handle.db.select().from(materials).all().length).toBeGreaterThanOrEqual(80);
      expect(handle.db.select().from(shops).all()).toHaveLength(1);
    } finally {
      handle.close();
    }

    const output = logged.join('\n');
    expect(output).toMatch(/materials\s+80/);
    expect(output).toMatch(/operations\s+20/);
    // The prices are dated, and the gap is stated rather than hidden.
    expect(output).toContain('2023-01-01');
    expect(output).toMatch(/have no price at all/);
    expect(output).toContain('Admin user: admin');
    expect(output).not.toContain('test-password');
  });

  it('seeds without a prior migrate — the migration runs either way', () => {
    const path = join(dir, 'direct.db');
    expect(seedCommand(['--db', path])).toBe(0);
    expect(existsSync(path)).toBe(true);
  });

  it('refuses a second seed into the same database', () => {
    const path = join(dir, 'twice.db');
    expect(seedCommand(['--db', path])).toBe(0);
    expect(() => seedCommand(['--db', path])).toThrow(/already holds 1 shop/);
  });

  it('creates a blank shop with a name and unit system of its own', () => {
    const path = join(dir, 'blank.db');
    expect(
      seedBlankCommand(['--db', path, '--shop-name', 'Second Shop', '--unit-system', 'metric']),
    ).toBe(0);

    const handle = openDatabase({ path, mustExist: true });
    try {
      const shop = handle.db.select().from(shops).get();
      expect(shop?.name).toBe('Second Shop');
      expect(shop?.unitSystem).toBe('metric');
      expect(handle.db.select().from(materials).all()).toHaveLength(0);
    } finally {
      handle.close();
    }
    expect(logged.join('\n')).toMatch(/Empty on purpose/);
  });

  it('rejects a unit system that is neither imperial nor metric', () => {
    expect(() =>
      seedBlankCommand(['--db', join(dir, 'bad.db'), '--unit-system', 'furlongs']),
    ).toThrow(/imperial.*metric/);
  });

  it('puts the database under the repo data directory unless told otherwise', () => {
    const previous = process.env['SHOPQUOTE_DB_PATH'];
    const previousDir = process.env['SHOPQUOTE_DATA_DIR'];
    try {
      delete process.env['SHOPQUOTE_DB_PATH'];
      delete process.env['SHOPQUOTE_DATA_DIR'];
      // Not `packages/db/data/` — npm runs a workspace script with the package
      // as its working directory, which is exactly the trap `paths.ts` avoids.
      expect(defaultDbPath()).toMatch(/[\\/]data[\\/]shopquote\.db$/);
      expect(defaultDbPath()).not.toMatch(/packages[\\/]db[\\/]data/);

      process.env['SHOPQUOTE_DATA_DIR'] = dir;
      expect(defaultDbPath()).toBe(join(dir, 'shopquote.db'));

      process.env['SHOPQUOTE_DB_PATH'] = join(dir, 'elsewhere.db');
      expect(defaultDbPath()).toBe(join(dir, 'elsewhere.db'));
    } finally {
      if (previous === undefined) delete process.env['SHOPQUOTE_DB_PATH'];
      else process.env['SHOPQUOTE_DB_PATH'] = previous;
      if (previousDir === undefined) delete process.env['SHOPQUOTE_DATA_DIR'];
      else process.env['SHOPQUOTE_DATA_DIR'] = previousDir;
    }
  });
});
