/**
 * Hit-based cutting time — REQUIREMENTS §5.3.
 *
 * A turret punch does not cut a path; it strikes a tool a number of times.
 * Each tool sustains its own rate, some tools cost more than one hit per
 * feature (a countersink is three, an extrusion two), and the material's
 * hardness scales the whole thing.
 *
 * Reached through `Machine.timeModel === 'hitBased'`, not through the word
 * "punch" (§12 rule 2). Hours are per part.
 *
 * There is no golden punch case — the §9 quote was cut on the laser — so this
 * model is built from §5.3's description and validated against hand-worked
 * cases. Where §5.3 is silent the choice is recorded in `docs/decisions.md`.
 */

const SECONDS_PER_HOUR = 3600;

/** One tool's work on one part, with the tool's own rate resolved. */
export interface PunchHitParams {
  /** Tool name, for the detail breakdown. */
  name: string;
  /** Strikes of this tool on one part. */
  countPerPart: number;
  /** From the machine's hit-rate table: hits per hour. */
  hitsPerHr: number;
  /** From the machine's hit-rate table: hits charged per strike. A
   *  countersink is 3, an extrusion 2, a plain hole 1. */
  multiplier: number;
}

/** Everything the time model needs, as explicit numbers (BUILD-PLAN 1.3). */
export interface PunchParams {
  hits: PunchHitParams[];
  /**
   * From the machine–material rate. Scales the tool rates for how the stock
   * punches: 1.0 is the reference, 0.6 is stainless taking 40% longer.
   *
   * Zero means the pairing cannot be punched at all — the workbook seeds 0
   * against quarter-inch plate. That is a warning from `cutting.ts`, not a
   * division by zero here.
   */
  punchRateFactor: number;
  /** Blanks that come off one blank of stock, to amortise load/unload. */
  partsPerBlank: number;
  /** From the machine row: load and unload, seconds per blank. */
  loadUnloadSecPerBlank: number;
  /** From the machine row: multiplier for real-world losses. */
  lossFactor: number;
}

/** Where a part's punching time goes, in hours per part. */
export interface PunchDetail {
  /** Chargeable hits per part — counts times their multipliers. */
  chargeableHits: number;
  /** Time at the turret, hours per part. */
  hitHrs: number;
  /** Load and unload amortised over the blank, hours per part. */
  loadUnloadHrs: number;
}

/** Guarded division, as in `laser.ts`: a zero rate yields no time rather than
 *  `Infinity`, and `cutting.ts` warns. */
function over(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

/**
 * Machine hours for one part (§5.3).
 *
 * ```
 * (Σ hits × multiplier ÷ (hitsPerHr × punchRateFactor)
 *  + loadUnload ÷ partsPerBlank) × lossFactor
 * ```
 *
 * The rate factor divides rather than multiplies the time: a factor below 1
 * means the stock punches more slowly, so the effective rate is
 * `hitsPerHr × factor` and the hours go up. `lossFactor` is applied here for
 * the same reason it is applied to cutting — it is a property of the machine,
 * not of the laser — and a shop that does not want it sets 1.0.
 */
export function punchHoursPerPart(p: PunchParams): {
  hoursPerPart: number;
  detail: PunchDetail;
} {
  let chargeableHits = 0;
  let hitHrs = 0;

  for (const hit of p.hits) {
    const hits = hit.countPerPart * hit.multiplier;
    chargeableHits += hits;
    hitHrs += over(hits, hit.hitsPerHr * p.punchRateFactor);
  }

  const loadUnloadHrs = over(p.loadUnloadSecPerBlank, p.partsPerBlank * SECONDS_PER_HOUR);

  return {
    hoursPerPart: (hitHrs + loadUnloadHrs) * p.lossFactor,
    detail: { chargeableHits, hitHrs, loadUnloadHrs },
  };
}
