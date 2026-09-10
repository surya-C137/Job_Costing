/**
 * What the estimator entered — `PartInput` and `QuoteInput`.
 *
 * REQUIREMENTS §3 (Part, Quote) and §4 FR-2. Everything here is either a
 * measurement off the drawing or a reference into `ShopConfig`; nothing names
 * a machine, an alloy or a gauge (§12).
 *
 * All lengths are inches and all counts are **per part**. "Per 100" is a
 * display convention the estimator's screen may use and the engine never does
 * (§11.4 item 5).
 */

/**
 * A cut feature. The shapes are geometry, not shop-specific: a hole is a hole
 * whether a laser, a waterjet or a plasma torch makes it (§5.2).
 */
export type CutFeature =
  | {
      shape: 'hole';
      /** Hole diameter, inches. */
      diameterIn: number;
      /** How many of this hole are on one part. */
      count: number;
    }
  | {
      shape: 'obround';
      /** Overall slot length, inches. */
      lengthIn: number;
      /** Slot width — the diameter of the end radii, inches. */
      widthIn: number;
      count: number;
    }
  | {
      shape: 'rect';
      /** Cutout length, inches. */
      lengthIn: number;
      /** Cutout width, inches. */
      widthIn: number;
      count: number;
    }
  | {
      shape: 'misc';
      /** Cut length this feature adds, inches, when it is not one of the
       *  named shapes. */
      cutLengthIn: number;
      count: number;
    };

/** One tool striking a part a number of times (§5.3). */
export interface PunchHitInput {
  /** `PunchHitRate.id` on the selected machine. */
  hitRateId: string;
  /** Hits of this tool on one part. */
  countPerPart: number;
}

/**
 * How the blank gets its shape. Keyed by the selected machine's
 * `timeModel` rather than by a machine name — which is what lets a shop add a
 * waterjet in Settings and price it with the contributor that already exists
 * (§12 rule 2).
 */
export type CuttingInput =
  | {
      model: 'featureBased';
      /** Internal features, each counted per part. */
      features: CutFeature[];
      /** Outside profile cut length, inches per part. */
      perimeterCutIn: number;
      /** Cut-path intersections per part; each costs `Machine.intersectionSec`. */
      intersections: number;
    }
  | {
      model: 'hitBased';
      hits: PunchHitInput[];
    }
  | { model: 'none' };

/** How the blank is laid out on stock (§5.1). */
export interface NestingInput {
  /** `Machine.id` doing the cutting. Supplies clamp, kerf and the timing
   *  constants. */
  machineId: string;
  /** Stock width, inches — the edge the clamp comes off. */
  stockWidthIn: number;
  /** Cut length of the blank, inches. A plain input defaulting to the
   *  material's standard length; the UI may show yield for a few common
   *  lengths, but there is no lookup grid (§5.1). */
  blankLengthIn: number;
  /** Overrides `Machine.clampStripIn` for this part, inches. */
  clampStripInOverride?: number;
  /** Overrides `Machine.kerfIn` for this part, inches. */
  kerfInOverride?: number;
  /** Estimator's own nest count, overriding the computed one. */
  partsPerBlankOverride?: number;
}

/** A bought part fitted to the assembly (§3). */
export interface HardwareLine {
  description: string;
  /** How many of these go on one part. */
  qtyPerPart: number;
  /** Unit cost, $. */
  unitCostUsd: number;
}

/** One-time engineering, programming or tooling (§5.6). */
export interface NreLine {
  description: string;
  /** Hours, priced at `ShopDefaults.nreRatePerHrUsd`. */
  hours: number;
}

/** An operation applied to the part, with how much of it (§5.4). */
export interface OperationLine {
  /** `Operation.id`. */
  operationId: string;
  /** Units per part, counted in the operation's `standardUnit`: 4 bends,
   *  11 inches of weld. Never per 100. */
  countPerPart: number;
}

/** Finishing selections (§5.5). */
export interface FinishInput {
  /** `PlatingSpec.id`, when the part is plated. */
  platingSpecId?: string;
  /** Coating selection, when the part is painted or powder coated. */
  coating?: {
    /** `CoatingModel.id`. */
    coatingModelId: string;
    /** 1 or 2. The modern model charges by coated area (§11.3). */
    sidesCoated: 1 | 2;
    /** Features that have to be masked off before coating. */
    maskedFeatures: number;
  };
  /** `SilkscreenTier.id`, when the part is screened. */
  silkscreenTierId?: string;
}

/** One part on a quote (§3). */
export interface PartInput {
  id: string;
  /** Customer's part number. */
  partNumber: string;
  rev?: string;
  description?: string;
  /** `MaterialRow.id`. */
  materialId: string;
  /** Flat-pattern length, inches. */
  flatLengthIn: number;
  /** Flat-pattern width, inches. */
  flatWidthIn: number;
  /** Net area after holes, in², for finishing. Falls back to the blank area
   *  when the estimator has not measured it. */
  finishedAreaSqIn?: number;
  nesting: NestingInput;
  cutting: CuttingInput;
  /** §5.6 `sheet_extras` — freight-in, cut-to-size, drop charges. $ per part. */
  materialExtrasUsd?: number;
  /** §5.6 `setup_extra_labor` — one-off labour beyond the operations' own
   *  setups: fixturing, first-article. $ per job, amortised over the
   *  quantity. */
  setupExtraLaborUsd?: number;
  operations: OperationLine[];
  finish: FinishInput;
  hardware: HardwareLine[];
  nre: NreLine[];
}

/** A quote's worth of parts, priced at the same quantity breaks (§3). */
export interface QuoteInput {
  /** `Q-YYYY-NNNN`, or absent while the quote is unsaved. */
  quoteNumber?: string;
  /** Customer this is priced for; drives the RoHS warning (§11.2). */
  customer?: {
    id: string;
    name: string;
    /** Warn when a non-RoHS finish is picked for this customer. */
    rohsRequired: boolean;
    /** Overrides the shop's markups for this customer. */
    markupOverride?: number;
  };
  parts: PartInput[];
  /** Quantities to price. Defaults to `ShopDefaults.defaultQuantityBreaks`,
   *  editable per quote (§4 FR-2). */
  quantityBreaks: number[];
}
