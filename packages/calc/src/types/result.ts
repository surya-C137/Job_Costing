/**
 * What the engine gives back — `CostStack`, `QuoteResult`, warnings, and the
 * `Result` type calc uses instead of throwing.
 *
 * REQUIREMENTS §5.6 and §9. Every money field is **dollars for one part at
 * that quantity** unless its name says otherwise.
 */

/**
 * Expected failures are values, not exceptions (CLAUDE.md conventions).
 * "This part does not fit the sheet" is a thing that happens on a Tuesday, not
 * an exceptional condition.
 */
export type Result<T, E = CalcError> = { ok: true; value: T } | { ok: false; error: E };

/** Convenience constructor for the success arm. */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/** Convenience constructor for the failure arm. */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/** Why a cost could not be produced. */
export interface CalcError {
  /** Stable, machine-readable. The API maps these onto problem+json types. */
  code: CalcErrorCode;
  /** One sentence an estimator can act on. */
  message: string;
  /** Which part, when the quote has several. */
  partId?: string;
}

export type CalcErrorCode =
  /** The blank does not fit the stock in either orientation (§5.1). */
  | 'part-does-not-fit'
  /** A `PartInput` referenced an id that is not in this `ShopConfig`. */
  | 'unknown-reference'
  /** A number that has to be positive was zero or negative. */
  | 'invalid-input'
  /** No `MachineMaterialRate` for the chosen machine and material (§12 rule 3). */
  | 'missing-machine-material-rate';

/**
 * Something the estimator should see but that never blocks a price
 * (CLAUDE.md Design: warnings amber, never blocking).
 */
export interface Warning {
  code: WarningCode;
  /** One sentence, already naming the specific part or material. */
  message: string;
  partId?: string;
}

export type WarningCode =
  /** The minimum-charge strip set the material price, not the nest (§5.1). */
  | 'min-charge-applied'
  /** Less than half the blank ends up as parts. */
  | 'low-yield'
  /** The material row is switched off in Settings but still referenced. */
  | 'material-inactive'
  /** A non-RoHS finish on a customer flagged RoHS (§11.2). */
  | 'non-rohs-finish'
  /** A machine/material pairing has no rate; the estimator has to add one
   *  rather than have calc invent a default (§12 rule 3). */
  | 'missing-machine-material-rate'
  /** An operation's standard is missing or zero, so its hours are zero. */
  | 'missing-standard'
  /** The part's cutting input does not match the selected machine's time
   *  model — a punch hit counter against a laser, say (§5.2/§5.3). */
  | 'cutting-model-mismatch'
  /** A hit references a tool that is not on the selected machine. */
  | 'unknown-punch-tool'
  /** The machine-material pairing has a zero cutting speed or a zero punch
   *  rate factor: this machine cannot work this stock (§5.3). */
  | 'material-not-cuttable'
  /**
   * The blank does not fit the stock in either orientation (§5.1). A warning
   * rather than an error because CLAUDE.md's Design section says so: the
   * estimator sees amber and fixes the stock size, rather than an empty
   * screen. `materialForPart()` also returns it as a typed `Result` failure
   * for callers that need to refuse.
   */
  | 'part-does-not-fit';

/**
 * Which line of the cost stack a contributor's dollars land on. One bucket per
 * `CostStack` field, so placing a contributor is a lookup rather than a
 * decision — and so a new bucket cannot be added without deciding where the
 * estimator sees it.
 *
 * The *arithmetic* of §5.6 is driven by `MarkupClass`, not by this: several
 * buckets share a markup.
 */
export type CostBucket =
  | 'material'
  | 'materialExtras'
  | 'hardware'
  | 'plating'
  | 'fixed'
  | 'labor'
  | 'coating'
  | 'silkscreen';

/**
 * Which markup a cost takes. `none` is quirk Q4's unmarked bucket — coating
 * and silkscreen are added after markups (§5.6).
 */
export type MarkupClass = 'material' | 'labor' | 'none';

/** How the blank sits on the stock (§5.1). */
export interface Nesting {
  /** Blanks that fit on one sheet of stock. 0 when the part does not fit. */
  partsPerBlank: number;
  /** Blanks across the clamped width. */
  across: number;
  /** Blanks along the cut length. */
  down: number;
  /** `length` = part length runs along the stock length; `width` = rotated 90°. */
  orientation: 'length' | 'width';
  /** Part area as a fraction of blank area, 0–1. */
  yieldPct: number;
  /** False when neither orientation fits even one blank. */
  fits: boolean;
}

/** Yield for one candidate cut length, so the UI can offer a few (§5.1). */
export interface LengthYield {
  /** Candidate blank length, inches. */
  blankLengthIn: number;
  nesting: Nesting;
  /** Share-of-blank material cost at this length, $ per part. */
  materialPerPartUsd: number;
}

/** The material module's own numbers, kept so the UI can show the stack
 *  rather than a single figure (§4 FR-2). */
export interface MaterialCost {
  nesting: Nesting;
  /** Weight of one blank of stock, pounds. */
  blankLbs: number;
  /** What one blank of stock costs, $ (§5.1). */
  blankCostUsd: number;
  /** Share of blank: `blankCostUsd ÷ partsPerBlank`, $ per part. */
  materialPerPartUsd: number;
  /** The minimum-charge strip's cost, $ — a whole-lot figure, divided by
   *  quantity where it is applied (§5.1). */
  minChargeUsd: number;
}

/** One contributor's answer for one quantity (§12 rule 5). */
export interface ContributorResult {
  /** Cost for one part at this quantity, $. */
  usdPerPart: number;
  warnings: Warning[];
  /** Anything the UI wants to show under the line. Free-form by design: a
   *  contributor knows its own detail and the roll-up does not care. */
  detail?: Record<string, number>;
}

/**
 * The cost stack for one quantity break. Field order follows §5.6 so reading
 * this type reads the roll-up.
 */
export interface CostStack {
  /** The quantity these figures are for. */
  quantity: number;
  /** Share-of-blank material, or the minimum charge, $ per part. */
  materialUsd: number;
  /** Material extras — surcharge, freight-in, $ per part. */
  materialExtrasUsd: number;
  /** Bought parts, $ per part. */
  hardwareUsd: number;
  /** Outside plating, $ per part. */
  platingUsd: number;
  /** The four above, times the material markup. */
  materialBlockUsd: number;
  /** Setup and NRE amortised over the quantity, $ per part. */
  fixedUsd: number;
  /** Machine and bench time, $ per part. */
  directLaborUsd: number;
  /** The two above, times the labor markup. */
  laborBlockUsd: number;
  /** Coating, $ per part. Unmarked while quirk Q4 is on. */
  coatingUsd: number;
  /** Silkscreen, $ per part. Unmarked while quirk Q4 is on. */
  silkscreenUsd: number;
  /** What the customer pays for one part at this quantity, $. */
  sellingPriceUsd: number;
  /** `materialUsd ÷ sellingPriceUsd`, 0–1 — the number the estimator watches. */
  materialPctOfSelling: number;
  warnings: Warning[];
}

/** One part, priced across every quantity break. */
export interface PartResult {
  partId: string;
  nesting: Nesting;
  breaks: CostStack[];
  warnings: Warning[];
}

/** A whole quote's answer (§4 FR-2). */
export interface QuoteResult {
  parts: PartResult[];
  /** Quote-level warnings — those not attributable to one part. */
  warnings: Warning[];
}
