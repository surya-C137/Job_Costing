/**
 * Bought parts — REQUIREMENTS §5.6.
 *
 * Pems, standoffs, bumpers, tie wraps: whatever the shop buys and fits. Part
 * of the material block, so it takes the material markup.
 *
 * Deliberately not a catalog. A hardware line is a description, a count and a
 * unit cost the estimator got from a distributor that morning; a shop that
 * wants a catalog of its own can add one later without this changing.
 */

import type { ShopConfig } from './types/config.js';
import type { ContributorInput, CostContributor } from './types/contributor.js';
import type { ContributorResult } from './types/result.js';

/** Bought-part cost for one part, $ (§5.6). */
export function hardwareUsdPerPart(input: ContributorInput): number {
  return input.part.hardware.reduce(
    (total, line) => total + line.qtyPerPart * line.unitCostUsd,
    0,
  );
}

export const hardwareContributor: CostContributor = {
  id: 'sheetMetal.hardware',
  bucket: 'hardware',
  markupClass: 'material',

  compute(input: ContributorInput): ContributorResult {
    const usdPerPart = hardwareUsdPerPart(input);
    return {
      usdPerPart,
      warnings: [],
      detail: { lines: input.part.hardware.length },
    };
  },
};

/**
 * Material extras — §5.6's `sheet_extras`. Freight-in, cut-to-size charges,
 * drop penalties: costs that attach to the stock rather than to the cutting.
 * Entered per part by the estimator; part of the material block.
 */
export const materialExtrasContributor: CostContributor = {
  id: 'sheetMetal.materialExtras',
  bucket: 'materialExtras',
  markupClass: 'material',

  compute(input: ContributorInput, _config: ShopConfig): ContributorResult {
    return { usdPerPart: input.part.materialExtrasUsd ?? 0, warnings: [] };
  },
};
