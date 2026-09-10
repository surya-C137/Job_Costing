/**
 * Feature-based cutting time — REQUIREMENTS §5.2.
 *
 * A path cut at a speed, plus a pierce for every hole and the machine's own
 * overheads. The file is called `laser.ts` because that is the machine the
 * shop has and BUILD-PLAN 1.3 names, but nothing here is laser-specific: a
 * waterjet and a plasma torch cut the same geometry at a different speed, and
 * they reach this code through `Machine.timeModel === 'featureBased'` rather
 * than through their name (§12 rule 2).
 *
 * Hours are **per part**. The workbook's LASER WORKSHEET totals per 100 and
 * §11.4 keeps that as a display convention; the conversion happens at the
 * edge.
 *
 * The golden case (§9) is 58 inches of perimeter, one pierce, one
 * intersection, 220 in/min, 0.1 s pierce, 33 up on a blank → **0.0052255
 * hours per part**, the fifth of the engine's five intermediates.
 */

import type { CutFeature } from './types/part.js';

const SECONDS_PER_HOUR = 3600;
const MINUTES_PER_HOUR = 60;

/** Everything the time model needs, as explicit numbers (BUILD-PLAN 1.3). */
export interface LaserParams {
  /** Internal features, each with its own count per part. */
  features: CutFeature[];
  /** Outside profile cut length, inches per part. */
  perimeterCutIn: number;
  /** Cut-path intersections per part. */
  intersections: number;
  /** From the machine–material rate: cutting speed, inches per minute. */
  cutSpeedInPerMin: number;
  /** From the machine–material rate: time to pierce, seconds. */
  pierceSeconds: number;
  /** Blanks that come off one sheet of stock — `partsPerBlank ×
   *  blanksPerSheet`. Decides whether a pallet change falls inside a batch. */
  partsPerSheet: number;
  /** From the machine row: pallet or table change, seconds. */
  palletChangeSec: number;
  /** From the machine row: the batch a pallet change is spread over. */
  palletBatchParts: number;
  /** From the machine row: seconds lost per intersection. */
  intersectionSec: number;
  /** From the machine row: rapid traverse, seconds per pierce. */
  rapidSecPerPierce: number;
  /** From the machine row: multiplier for real-world losses, e.g. 1.08. */
  lossFactor: number;
}

/** Where a part's cutting time goes, in hours per part. For the UI and for
 *  anyone tracing a number back to §5.2. */
export interface LaserDetail {
  cutLengthIn: number;
  pierces: number;
  cutHrs: number;
  pierceHrs: number;
  intersectionHrs: number;
  rapidHrs: number;
  palletHrs: number;
}

/**
 * Cut length one feature contributes, inches — its perimeter times how many
 * of it are on the part (§5.2).
 *
 * An obround is a rectangle's two straight flanks plus a full circle's worth
 * of end radii: `(L − W) × 2 + πW`.
 */
export function featureCutLengthIn(feature: CutFeature): number {
  switch (feature.shape) {
    case 'hole':
      return Math.PI * feature.diameterIn * feature.count;
    case 'obround':
      return ((feature.lengthIn - feature.widthIn) * 2 + Math.PI * feature.widthIn) * feature.count;
    case 'rect':
      return (2 * feature.lengthIn + 2 * feature.widthIn) * feature.count;
    case 'misc':
      return feature.cutLengthIn * feature.count;
  }
}

/** Total inches the machine cuts for one part: every feature plus the outside
 *  profile (§5.2). */
export function cutLengthIn(features: readonly CutFeature[], perimeterCutIn: number): number {
  return features.reduce((total, f) => total + featureCutLengthIn(f), perimeterCutIn);
}

/**
 * Pierces for one part: one per feature, plus one to start the outside profile
 * (§5.2's "feature count + 1").
 *
 * Counted over instances rather than rows — a row of 200 holes is 200 pierces,
 * because the machine stops and pierces at each. The golden part has no
 * internal features, so its single pierce cannot tell the two readings apart;
 * physics can.
 */
export function pierceCount(features: readonly CutFeature[]): number {
  return features.reduce((total, f) => total + f.count, 0) + 1;
}

/** Guarded division — a zero or missing rate yields no time rather than
 *  `Infinity`. The caller warns; see `cutting.ts`. */
function over(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

/**
 * Machine hours for one part (§5.2).
 *
 * ```
 * (cut + pierce + rapids + intersections + pallet) × lossFactor
 * ```
 *
 * **The pallet term is the one place this follows the workbook against the
 * spec's prose.** §5.2 reads "pallet change 60 s ÷ parts_per_sheet (only if
 * pps < 100)", which for the golden part is 60 ÷ 41.25 = 1.45 s and misses the
 * oracle by 4.9%. The worksheet's own cell (`F33` = 1.6667e-04 h = 0.6 s) is
 * 60 ÷ 100: one pallet change amortised over a 100-part batch, charged only
 * while a single sheet yields fewer than 100 parts. Both the threshold and the
 * divisor are that same 100, which is why `palletBatchParts` serves as both.
 *
 * That reading is coherent and it reproduces §9 exactly. It is not the only
 * one available: `F33` is numerically identical to `F32`, the rapid factor,
 * so a copy-paste in the workbook would look the same from this single save.
 * Recorded in `docs/discovery.md` for the owner (§10).
 */
export function laserHoursPerPart(p: LaserParams): {
  hoursPerPart: number;
  detail: LaserDetail;
} {
  const totalCutIn = cutLengthIn(p.features, p.perimeterCutIn);
  const pierces = pierceCount(p.features);

  const cutHrs = over(totalCutIn, p.cutSpeedInPerMin * MINUTES_PER_HOUR);
  const pierceHrs = (pierces * p.pierceSeconds) / SECONDS_PER_HOUR;
  const intersectionHrs = (p.intersections * p.intersectionSec) / SECONDS_PER_HOUR;
  const rapidHrs = (pierces * p.rapidSecPerPierce) / SECONDS_PER_HOUR;

  const needsPalletChange = p.partsPerSheet > 0 && p.partsPerSheet < p.palletBatchParts;
  const palletHrs = needsPalletChange
    ? over(p.palletChangeSec, p.palletBatchParts * SECONDS_PER_HOUR)
    : 0;

  const hoursPerPart =
    (cutHrs + pierceHrs + intersectionHrs + rapidHrs + palletHrs) * p.lossFactor;

  return {
    hoursPerPart,
    detail: { cutLengthIn: totalCutIn, pierces, cutHrs, pierceHrs, intersectionHrs, rapidHrs, palletHrs },
  };
}
