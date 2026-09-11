import { beforeAll, describe, expect, it } from 'vitest';

import type { ShopConfig } from '@shopquote/calc';

import { loadShopConfig } from '../src/config.js';
import { shopConfigSchema } from '../src/config-schema.js';
import { openMigratedMemoryDatabase } from '../src/db.js';
import { seedBlankShop } from '../src/seed-blank.js';
import { seedWorkbookShop } from '../src/seed.js';

/**
 * The config JSON's schema (§8). Two things to prove: that every config this
 * app produces passes it — the seeded workbook shop and a blank one — and that
 * the mistakes a person editing the file actually makes are caught with the
 * path of the row, before `writeShopConfig()` could half-apply them.
 */

let workbook: ShopConfig;
let blank: ShopConfig;

beforeAll(async () => {
  const a = openMigratedMemoryDatabase();
  workbook = loadShopConfig(a.db, (await seedWorkbookShop(a, { adminPassword: 'x' })).shopId);
  const b = openMigratedMemoryDatabase();
  blank = loadShopConfig(b.db, (await seedBlankShop(b, { adminPassword: 'x' })).shopId);
});

function issuesOf(config: unknown): string[] {
  const parsed = shopConfigSchema.safeParse(config);
  return parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
}

/** A copy of the workbook config with one mistake in it. */
function withMistake(mistake: (config: ShopConfig) => void): ShopConfig {
  const config = structuredClone(workbook);
  mistake(config);
  return config;
}

describe('shopConfigSchema', () => {
  it('passes every config this app makes', () => {
    expect(issuesOf(workbook)).toEqual([]);
    expect(issuesOf(blank)).toEqual([]);
  });

  it('names the row whose reference goes nowhere', () => {
    const config = withMistake((c) => {
      const first = c.materials[0];
      if (first !== undefined) first.familyId = 'nope';
    });
    expect(issuesOf(config)).toContain(
      'materials.0.familyId: No material family "nope" in this config.',
    );
  });

  it('refuses one id used twice, even across lists', () => {
    const config = withMistake((c) => {
      const family = c.families[0];
      const material = c.materials[0];
      if (family !== undefined && material !== undefined) material.id = family.id;
    });
    expect(issuesOf(config).some((i) => i.startsWith('materials.0.id: The id'))).toBe(true);
  });

  it('refuses a zero where calc divides', () => {
    const config = withMistake((c) => {
      const machine = c.machines[0];
      if (machine !== undefined) machine.lossFactor = 0;
    });
    expect(issuesOf(config).some((i) => i.startsWith('machines.0.lossFactor:'))).toBe(true);
  });

  it('catches the workbook’s ×60 typed in as the Q2 factor (§5.4)', () => {
    const config = withMistake((c) => {
      c.parity.machineTimeFactor = 60;
    });
    expect(issuesOf(config).some((i) => i.startsWith('parity.machineTimeFactor:'))).toBe(true);
  });

  it('refuses a cost module this build does not ship (§12 rule 3)', () => {
    const config = withMistake((c) => {
      c.enabledModules.push('sheetMetal.teleport');
    });
    const issues = issuesOf(config);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(
      /^enabledModules\.\d+: This build has no cost module "sheetMetal.teleport"/,
    );
  });

  it('wants quantity breaks in increasing order', () => {
    const config = withMistake((c) => {
      c.defaults.defaultQuantityBreaks = [5, 1];
    });
    expect(issuesOf(config).some((i) => i.startsWith('defaults.defaultQuantityBreaks:'))).toBe(
      true,
    );
  });

  it('refuses a field it does not know — a typo is not a new setting', () => {
    const config = withMistake((c) => {
      (c.defaults as unknown as Record<string, unknown>)['labourMarkup'] = 1.3;
    });
    expect(issuesOf(config).some((i) => i.includes("'labourMarkup'"))).toBe(true);
  });

  it('refuses two materials with one name, as the database would', () => {
    const config = withMistake((c) => {
      const [first, second] = c.materials;
      if (first !== undefined && second !== undefined) second.name = first.name;
    });
    expect(issuesOf(config).some((i) => i.startsWith('materials.1.name: Two materials'))).toBe(
      true,
    );
  });
});
