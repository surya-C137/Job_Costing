import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { seedDir } from '../src/paths.js';
import { readSeedBundle } from '../src/seed-files.js';

/**
 * The seed files are a boundary — a Python script's output becoming typed
 * objects — and CLAUDE.md puts Zod on every boundary. The point is not
 * ceremony: a bad extractor run has to fail here, naming the file and the
 * field, rather than three tasks later as a catalog that prices wrong.
 *
 * This was not hypothetical. The check found `price_per_lb: null` on fourteen
 * materials that calc's `SeedMaterial` declared non-nullable, which would have
 * put a `null` typed as `number` into every one of their blank costs.
 */
describe('reading the workbook extract', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shopquote-seed-'));
    cpSync(seedDir, dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads the committed seed and gets every table', () => {
    const bundle = readSeedBundle();
    expect(bundle.materials.length).toBeGreaterThanOrEqual(80);
    expect(bundle.machines).toHaveLength(2);
    expect(bundle.punchTools.tools).toHaveLength(10);
    expect(bundle.defaults.default_qty_breaks).toEqual([1, 5, 10, 30, 50, 100]);
  });

  it('keeps a missing price missing rather than reading it as zero', () => {
    const unpriced = readSeedBundle().materials.filter((m) => m.price_per_lb === null);
    expect(unpriced.length).toBeGreaterThan(0);
    expect(unpriced.every((m) => m.name.startsWith('ST STL #4B'))).toBe(true);
  });

  it('names the file and the field when a seed file is the wrong shape', () => {
    writeFileSync(
      join(dir, 'materials.json'),
      JSON.stringify([{ key: 'x', name: 'X', family: 'steel', lb_per_sq_ft: 'heavy' }]),
      'utf8',
    );
    expect(() => readSeedBundle(dir)).toThrow(/materials\.json/);
    expect(() => readSeedBundle(dir)).toThrow(/lb_per_sq_ft/);
    expect(() => readSeedBundle(dir)).toThrow(/extract-workbook/);
  });

  it('says which file it could not read at all', () => {
    writeFileSync(join(dir, 'shop_defaults.json'), '{ not json', 'utf8');
    expect(() => readSeedBundle(dir)).toThrow(/shop_defaults\.json/);
  });
});
