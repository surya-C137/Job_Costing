/**
 * Resolving a part's cutting time out of a `ShopConfig` — REQUIREMENTS §5.2,
 * §5.3, §12.
 *
 * `laser.ts` and `punch.ts` are deliberately dumb: they take explicit numbers
 * and return hours. This is where those numbers come from — the selected
 * `Machine` and its `machineMaterialRates` entry, never the material row and
 * never a constant.
 *
 * Which model runs is decided by the machine's `timeModel`, not by its name.
 * A shop that buys a waterjet adds a `featureBased` machine in Settings and
 * gets priced by the same code as the laser (§12 rule 2).
 *
 * Nothing here throws. A pairing the owner has not filled in yields zero hours
 * and a warning naming exactly what is missing — §12 rule 3 is explicit that
 * missing data is visible, never a silent default.
 *
 * Hours, not dollars: `operations.ts` (Task 1.4) turns these into direct
 * labour at the machine's rate, applying quirk Q2's `machineTimeFactor` (§5.4).
 */

import { laserHoursPerPart, type LaserParams } from './laser.js';
import { findMachine, findMachineMaterialRate, findMaterial } from './lookup.js';
import { materialParamsFor, nest } from './material.js';
import { punchHoursPerPart, type PunchHitParams } from './punch.js';
import type { ShopConfig } from './types/config.js';
import type { ContributorInput } from './types/contributor.js';
import type { Warning } from './types/result.js';

/** Machine time for one part, with whatever the estimator needs to be told. */
export interface CuttingTime {
  /** Machine hours for one part. Zero when the answer is unknown — always
   *  alongside a warning saying why. */
  hoursPerPart: number;
  warnings: Warning[];
  /** The model's own breakdown, for the UI and for tracing a number back to
   *  §5.2/§5.3. Empty when nothing could be computed. */
  detail: Record<string, number>;
}

function nothing(warnings: Warning[]): CuttingTime {
  return { hoursPerPart: 0, warnings, detail: {} };
}

/**
 * How many blanks come off one sheet of stock.
 *
 * The estimator picks a cut length; the shop buys the material's standard
 * length. Fractional by design — 120-inch stock cut to 96 gives 1.25, and the
 * quarter is a real share of a real sheet, which is what makes
 * `partsPerSheet` 41.25 in the §9 case rather than 33.
 */
export function blanksPerSheet(standardLengthIn: number | null, blankLengthIn: number): number {
  if (standardLengthIn === null || standardLengthIn <= 0 || blankLengthIn <= 0) return 1;
  return standardLengthIn / blankLengthIn;
}

/**
 * Machine hours for one part, resolved from the shop's configuration.
 *
 * @param input the part and its quote
 * @param config the shop's frozen configuration
 */
export function cuttingHoursForPart(input: ContributorInput, config: ShopConfig): CuttingTime {
  const { part } = input;
  const partId = part.id;
  const warnings: Warning[] = [];

  if (part.cutting.model === 'none') {
    return { hoursPerPart: 0, warnings, detail: {} };
  }

  const machine = findMachine(config, part.nesting.machineId);
  if (machine === undefined) {
    return nothing([
      {
        code: 'cutting-model-mismatch',
        message: `No machine ${part.nesting.machineId} in this shop's work centres.`,
        partId,
      },
    ]);
  }

  const material = findMaterial(config, part.materialId);
  if (material === undefined) {
    return nothing([
      {
        code: 'cutting-model-mismatch',
        message: `No material ${part.materialId} in this shop's catalog.`,
        partId,
      },
    ]);
  }

  if (machine.timeModel !== part.cutting.model) {
    return nothing([
      {
        code: 'cutting-model-mismatch',
        message:
          `${part.partNumber} carries a ${part.cutting.model} cut, but ` +
          `${machine.name} is a ${machine.timeModel} machine.`,
        partId,
      },
    ]);
  }

  const rate = findMachineMaterialRate(config, machine.id, material.id);
  if (rate === undefined) {
    return nothing([
      {
        code: 'missing-machine-material-rate',
        message: `No speed for ${machine.name} × ${material.name}. Add one in Settings.`,
        partId,
      },
    ]);
  }

  // The nest decides how load/unload and pallet time are amortised, so cutting
  // has to agree with §5.1 about it rather than keep its own count.
  const params = materialParamsFor(input, config);
  if (!params.ok) return nothing([{ code: 'part-does-not-fit', message: params.error.message, partId }]);

  const nesting = nest(params.value);
  const partsPerBlank = part.nesting.partsPerBlankOverride ?? nesting.partsPerBlank;
  if (partsPerBlank <= 0) {
    return nothing([
      {
        code: 'part-does-not-fit',
        message: `${part.partNumber} does not fit the stock, so its cutting time is unknown.`,
        partId,
      },
    ]);
  }

  if (part.cutting.model === 'featureBased') {
    if (rate.cutSpeedInPerMin <= 0) {
      return nothing([
        {
          code: 'material-not-cuttable',
          message: `${machine.name} has no cutting speed for ${material.name}.`,
          partId,
        },
      ]);
    }

    const laserParams: LaserParams = {
      features: part.cutting.features,
      perimeterCutIn: part.cutting.perimeterCutIn,
      intersections: part.cutting.intersections,
      cutSpeedInPerMin: rate.cutSpeedInPerMin,
      pierceSeconds: rate.pierceSeconds,
      partsPerSheet:
        partsPerBlank * blanksPerSheet(material.standardLengthIn, part.nesting.blankLengthIn),
      palletChangeSec: machine.palletChangeSec,
      palletBatchParts: machine.palletBatchParts,
      intersectionSec: machine.intersectionSec,
      rapidSecPerPierce: machine.rapidSecPerPierce,
      lossFactor: machine.lossFactor,
    };
    const { hoursPerPart, detail } = laserHoursPerPart(laserParams);
    return { hoursPerPart, warnings, detail: { ...detail, partsPerSheet: laserParams.partsPerSheet } };
  }

  // hitBased
  if (rate.punchRateFactor <= 0) {
    return nothing([
      {
        code: 'material-not-cuttable',
        message:
          `${material.name} has a punch rate factor of ${rate.punchRateFactor} on ` +
          `${machine.name} — this stock cannot be punched here.`,
        partId,
      },
    ]);
  }

  const hits: PunchHitParams[] = [];
  for (const hit of part.cutting.hits) {
    const tool = machine.hitRates.find((t) => t.id === hit.hitRateId);
    if (tool === undefined) {
      warnings.push({
        code: 'unknown-punch-tool',
        message: `${machine.name} has no tool ${hit.hitRateId}; its hits are not priced.`,
        partId,
      });
      continue;
    }
    hits.push({
      name: tool.name,
      countPerPart: hit.countPerPart,
      hitsPerHr: tool.hitsPerHr,
      multiplier: tool.multiplier,
    });
  }

  const { hoursPerPart, detail } = punchHoursPerPart({
    hits,
    punchRateFactor: rate.punchRateFactor,
    partsPerBlank,
    loadUnloadSecPerBlank: machine.loadUnloadSecPerBlank,
    lossFactor: machine.lossFactor,
  });
  return { hoursPerPart, warnings, detail: { ...detail, partsPerBlank } };
}
