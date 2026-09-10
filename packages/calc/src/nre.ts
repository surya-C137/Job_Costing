/**
 * Non-recurring engineering — REQUIREMENTS §5.6.
 *
 * Programming, fixturing, first-article inspection: bought once, spread over
 * the run. Priced at the shop's NRE rate and its own markup, then amortised.
 *
 * **NRE ends up marked up twice, and that is what §5.6 says.** The section
 * puts NRE inside `fixed_cost`, and `fixed_cost` takes the labor markup with
 * everything else in that block — so a 1.3 NRE markup on a 1.2 labor markup
 * compounds to 1.56. The golden case has no NRE, so the oracle cannot settle
 * it either way.
 *
 * Reproduced as written rather than quietly corrected, on the same grounds as
 * quirks Q1 and Q2: the workbook's arithmetic is the starting point and the
 * owner decides what changes. It is REQUIREMENTS §10 question 11, and if the
 * answer is "once", deleting `× nreMarkup` below is the whole fix.
 */

import type { ShopConfig } from './types/config.js';
import type { ContributorInput, CostContributor } from './types/contributor.js';
import type { ContributorResult } from './types/result.js';

/** NRE for the whole job, $ — hours at the NRE rate, with the NRE markup. */
export function nreCostUsd(input: ContributorInput, config: ShopConfig): number {
  const hours = input.part.nre.reduce((total, line) => total + line.hours, 0);
  return hours * config.defaults.nreRatePerHrUsd * config.defaults.nreMarkup;
}

/**
 * NRE, amortised over the quantity.
 *
 * Lands in the `fixed` bucket alongside setup, which is where §5.6 puts it —
 * the estimator sees one "fixed cost" line covering setup, the shop's flat
 * charge and NRE, exactly as the workbook's row 13 did.
 */
export const nreContributor: CostContributor = {
  id: 'sheetMetal.nre',
  bucket: 'fixed',
  markupClass: 'labor',

  compute(input: ContributorInput, config: ShopConfig, qty: number): ContributorResult {
    const perJob = nreCostUsd(input, config);
    return {
      usdPerPart: qty > 0 ? perJob / qty : 0,
      warnings: [],
      detail: { nreUsdPerJob: perJob },
    };
  },
};
