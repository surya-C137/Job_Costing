/**
 * The contributor interface — REQUIREMENTS §12 rule 5.
 *
 * The roll-up (§5.6) sums *cost contributors*. It knows a contributor has a
 * bucket and a markup class, and nothing else: it never imports a sheet-metal
 * module, never checks whether a machine is a laser, and never grows a branch
 * when a shop takes up a new process.
 *
 * That is what §12 rule 2 buys. Sheet-metal nesting, laser, punch and brake
 * are the first implementations; a machining shop registers different ones
 * against the same interface and reuses the whole roll-up, the whole UI and
 * the whole deployment.
 */

import type { ShopConfig } from './config.js';
import type { PartInput, QuoteInput } from './part.js';
import type { ContributorResult, CostBucket, MarkupClass } from './result.js';

/** What every contributor is handed. */
export interface ContributorInput {
  /** The part being priced. */
  part: PartInput;
  /** Its quote, for customer flags and the break list. */
  quote: QuoteInput;
}

/**
 * One line of cost. Implementations are pure: same input, same config, same
 * quantity, same answer — no clock, no I/O, no shared mutable state.
 */
export interface CostContributor {
  /**
   * Stable module id, namespaced by trade so two trades can define a
   * "nesting" without colliding: `sheetMetal.nesting`, `sheetMetal.laser`,
   * `machining.turning`. A shop's `enabledModules` lists these.
   */
  readonly id: string;
  /** Which side of the roll-up this lands on (§5.6). */
  readonly bucket: CostBucket;
  /** Which markup it takes. `none` is quirk Q4's unmarked bucket. */
  readonly markupClass: MarkupClass;
  /**
   * Cost for one part at this quantity.
   *
   * @param input the part and its quote
   * @param config the shop's frozen configuration
   * @param qty the quantity break being priced
   */
  compute(input: ContributorInput, config: ShopConfig, qty: number): ContributorResult;
}
