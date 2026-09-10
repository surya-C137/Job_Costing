/**
 * Labour — REQUIREMENTS §5.4.
 *
 * Two contributors, because setup and run time land on different lines of the
 * cost stack and behave differently with quantity:
 *
 * - `sheetMetal.setup` — `Σ(setupHrs × rate)`, charged once per job and
 *   divided by the quantity. This is what makes a quote of one expensive.
 * - `sheetMetal.directLabor` — per-part run time, the same at every break.
 *
 * ```
 * hrsPerPart    = machine ops: hours from §5.2/§5.3 ;  manual: count ÷ standard
 * directPerPart = hrsPerPart × ratePerHr × (isMachineOp ? machineTimeFactor : 1)
 * ```
 *
 * The factor is **quirk Q2**: the workbook bills machine time at 0.6× while
 * manual ops run at 1.0. Nobody at the shop has been able to say what the 60
 * means (§10 question 1), so it is reproduced as a number an owner can dial
 * rather than a branch — 0.6 is the workbook, 1.0 is machine time billed as
 * machine time, and the golden test runs at 0.6.
 */

import { cuttingHoursForPart } from './cutting.js';
import { effectiveRatePerHrUsd, findOperation } from './lookup.js';
import type { ShopConfig } from './types/config.js';
import type { ContributorInput, CostContributor } from './types/contributor.js';
import type { ContributorResult, Warning } from './types/result.js';

/** Run hours for one part on one operation line (§5.4). */
export function operationHoursPerPart(
  standardPerHr: number | null,
  countPerPart: number,
): number {
  if (standardPerHr === null || standardPerHr <= 0) return 0;
  return countPerPart / standardPerHr;
}

/**
 * Setup dollars for the whole job — `Σ(setupHrs × rate)` over the part's
 * operations, plus whatever one-off labour the estimator added.
 *
 * This *is* the job's fixed cost (§5.6). The workbook's `D13` = $20 is this
 * sum for the golden part, not a shop constant; treating it as one would
 * double-count. `ShopDefaults.shopFixedCostPerJobUsd` is a separate flat adder
 * that seeds to zero.
 */
export function setupCostUsd(input: ContributorInput, config: ShopConfig): {
  usd: number;
  warnings: Warning[];
} {
  const warnings: Warning[] = [];
  let usd = input.part.setupExtraLaborUsd ?? 0;

  for (const line of input.part.operations) {
    const operation = findOperation(config, line.operationId);
    if (operation === undefined) {
      warnings.push({
        code: 'missing-standard',
        message: `No operation ${line.operationId} in this shop's catalog.`,
        partId: input.part.id,
      });
      continue;
    }
    const rate = effectiveRatePerHrUsd(config, operation);
    if (rate === undefined) {
      warnings.push({
        code: 'missing-standard',
        message: `${operation.name} has no rate, and no machine to inherit one from.`,
        partId: input.part.id,
      });
      continue;
    }
    usd += operation.setupHrs * rate;
  }

  return { usd, warnings };
}

/** Run-time dollars for one part, across every operation on it (§5.4). */
export function directLaborUsd(input: ContributorInput, config: ShopConfig): {
  usd: number;
  hoursPerPart: number;
  warnings: Warning[];
} {
  const warnings: Warning[] = [];
  let usd = 0;
  let hoursPerPart = 0;

  // Cutting time is resolved once, then charged to whichever operation runs on
  // the machine that did the cutting — the workbook's own arrangement, and the
  // reason §5.4 says machine ops take their hours "from §5.2/§5.3".
  const cutting = cuttingHoursForPart(input, config);
  warnings.push(...cutting.warnings);
  let cuttingCharged = false;

  for (const line of input.part.operations) {
    const operation = findOperation(config, line.operationId);
    if (operation === undefined) continue; // already warned in setupCostUsd
    const rate = effectiveRatePerHrUsd(config, operation);
    if (rate === undefined) continue;

    let hrs: number;
    if (operation.kind === 'machine') {
      // Only the operation on the cutting machine gets the cutting hours; a
      // second machine op on the part would otherwise be charged them twice.
      const runsTheCut = operation.machineId === input.part.nesting.machineId;
      hrs = runsTheCut && !cuttingCharged ? cutting.hoursPerPart : 0;
      if (runsTheCut) cuttingCharged = true;
    } else {
      hrs = operationHoursPerPart(operation.standardPerHr, line.countPerPart);
      if (hrs === 0 && line.countPerPart > 0) {
        warnings.push({
          code: 'missing-standard',
          message: `${operation.name} has no standard, so its ${line.countPerPart} units cost nothing.`,
          partId: input.part.id,
        });
      }
    }

    const factor = operation.kind === 'machine' ? config.parity.machineTimeFactor : 1;
    hoursPerPart += hrs;
    usd += hrs * rate * factor;
  }

  return { usd, hoursPerPart, warnings };
}

/** Setup, amortised over the quantity (§5.6). */
export const setupContributor: CostContributor = {
  id: 'sheetMetal.setup',
  bucket: 'fixed',
  markupClass: 'labor',

  compute(input: ContributorInput, config: ShopConfig, qty: number): ContributorResult {
    const { usd, warnings } = setupCostUsd(input, config);
    const perJob = usd + config.defaults.shopFixedCostPerJobUsd;
    return {
      usdPerPart: qty > 0 ? perJob / qty : 0,
      warnings,
      detail: { setupUsdPerJob: perJob },
    };
  },
};

/** Run time, the same at every quantity (§5.4). */
export const directLaborContributor: CostContributor = {
  id: 'sheetMetal.directLabor',
  bucket: 'labor',
  markupClass: 'labor',

  compute(input: ContributorInput, config: ShopConfig): ContributorResult {
    const { usd, hoursPerPart, warnings } = directLaborUsd(input, config);
    return { usdPerPart: usd, warnings, detail: { hoursPerPart } };
  },
};
