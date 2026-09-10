import { describe, expect, it } from 'vitest';

import { builtInContributors, createRegistry, defaultRegistry } from '../src/registry.js';
import type { CostContributor } from '../src/types/contributor.js';
import { inToMm, mmToIn } from '../src/units.js';

/**
 * REQUIREMENTS §12 rule 5. What these tests are really guarding is that the
 * roll-up can be written against the interface alone — that a shop's enabled
 * modules decide what gets summed, and that an id nobody implements surfaces
 * rather than pricing as zero (§12 rule 3).
 */

const stub = (id: string): CostContributor => ({
  id,
  bucket: 'labor',
  markupClass: 'labor',
  compute: () => ({ usdPerPart: 1, warnings: [] }),
});

describe('contributor registry (§12)', () => {
  it('ships the sheet-metal nesting module', () => {
    expect(defaultRegistry.ids()).toContain('sheetMetal.nesting');
    expect(defaultRegistry.get('sheetMetal.nesting')?.bucket).toBe('material');
  });

  it('resolves a shop\u2019s enabled modules in the order listed', () => {
    const registry = createRegistry([stub('a.one'), stub('a.two')]);
    const { contributors, unknown } = registry.resolve(['a.two', 'a.one']);
    expect(contributors.map((c) => c.id)).toEqual(['a.two', 'a.one']);
    expect(unknown).toEqual([]);
  });

  it('reports enabled ids no build provides instead of silently dropping them', () => {
    const { contributors, unknown } = defaultRegistry.resolve([
      'sheetMetal.nesting',
      'machining.turning',
    ]);
    expect(contributors.map((c) => c.id)).toEqual(['sheetMetal.nesting']);
    expect(unknown).toEqual(['machining.turning']);
  });

  it('refuses two contributors with the same id', () => {
    expect(() => createRegistry([stub('dup'), stub('dup')])).toThrow(/Duplicate/);
  });

  it('lets another trade build a registry without touching this one', () => {
    const other = createRegistry([stub('millwork.panel')]);
    expect(other.ids()).toEqual(['millwork.panel']);
    expect(defaultRegistry.ids()).toEqual(builtInContributors.map((c) => c.id));
  });

  it('returns undefined for an unknown id rather than a default contributor', () => {
    expect(defaultRegistry.get('nope.missing')).toBeUndefined();
  });
});

describe('unit conversion at the edge (CLAUDE.md)', () => {
  it('round-trips inches through millimetres', () => {
    expect(inToMm(1)).toBe(25.4);
    expect(mmToIn(25.4)).toBe(1);
    expect(mmToIn(inToMm(13.38))).toBeCloseTo(13.38, 10);
  });
});
