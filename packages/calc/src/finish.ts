/**
 * Finishing — REQUIREMENTS §5.5, §11.3.
 *
 * Three contributors, and they do not all take the same markup: plating is
 * part of the material block, while coating and silkscreen are added **after**
 * markups (quirk Q4). That ordering is load-bearing — moving coating inside
 * the markup changes every price.
 *
 * `sheetMetal.plating`     MAX(lot ÷ qty, $/in² × area, part minimum)
 * `sheetMetal.coating`     the workbook's model, or the trade's (§11.3)
 * `sheetMetal.silkscreen`  screen charge ÷ qty + print per part
 */

import type { CoatingModel, ShopConfig } from './types/config.js';
import type { ContributorInput, CostContributor } from './types/contributor.js';
import type { ContributorResult, Warning } from './types/result.js';

const SQ_IN_PER_SQ_FT = 144;

/**
 * Square feet one pound of powder covers — the powder industry's own formula.
 *
 * ```
 * 192.3 ÷ specific gravity ÷ film mils × transfer efficiency
 * ```
 *
 * 192.3 ft² is what a pound of a specific-gravity-1.0 powder covers at one mil
 * with perfect transfer. Keeping the three inputs rather than a single coverage
 * number is deliberate: they are the numbers an owner has. The data sheet gives
 * specific gravity, the finish spec gives film build, and the booth gives
 * transfer efficiency — 50–80% on a first pass, higher with reclaim.
 */
export function powderCoverageSqFtPerLb(
  specificGravity: number,
  filmThicknessMils: number,
  transferEfficiency: number,
): number {
  if (specificGravity <= 0 || filmThicknessMils <= 0) return 0;
  return (192.3 / specificGravity / filmThicknessMils) * transferEfficiency;
}

/** The area a finish is charged on: what the estimator measured, or the blank
 *  (§5.5). One face — see the note on the plating rate in §11.3. */
export function finishAreaSqIn(input: ContributorInput): number {
  const { part } = input;
  return part.finishedAreaSqIn ?? part.flatLengthIn * part.flatWidthIn;
}

/** Outside perimeter of the flat, inches: `2(L + W)` (§5.5). */
export function perimeterIn(input: ContributorInput): number {
  return 2 * (input.part.flatLengthIn + input.part.flatWidthIn);
}

/**
 * Outside plating, $ per part (§5.5).
 *
 * ```
 * MAX(lot minimum ÷ qty, $/in² × area, part minimum)
 * ```
 *
 * The three-way MAX is standard trade practice and worth keeping: a plating
 * house has a lot minimum ($50–$400 is the going range, and the workbook's
 * $125 sits inside it), a per-area rate, and a floor per piece. Whichever
 * binds, binds.
 */
export function platingUsdPerPart(
  spec: { lotMinimumUsd: number; pricePerSqInUsd: number; partMinimumUsd: number },
  areaSqIn: number,
  qty: number,
): number {
  const perLot = qty > 0 ? spec.lotMinimumUsd / qty : 0;
  return Math.max(perLot, spec.pricePerSqInUsd * areaSqIn, spec.partMinimumUsd);
}

/**
 * Coating, $ per part.
 *
 * **Legacy (quirk Q3, the default).** `rate × (perimeter ÷ coverage × S)`.
 * The workbook calls the perimeter an area and nobody can explain the
 * constants 5 / 100 / 0.5 — §10 question 2. Reproduced, not corrected: it is
 * what makes the golden part's $1.0619.
 *
 * **Modern (§11.3).** Coated area over the powder's real coverage, plus
 * racking and masking. This is the flag's other side, and §11.3 requires it to
 * be a defensible number rather than a hole.
 */
export function coatingUsdPerPart(
  model: CoatingModel,
  options: {
    perimeterIn: number;
    areaSqIn: number;
    sidesCoated: 1 | 2;
    maskedFeatures: number;
    legacy: boolean;
  },
): { usd: number; warning: Warning | null } {
  if (options.legacy) {
    if (model.legacy === null) {
      return {
        usd: 0,
        warning: {
          code: 'missing-standard',
          message: `${model.name} has no legacy coating parameters, so it costs nothing.`,
        },
      };
    }
    const { rateUsd, coverage, sConstant } = model.legacy;
    const usd = coverage > 0 ? rateUsd * ((options.perimeterIn / coverage) * sConstant) : 0;
    return { usd: Math.max(usd, model.minimumChargeUsd), warning: null };
  }

  if (model.modern === null) {
    return {
      usd: 0,
      warning: {
        code: 'missing-standard',
        message:
          `${model.name} has no modern coating parameters. Add the powder's ` +
          `specific gravity, film build and transfer efficiency in Settings.`,
      },
    };
  }

  const m = model.modern;
  const coverage = powderCoverageSqFtPerLb(
    m.specificGravity,
    m.filmThicknessMils,
    m.transferEfficiency,
  );
  const coatedSqFt = (options.areaSqIn * options.sidesCoated) / SQ_IN_PER_SQ_FT;
  const powderUsd = coverage > 0 ? (coatedSqFt / coverage) * m.powderPricePerLbUsd : 0;
  const usd = powderUsd + m.rackLaborUsdPerPart + options.maskedFeatures * m.maskingUsdPerFeature;
  return { usd: Math.max(usd, model.minimumChargeUsd), warning: null };
}

/** Plating: material block, material markup (§5.6). */
export const platingContributor: CostContributor = {
  id: 'sheetMetal.plating',
  bucket: 'plating',
  markupClass: 'material',

  compute(input: ContributorInput, config: ShopConfig, qty: number): ContributorResult {
    const specId = input.part.finish.platingSpecId;
    if (specId === undefined) return { usdPerPart: 0, warnings: [] };

    const spec = config.platingSpecs.find((p) => p.id === specId);
    if (spec === undefined) {
      return {
        usdPerPart: 0,
        warnings: [
          {
            code: 'missing-standard',
            message: `No plating spec ${specId} in this shop's catalog.`,
            partId: input.part.id,
          },
        ],
      };
    }

    const warnings: Warning[] = [];
    if (input.quote.customer?.rohsRequired === true && spec.rohsCompliant === false) {
      warnings.push({
        code: 'non-rohs-finish',
        message: `${spec.name} is not RoHS compliant and ${input.quote.customer.name} requires it.`,
        partId: input.part.id,
      });
    }

    const areaSqIn = finishAreaSqIn(input);
    return {
      usdPerPart: platingUsdPerPart(spec, areaSqIn, qty),
      warnings,
      detail: { areaSqIn },
    };
  },
};

/** Coating: unmarked while quirk Q4 is on (§5.6). */
export const coatingContributor: CostContributor = {
  id: 'sheetMetal.coating',
  bucket: 'coating',
  markupClass: 'none',

  compute(input: ContributorInput, config: ShopConfig): ContributorResult {
    const selection = input.part.finish.coating;
    if (selection === undefined) return { usdPerPart: 0, warnings: [] };

    const model = config.coatingModels.find((c) => c.id === selection.coatingModelId);
    if (model === undefined) {
      return {
        usdPerPart: 0,
        warnings: [
          {
            code: 'missing-standard',
            message: `No coating model ${selection.coatingModelId} in this shop's catalog.`,
            partId: input.part.id,
          },
        ],
      };
    }

    const { usd, warning } = coatingUsdPerPart(model, {
      perimeterIn: perimeterIn(input),
      areaSqIn: finishAreaSqIn(input),
      sidesCoated: selection.sidesCoated,
      maskedFeatures: selection.maskedFeatures,
      legacy: config.parity.legacyCoatingModel,
    });

    return {
      usdPerPart: usd,
      warnings: warning === null ? [] : [{ ...warning, partId: input.part.id }],
      detail: { perimeterIn: perimeterIn(input) },
    };
  },
};

/** Silkscreen: one-time screen charge amortised, plus print per part (§5.5). */
export const silkscreenContributor: CostContributor = {
  id: 'sheetMetal.silkscreen',
  bucket: 'silkscreen',
  markupClass: 'none',

  compute(input: ContributorInput, config: ShopConfig, qty: number): ContributorResult {
    const tierId = input.part.finish.silkscreenTierId;
    if (tierId === undefined) return { usdPerPart: 0, warnings: [] };

    const tier = config.silkscreenTiers.find((t) => t.id === tierId);
    if (tier === undefined) {
      return {
        usdPerPart: 0,
        warnings: [
          {
            code: 'missing-standard',
            message: `No silkscreen tier ${tierId} in this shop's catalog.`,
            partId: input.part.id,
          },
        ],
      };
    }

    const warnings: Warning[] = [];
    if (tier.screenCostUsd === null) {
      warnings.push({
        code: 'missing-standard',
        message: `${tier.name} has no screen charge — the customer supplies the screen.`,
        partId: input.part.id,
      });
    }

    const screenPerPart = qty > 0 ? (tier.screenCostUsd ?? 0) / qty : 0;
    return {
      usdPerPart: screenPerPart + tier.printCostUsd,
      warnings,
      detail: { screenPerPart, printCostUsd: tier.printCostUsd },
    };
  },
};
