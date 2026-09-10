import { describe, expect, it } from 'vitest';

import { openMigratedMemoryDatabase } from '../src/db.js';
import { materials, shops } from '../src/schema.js';

/**
 * The schema's own guarantees (REQUIREMENTS §3, §7) — the ones a later task
 * would otherwise discover the hard way, on a shop's real data.
 */
describe('schema', () => {
  it('migrates cleanly and creates every table the domain model needs', () => {
    const handle = openMigratedMemoryDatabase();
    try {
      const names = handle.sqlite
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
        .all()
        .map((r) => (r as { name: string }).name);

      // REQUIREMENTS §3's domain model, table by table, as BUILD-PLAN 2.1 lists
      // it. `config_snapshots` is the one addition — see schema.ts for why the
      // config a quote was priced with is content-addressed rather than copied
      // into every autosave.
      for (const table of [
        'shops',
        'users',
        'sessions',
        'material_families',
        'gauge_reference',
        'materials',
        'material_prices',
        'stock_sizes',
        'machines',
        'machine_material_rates',
        'punch_hit_rates',
        'operations',
        'plating_specs',
        'coating_models',
        'silkscreen_tiers',
        'assembly_standards',
        'intake_aliases',
        'customers',
        'parts',
        'quotes',
        'quote_lines',
        'quote_versions',
        'config_snapshots',
        'attachments',
        'audit_log',
      ]) {
        expect(names, `${table} is missing`).toContain(table);
      }
    } finally {
      handle.close();
    }
  });

  it('has no process_presets table — §3 replaced presets with work centres', () => {
    const handle = openMigratedMemoryDatabase();
    try {
      const found = handle.sqlite
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'process_presets'`)
        .get();
      expect(found).toBeUndefined();
    } finally {
      handle.close();
    }
  });

  it('enforces foreign keys, which SQLite leaves off by default', () => {
    const handle = openMigratedMemoryDatabase();
    try {
      expect(handle.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(() =>
        handle.db
          .insert(materials)
          .values({
            shopId: 'no-such-shop',
            name: 'Orphan',
            familyId: 'no-such-family',
            lbPerSqFt: 1,
          })
          .run(),
      ).toThrow(/FOREIGN KEY/i);
    } finally {
      handle.close();
    }
  });

  it('gives every row a ULID and both timestamps without being asked', () => {
    const handle = openMigratedMemoryDatabase();
    try {
      const before = Date.now();
      const row = handle.db
        .insert(shops)
        .values({
          name: 'Timestamp Test',
          defaultQuantityBreaks: [1, 10],
          laborMarkup: 1,
          materialMarkup: 1,
          nreRatePerHrUsd: 0,
          nreMarkup: 1,
          minChargeStripIn: 0,
          enabledModules: [],
        })
        .returning()
        .get();

      // ULID: 26 characters of Crockford base32, lexicographically sortable.
      expect(row.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(row.updatedAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(row.archivedAt).toBeNull();
      // JSON columns come back as values, not strings.
      expect(row.defaultQuantityBreaks).toEqual([1, 10]);
    } finally {
      handle.close();
    }
  });

  it('keeps parity flags as columns, defaulting to the workbook (§5.7)', () => {
    const handle = openMigratedMemoryDatabase();
    try {
      const row = handle.db
        .insert(shops)
        .values({
          name: 'Parity Defaults',
          defaultQuantityBreaks: [1],
          laborMarkup: 1.2,
          materialMarkup: 1.2,
          nreRatePerHrUsd: 100,
          nreMarkup: 1.3,
          minChargeStripIn: 12,
          enabledModules: [],
        })
        .returning()
        .get();

      expect(row.parityMarkupInsideMinChargeMax).toBe(true);
      expect(row.parityMachineTimeFactor).toBe(0.6);
      expect(row.parityLegacyCoatingModel).toBe(true);
      expect(row.parityFinishesUnmarked).toBe(true);
    } finally {
      handle.close();
    }
  });
});
