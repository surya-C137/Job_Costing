import { describe, expect, it } from 'vitest';

import { hardwareContributor, materialExtrasContributor } from '../src/hardware.js';
import { nreContributor, nreCostUsd } from '../src/nre.js';
import { createRegistry } from '../src/registry.js';
import { computeQuote, costStackAt } from '../src/rollup.js';
import { machineId, materialId, operationId, shopConfigFromSeed } from '../src/seed.js';
import type { PartInput, QuoteInput } from '../src/types/part.js';
import golden from './fixtures/golden-workbook.json' with { type: 'json' };
import { seedBundle } from './helpers/seed-bundle.js';

/** REQUIREMENTS §5.6 and §12 rule 5. */

const config = shopConfigFromSeed(seedBundle());

function part(overrides: Partial<PartInput> = {}): PartInput {
  return {
    id: 'part-rollup',
    partNumber: 'ROLLUP-TEST',
    materialId: materialId('g30-16-ga-0598'),
    flatLengthIn: golden.part.flat_length_in,
    flatWidthIn: golden.part.flat_width_in,
    nesting: {
      machineId: machineId('laser'),
      stockWidthIn: golden.nesting.stock_width_in,
      blankLengthIn: golden.nesting.blank_length_in,
    },
    cutting: { model: 'none' },
    operations: [],
    finish: {},
    hardware: [],
    nre: [],
    ...overrides,
  };
}

const quoteOf = (p: PartInput, breaks = [1, 100]): QuoteInput => ({
  parts: [p],
  quantityBreaks: breaks,
});
const inputFor = (p: PartInput) => ({ part: p, quote: quoteOf(p) });

describe('hardware and material extras (§5.6)', () => {
  it('sums bought parts at their line quantities', () => {
    const p = part({
      hardware: [
        { description: 'PEM stud', qtyPerPart: 4, unitCostUsd: 0.12 },
        { description: 'Bumper', qtyPerPart: 2, unitCostUsd: 0.05 },
      ],
    });
    expect(hardwareContributor.compute(inputFor(p), config, 10).usdPerPart).toBeCloseTo(0.58, 10);
  });

  it('takes the material extras line straight through', () => {
    const p = part({ materialExtrasUsd: 1.25 });
    expect(materialExtrasContributor.compute(inputFor(p), config, 10).usdPerPart).toBe(1.25);
    expect(materialExtrasContributor.compute(inputFor(part()), config, 10).usdPerPart).toBe(0);
  });

  it('both take the material markup, being part of that block', () => {
    expect(hardwareContributor.markupClass).toBe('material');
    expect(materialExtrasContributor.markupClass).toBe('material');
  });
});

describe('NRE (§5.6)', () => {
  const p = part({ nre: [{ description: 'Program', hours: 2 }] });

  it('prices hours at the NRE rate and its own markup', () => {
    // 2 h x $100 x 1.3 -- and then the labor markup again, per §5.6. See nre.ts.
    expect(nreCostUsd(inputFor(p), config)).toBeCloseTo(2 * 100 * 1.3, 6);
  });

  it('amortises over the quantity', () => {
    expect(nreContributor.compute(inputFor(p), config, 1).usdPerPart).toBeCloseTo(260, 6);
    expect(nreContributor.compute(inputFor(p), config, 100).usdPerPart).toBeCloseTo(2.6, 6);
  });

  it('prices nothing at a quantity of zero rather than dividing by it', () => {
    expect(nreContributor.compute(inputFor(p), config, 0).usdPerPart).toBe(0);
  });

  it('lands in the fixed bucket beside setup, as §5.6 puts it', () => {
    expect(nreContributor.bucket).toBe('fixed');
  });
});

describe('the roll-up itself (§5.6)', () => {
  it('applies each markup to its own block and leaves the finish alone', () => {
    const p = part({
      materialExtrasUsd: 1,
      hardware: [{ description: 'Nut', qtyPerPart: 1, unitCostUsd: 2 }],
    });
    const stack = costStackAt(inputFor(p), config, 100, [
      materialExtrasContributor,
      hardwareContributor,
    ]);
    expect(stack.materialBlockUsd).toBeCloseTo(3 * config.defaults.materialMarkup, 10);
    expect(stack.sellingPriceUsd).toBeCloseTo(stack.materialBlockUsd, 10);
  });

  it('reports material as a share of the selling price, not of the block', () => {
    const stack = costStackAt(inputFor(part()), config, 100, []);
    expect(stack.materialPctOfSelling).toBe(0);
  });

  it('falls back to the shop default breaks when the quote names none', () => {
    const result = computeQuote({ parts: [part()], quantityBreaks: [] }, config);
    expect(result.parts[0]?.breaks.map((b) => b.quantity)).toEqual(
      config.defaults.defaultQuantityBreaks,
    );
  });

  it('reports a part that does not fit without failing the quote', () => {
    const tooBig = part({ flatLengthIn: 60, flatWidthIn: 60 });
    const result = computeQuote(quoteOf(tooBig), config);
    expect(result.parts[0]?.nesting.fits).toBe(false);
    expect(result.parts[0]?.warnings.map((w) => w.code)).toContain('part-does-not-fit');
  });

  it('reports a nest of nothing when the material is not in the catalog', () => {
    const orphan = part({ materialId: 'material:nope' });
    const result = computeQuote(quoteOf(orphan), config);
    expect(result.parts[0]?.nesting.partsPerBlank).toBe(0);
  });

  it('says so when a shop has a module switched on that this build lacks', () => {
    const future = { ...config, enabledModules: [...config.enabledModules, 'machining.turning'] };
    const result = computeQuote(quoteOf(part()), future);
    expect(result.warnings[0]?.message).toContain('machining.turning');
  });

  it('sums only the contributors a shop has switched on', () => {
    const materialOnly = { ...config, enabledModules: ['sheetMetal.nesting'] };
    const result = computeQuote(quoteOf(part()), materialOnly);
    const hundred = result.parts[0]?.breaks[1];
    expect(hundred?.directLaborUsd).toBe(0);
    expect(hundred?.fixedUsd).toBe(0);
    expect(hundred?.materialUsd).toBeGreaterThan(0);
  });

  it('runs a registry the caller supplies, so another trade reuses all of this', () => {
    const registry = createRegistry([
      {
        id: 'millwork.panel',
        bucket: 'material',
        markupClass: 'material',
        compute: () => ({ usdPerPart: 7, warnings: [] }),
      },
    ]);
    const millwork = { ...config, enabledModules: ['millwork.panel'] };
    const result = computeQuote(quoteOf(part()), millwork, registry);
    expect(result.parts[0]?.breaks[0]?.materialUsd).toBe(7);
    expect(result.parts[0]?.breaks[0]?.sellingPriceUsd).toBeCloseTo(7 * 1.2, 10);
  });

  it('says a warning once for the whole part, not once per break', () => {
    const tooBig = part({ flatLengthIn: 60, flatWidthIn: 60 });
    const result = computeQuote(quoteOf(tooBig, [1, 5, 10, 30, 50, 100]), config);
    const fitWarnings = result.parts[0]?.warnings.filter((w) => w.code === 'part-does-not-fit');
    expect(fitWarnings).toHaveLength(1);
  });

  it('prices every part on a multi-part quote', () => {
    const quote: QuoteInput = {
      parts: [part({ id: 'a' }), part({ id: 'b', flatLengthIn: 6, flatWidthIn: 4 })],
      quantityBreaks: [100],
    };
    const result = computeQuote(quote, config);
    expect(result.parts.map((p) => p.partId)).toEqual(['a', 'b']);
    expect(result.parts[1]?.nesting.partsPerBlank).toBeGreaterThan(
      result.parts[0]?.nesting.partsPerBlank ?? 0,
    );
  });

  it('keeps a bent part-s manual labour out of the machine factor', () => {
    const bent = part({
      operations: [{ operationId: operationId('brake-bend'), countPerPart: 4 }],
    });
    const result = computeQuote(quoteOf(bent), config);
    expect(result.parts[0]?.breaks[1]?.directLaborUsd).toBeCloseTo((4 / 222) * 75, 8);
  });
});
