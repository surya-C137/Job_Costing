/**
 * The roll-up — REQUIREMENTS §5.6, and the engine's front door.
 *
 * ```
 * material_block = (material + extras + hardware + plating) × material_markup
 * labor_block    = (fixed ÷ qty + direct labor)             × labor_markup
 * unmarked       = coating + silkscreen                     (quirk Q4)
 * selling        = material_block + labor_block + unmarked
 * mtl_pct_sp     = material ÷ selling
 * ```
 *
 * **The order is load-bearing.** Coating and silkscreen are added *after* the
 * markups, not inside them. Rearranging the arithmetic changes every price in
 * the §9 table, which is why quirk Q4 exists as a flag rather than as a
 * comment.
 *
 * This file imports no sheet-metal module (§12 rule 5). It walks the shop's
 * `enabledModules` through a registry, and knows only that a contributor has a
 * bucket to sit in and a markup class to take. A machining shop registers a
 * different set and reuses every line of this.
 */

import { defaultRegistry, type ContributorRegistry } from './registry.js';
import type { ShopConfig } from './types/config.js';
import type { ContributorInput, CostContributor } from './types/contributor.js';
import type {
  CostBucket,
  CostStack,
  MarkupClass,
  PartResult,
  QuoteResult,
  Warning,
} from './types/result.js';
import { materialParamsFor, nest } from './material.js';

/** An empty line for every bucket, so a stack always has every field. */
function emptyBuckets(): Record<CostBucket, number> {
  return {
    material: 0,
    materialExtras: 0,
    hardware: 0,
    plating: 0,
    fixed: 0,
    labor: 0,
    coating: 0,
    silkscreen: 0,
  };
}

/** Price one part at one quantity by summing its contributors (§5.6). */
export function costStackAt(
  input: ContributorInput,
  config: ShopConfig,
  qty: number,
  contributors: readonly CostContributor[],
): CostStack {
  const buckets = emptyBuckets();
  const blocks: Record<MarkupClass, number> = { material: 0, labor: 0, none: 0 };
  const warnings: Warning[] = [];

  for (const contributor of contributors) {
    const result = contributor.compute(input, config, qty);
    buckets[contributor.bucket] += result.usdPerPart;
    blocks[contributor.markupClass] += result.usdPerPart;
    warnings.push(...result.warnings);
  }

  const materialBlockUsd = blocks.material * config.defaults.materialMarkup;
  const laborBlockUsd = blocks.labor * config.defaults.laborMarkup;
  const unmarkedUsd = blocks.none;
  const sellingPriceUsd = materialBlockUsd + laborBlockUsd + unmarkedUsd;

  return {
    quantity: qty,
    materialUsd: buckets.material,
    materialExtrasUsd: buckets.materialExtras,
    hardwareUsd: buckets.hardware,
    platingUsd: buckets.plating,
    materialBlockUsd,
    fixedUsd: buckets.fixed,
    directLaborUsd: buckets.labor,
    laborBlockUsd,
    coatingUsd: buckets.coating,
    silkscreenUsd: buckets.silkscreen,
    sellingPriceUsd,
    // The estimator's headline ratio: share-of-blank material against the
    // price, not the whole material block (§5.6).
    materialPctOfSelling: sellingPriceUsd > 0 ? buckets.material / sellingPriceUsd : 0,
    warnings,
  };
}

/**
 * Price one part across every quantity break.
 *
 * Warnings are de-duplicated across breaks: "the minimum charge applied" is
 * worth saying once with the quantities named, not six times.
 */
export function priceParts(
  input: ContributorInput,
  config: ShopConfig,
  quantityBreaks: readonly number[],
  contributors: readonly CostContributor[],
): PartResult {
  const breaks = quantityBreaks.map((qty) => costStackAt(input, config, qty, contributors));

  const seen = new Set<string>();
  const warnings: Warning[] = [];
  for (const stack of breaks) {
    for (const warning of stack.warnings) {
      const key = `${warning.code}:${warning.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      warnings.push(warning);
    }
  }

  const params = materialParamsFor(input, config);
  const nesting = params.ok
    ? nest(params.value)
    : { partsPerBlank: 0, across: 0, down: 0, orientation: 'length' as const, yieldPct: 0, fits: false };

  return { partId: input.part.id, nesting, breaks, warnings };
}

/**
 * Price a quote.
 *
 * The engine's entry point: a `ShopConfig`, a `QuoteInput`, and out comes a
 * cost stack per part per quantity. Pure — the same three arguments give the
 * same answer forever, which is what lets a quote store the config it was
 * priced with and be reproduced years later (§7).
 *
 * @param quote what the estimator entered
 * @param config the shop's configuration, frozen into the quote on save
 * @param registry which modules exist in this build; defaults to all of them
 */
export function computeQuote(
  quote: Parameters<typeof priceParts>[0]['quote'],
  config: ShopConfig,
  registry: ContributorRegistry = defaultRegistry,
): QuoteResult {
  const { contributors, unknown } = registry.resolve(config.enabledModules);

  const warnings: Warning[] = unknown.map((id) => ({
    code: 'missing-standard',
    message: `This shop has module ${id} switched on, but this build does not provide it.`,
  }));

  const quantityBreaks =
    quote.quantityBreaks.length > 0
      ? quote.quantityBreaks
      : config.defaults.defaultQuantityBreaks;

  const parts = quote.parts.map((part) =>
    priceParts({ part, quote }, config, quantityBreaks, contributors),
  );

  return { parts, warnings };
}
