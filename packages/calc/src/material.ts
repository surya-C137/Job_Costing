/**
 * The material module — nesting, share-of-blank cost, and the minimum charge.
 *
 * REQUIREMENTS §5.1, validated by the §9 golden case: a 13.38 × 7.858 blank of
 * `G30 16 GA` on 48-inch stock cut to 96 inches nests 33 up, the blank costs
 * $68.8358, the 12-inch minimum strip costs $8.6045, and one part's share is
 * $2.0859 — rising to $10.3254 at a quantity of one, where the minimum bites.
 * Those four numbers are four fifths of the engine's oracle.
 *
 * Nothing here knows what a laser is. Clamp and kerf arrive as numbers off a
 * `Machine` row, which is why the same code nests for a waterjet (§12).
 */

import { findMachine, findMaterial } from './lookup.js';
import type { ShopConfig } from './types/config.js';
import type { CostContributor, ContributorInput } from './types/contributor.js';
import type {
  ContributorResult,
  LengthYield,
  MaterialCost,
  Nesting,
  Result,
  Warning,
} from './types/result.js';
import { err, ok } from './types/result.js';

/** Square inches in a square foot. The workbook's `/144` everywhere. */
const SQ_IN_PER_SQ_FT = 144;

/**
 * Guards `Math.floor` against a division that should land on a whole number
 * arriving as 5.999999999999999. Far smaller than any real tolerance, so it
 * can never turn a genuine 5.98 into a 6.
 */
const FIT_EPSILON = 1e-9;

/** Below this fraction the estimator gets an amber note (CLAUDE.md Design). */
const LOW_YIELD_THRESHOLD = 0.5;

/** Everything `nest()` needs, in inches. */
export interface NestParams {
  /** Flat-pattern length of the blank. */
  flatLengthIn: number;
  /** Flat-pattern width of the blank. */
  flatWidthIn: number;
  /** Stock width — the edge the clamp comes off. */
  stockWidthIn: number;
  /** Cut length of the stock. */
  blankLengthIn: number;
  /** Strip lost to the clamp on one width edge (`Machine.clampStripIn`). */
  clampStripIn: number;
  /** Kerf / part spacing added to each part dimension (`Machine.kerfIn`). */
  kerfIn: number;
}

/** `NestParams` plus what it takes to put a price on the nest. */
export interface MaterialParams extends NestParams {
  /** Areal weight of the stock, lb/ft². */
  lbPerSqFt: number;
  /** Effective purchase price, $/lb — surcharge already applied. */
  pricePerLbUsd: number;
  /** Length of the minimum-charge strip, inches
   *  (`ShopDefaults.minChargeStripIn`). */
  minChargeStripIn: number;
  /** Estimator's own nest count, used instead of the computed one. */
  partsPerBlankOverride?: number;
}

/**
 * How many whole parts fit along `usableIn` when each occupies
 * `dimIn + kerfIn`.
 *
 * §5.1 charges kerf to *every* part rather than only to the gaps between them,
 * so a part exactly filling the stock yields one fewer than a
 * spacing-between-parts model would. That is the shop's convention and it is
 * what reproduces the golden 33.
 */
function fitCount(usableIn: number, dimIn: number, kerfIn: number): number {
  const pitch = dimIn + kerfIn;
  if (pitch <= 0 || usableIn <= 0) return 0;
  return Math.max(0, Math.floor(usableIn / pitch + FIT_EPSILON));
}

/**
 * Grid nesting per §5.1: the clamp comes off one width edge, kerf is added to
 * each part dimension, both orientations are tried and the better one wins.
 *
 * This is an *estimating* nest, not a production one (§11.5) — a real nester
 * does better, and the shop has always quoted off the grid.
 */
export function nest(p: NestParams): Nesting {
  const usableWidthIn = p.stockWidthIn - p.clampStripIn;
  const blankAreaSqIn = p.stockWidthIn * p.blankLengthIn;
  const partAreaSqIn = p.flatLengthIn * p.flatWidthIn;

  /** Part length runs along the stock length. */
  const alongLength = {
    across: fitCount(usableWidthIn, p.flatWidthIn, p.kerfIn),
    down: fitCount(p.blankLengthIn, p.flatLengthIn, p.kerfIn),
  };
  /** Rotated 90°: part width runs along the stock length. */
  const alongWidth = {
    across: fitCount(usableWidthIn, p.flatLengthIn, p.kerfIn),
    down: fitCount(p.blankLengthIn, p.flatWidthIn, p.kerfIn),
  };

  const lengthCount = alongLength.across * alongLength.down;
  const widthCount = alongWidth.across * alongWidth.down;
  const rotated = widthCount > lengthCount;

  const chosen = rotated ? alongWidth : alongLength;
  const partsPerBlank = rotated ? widthCount : lengthCount;

  return {
    partsPerBlank,
    across: chosen.across,
    down: chosen.down,
    orientation: rotated ? 'width' : 'length',
    yieldPct:
      partsPerBlank > 0 && blankAreaSqIn > 0 ? (partsPerBlank * partAreaSqIn) / blankAreaSqIn : 0,
    fits: partsPerBlank > 0,
  };
}

/** Weight of a piece of stock, pounds (§5.1). */
export function stockLbs(lengthIn: number, widthIn: number, lbPerSqFt: number): number {
  return ((lengthIn * widthIn) / SQ_IN_PER_SQ_FT) * lbPerSqFt;
}

/** What one blank of stock costs, $ (§5.1). Golden case: $68.8358. */
export function blankCostUsd(p: MaterialParams): number {
  return stockLbs(p.blankLengthIn, p.stockWidthIn, p.lbPerSqFt) * p.pricePerLbUsd;
}

/**
 * The minimum-charge strip, $ — what the shop bills for the whole lot when the
 * nest would otherwise price a job below the cost of buying stock at all
 * (§5.1). Golden case: $8.6045 for a 12-inch strip of 48-wide.
 *
 * Deliberately not capped at the blank length. A 6-inch blank still costs a
 * 12-inch strip, which is the entire point of a minimum — the prototype capped
 * it, and that is one of the places this engine follows the spec rather than
 * the prototype.
 */
export function minimumChargeUsd(p: MaterialParams): number {
  return stockLbs(p.minChargeStripIn, p.stockWidthIn, p.lbPerSqFt) * p.pricePerLbUsd;
}

/**
 * The material figures for one part, or a typed failure when the blank does
 * not fit the stock in either orientation.
 *
 * Failure is a value rather than a throw (CLAUDE.md conventions). The
 * contributor below turns it into an amber warning so the estimator sees the
 * rest of the stack and fixes the stock size.
 */
export function materialForPart(p: MaterialParams): Result<MaterialCost> {
  const nesting = nest(p);
  const partsPerBlank = p.partsPerBlankOverride ?? nesting.partsPerBlank;

  if (partsPerBlank <= 0) {
    return err({
      code: 'part-does-not-fit',
      message:
        `A ${p.flatLengthIn} × ${p.flatWidthIn} in blank does not fit ` +
        `${p.stockWidthIn} in stock cut to ${p.blankLengthIn} in with a ` +
        `${p.clampStripIn} in clamp and ${p.kerfIn} in kerf.`,
    });
  }

  const cost = blankCostUsd(p);
  return ok({
    nesting: p.partsPerBlankOverride === undefined ? nesting : { ...nesting, partsPerBlank },
    blankLbs: stockLbs(p.blankLengthIn, p.stockWidthIn, p.lbPerSqFt),
    blankCostUsd: cost,
    materialPerPartUsd: cost / partsPerBlank,
    minChargeUsd: minimumChargeUsd(p),
  });
}

/** What `materialAtQty()` needs off the config. */
export interface MaterialAtQtyOptions {
  /** `ShopDefaults.materialMarkup`. */
  materialMarkup: number;
  /** Parity flag Q1. */
  markupInsideMinChargeMax: boolean;
}

/**
 * Material cost for one part at one quantity, $ (§5.1):
 *
 * ```
 * MAX(share of blank, min charge ÷ qty × material markup)
 * ```
 *
 * The markup inside the MAX is **quirk Q1**. It is not a rounding detail: the
 * material block is multiplied by the same markup again in the roll-up (§5.6),
 * so at low quantities the minimum charge carries it twice. That is what makes
 * the golden qty-1 material $10.3254 rather than $8.6045, and it is why Q1 is
 * an open question for the owner (§10) rather than a bug to fix.
 *
 * With Q1 off the comparison is against the bare minimum charge, and the
 * roll-up's single markup is the only one applied — a defensible number, which
 * is what §11.3 requires of every flag's other side.
 */
export function materialAtQty(
  cost: MaterialCost,
  qty: number,
  opts: MaterialAtQtyOptions,
): { usdPerPart: number; minChargeApplied: boolean } {
  if (qty <= 0) return { usdPerPart: 0, minChargeApplied: false };

  const perLot = cost.minChargeUsd / qty;
  const candidate = opts.markupInsideMinChargeMax ? perLot * opts.materialMarkup : perLot;
  const minChargeApplied = candidate > cost.materialPerPartUsd;

  return {
    usdPerPart: Math.max(cost.materialPerPartUsd, candidate),
    minChargeApplied,
  };
}

/**
 * Yield and per-part cost for each candidate cut length, so the UI can show
 * the estimator what a different blank buys them (§5.1).
 *
 * This replaces the workbook's 48-row precomputed grid: the same answer, worked
 * out on demand for whatever lengths the shop actually stocks, with no table to
 * fall out of date.
 */
export function yieldForLengths(p: MaterialParams, blankLengthsIn: number[]): LengthYield[] {
  return blankLengthsIn.map((blankLengthIn) => {
    const at = { ...p, blankLengthIn };
    const nesting = nest(at);
    return {
      blankLengthIn,
      nesting,
      materialPerPartUsd:
        nesting.partsPerBlank > 0 ? blankCostUsd(at) / nesting.partsPerBlank : 0,
    };
  });
}

/**
 * Resolve a part's material parameters out of the config.
 *
 * Surcharge folds into the effective $/lb: it is a price adjustment on the
 * same stock, not a separate line (§11.2). Clamp and kerf come off the machine
 * row unless the estimator overrode them for this part.
 */
export function materialParamsFor(
  input: ContributorInput,
  config: ShopConfig,
): Result<MaterialParams> {
  const { part } = input;
  const material = findMaterial(config, part.materialId);
  if (material === undefined) {
    return err({
      code: 'unknown-reference',
      message: `No material ${part.materialId} in this shop's catalog.`,
      partId: part.id,
    });
  }

  const machine = findMachine(config, part.nesting.machineId);
  if (machine === undefined) {
    return err({
      code: 'unknown-reference',
      message: `No machine ${part.nesting.machineId} in this shop's work centres.`,
      partId: part.id,
    });
  }

  const params: MaterialParams = {
    flatLengthIn: part.flatLengthIn,
    flatWidthIn: part.flatWidthIn,
    stockWidthIn: part.nesting.stockWidthIn,
    blankLengthIn: part.nesting.blankLengthIn,
    clampStripIn: part.nesting.clampStripInOverride ?? machine.clampStripIn,
    kerfIn: part.nesting.kerfInOverride ?? machine.kerfIn,
    lbPerSqFt: material.lbPerSqFt,
    pricePerLbUsd: material.pricePerLbUsd * (1 + material.surchargePct),
    minChargeStripIn: config.defaults.minChargeStripIn,
    ...(part.nesting.partsPerBlankOverride === undefined
      ? {}
      : { partsPerBlankOverride: part.nesting.partsPerBlankOverride }),
  };
  return ok(params);
}

/**
 * Share-of-blank material as a cost contributor (§12 rule 5).
 *
 * `sheetMetal.nesting` is the first module in the registry and the shape every
 * other one follows: it takes a part, a config and a quantity, and returns
 * dollars per part plus whatever the estimator should be told.
 */
export const sheetMetalNestingContributor: CostContributor = {
  id: 'sheetMetal.nesting',
  bucket: 'material',
  markupClass: 'material',

  compute(input: ContributorInput, config: ShopConfig, qty: number): ContributorResult {
    const warnings: Warning[] = [];
    const partId = input.part.id;

    const params = materialParamsFor(input, config);
    if (!params.ok) {
      warnings.push({ code: 'part-does-not-fit', message: params.error.message, partId });
      return { usdPerPart: 0, warnings };
    }

    const material = findMaterial(config, input.part.materialId);
    if (material !== undefined && !material.active) {
      warnings.push({
        code: 'material-inactive',
        message: `${material.name} is switched off in Settings but is still on this part.`,
        partId,
      });
    }

    const cost = materialForPart(params.value);
    if (!cost.ok) {
      warnings.push({ code: 'part-does-not-fit', message: cost.error.message, partId });
      return { usdPerPart: 0, warnings };
    }

    const { nesting, materialPerPartUsd, blankCostUsd: blank, minChargeUsd } = cost.value;
    if (nesting.yieldPct > 0 && nesting.yieldPct < LOW_YIELD_THRESHOLD) {
      warnings.push({
        code: 'low-yield',
        message: `Only ${(nesting.yieldPct * 100).toFixed(0)}% of the blank becomes parts.`,
        partId,
      });
    }

    const at = materialAtQty(cost.value, qty, {
      materialMarkup: config.defaults.materialMarkup,
      markupInsideMinChargeMax: config.parity.markupInsideMinChargeMax,
    });
    if (at.minChargeApplied) {
      warnings.push({
        code: 'min-charge-applied',
        message:
          `At ${qty} off, the ${params.value.minChargeStripIn} in minimum strip ` +
          `sets the material price rather than the nest.`,
        partId,
      });
    }

    return {
      usdPerPart: at.usdPerPart,
      warnings,
      detail: {
        partsPerBlank: nesting.partsPerBlank,
        yieldPct: nesting.yieldPct,
        blankCostUsd: blank,
        materialPerPartUsd,
        minChargeUsd,
      },
    };
  },
};
