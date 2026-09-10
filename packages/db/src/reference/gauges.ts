/**
 * Standard gauge tables, for a shop that arrives without a workbook.
 *
 * This is the one body of data in the repo that comes from the trade rather
 * than from `Quote_Metal_Cost.xls`, which is why it lives in `src/reference/`
 * and not in `seed/` — `seed/` is `scripts/extract-workbook.py` output and
 * gets overwritten on every run. Nothing here is read while pricing: it is
 * loaded once by `seed-blank.ts` and becomes rows the owner then edits (§12
 * rule 3 — seed data is a starting point, never a fallback in code).
 *
 * **Two conventions worth knowing, because they look like errors.**
 *
 * *Steel weights are the standard's, not the density's.* Manufacturer's
 * Standard Gauge defines 16 ga as 2.5 lb/ft²; mild steel at 0.2836 lb/in³
 * would make it 2.44. Shops buy and price by the MSG weight, so every steel
 * and galvanised row carries its book weight as `lbPerSqFtOverride` and the
 * family density is left at the true 0.2836 for anything quoted by thickness.
 * The workbook agrees on all four gauges it stocks — 16 ga 2.5, 14 ga 3.125,
 * 11 ga 5.0, 10 ga 5.625.
 *
 * *Galvanised thickness is the base metal; galvanised weight includes the
 * zinc.* Published galvanised-sheet-gauge tables give 16 ga as 0.0635 in,
 * which is steel plus coating. A drawing calling out 16 ga galvanised means
 * 16 ga steel, and the laser is cutting 0.0598 of it — so thickness here is
 * the base gauge and the coated weight rides in the override. That is the
 * workbook's own convention: its G30 16 GA row reads (.0598) at 2.656 lb/ft².
 *
 * One deliberate difference from the workbook: it stocks "ST STL 16 GA (.060)"
 * — stainless called out on the steel gauge table. The stainless table below
 * is the US Standard Gauge (16 ga = 0.0625), which is what a shop without this
 * workbook will mean. Neither shop's catalog is affected; this table is only
 * ever the starting point for a new one.
 */

import type { GaugeEntry, MaterialFamily } from '@shopquote/calc';

/** A family plus the gauge table a drawing for it is read against. */
export interface ReferenceFamily {
  key: string;
  name: string;
  /** lb/in³. */
  densityLbPerCuIn: number;
  /** Intake matching (§3, §8): what a drawing or CSV might call this. */
  aliases: string[];
  /** `[label, thicknessIn, lbPerSqFtOverride | null]`. */
  gauges: readonly (readonly [string, number, number | null])[];
}

/** Manufacturer's Standard Gauge, uncoated steel sheet: thickness, lb/ft². */
const MSG_STEEL = [
  ['3 ga', 0.2391, 10.0],
  ['4 ga', 0.2242, 9.375],
  ['5 ga', 0.2092, 8.75],
  ['6 ga', 0.1943, 8.125],
  ['7 ga', 0.1793, 7.5],
  ['8 ga', 0.1644, 6.875],
  ['9 ga', 0.1495, 6.25],
  ['10 ga', 0.1345, 5.625],
  ['11 ga', 0.1196, 5.0],
  ['12 ga', 0.1046, 4.375],
  ['13 ga', 0.0897, 3.75],
  ['14 ga', 0.0747, 3.125],
  ['15 ga', 0.0673, 2.8125],
  ['16 ga', 0.0598, 2.5],
  ['17 ga', 0.0538, 2.25],
  ['18 ga', 0.0478, 2.0],
  ['19 ga', 0.0418, 1.75],
  ['20 ga', 0.0359, 1.5],
  ['21 ga', 0.0329, 1.375],
  ['22 ga', 0.0299, 1.25],
  ['23 ga', 0.0269, 1.125],
  ['24 ga', 0.0239, 1.0],
  ['25 ga', 0.0209, 0.875],
  ['26 ga', 0.0179, 0.75],
  ['27 ga', 0.0164, 0.6875],
  ['28 ga', 0.0149, 0.625],
  ['29 ga', 0.0135, 0.5625],
  ['30 ga', 0.012, 0.5],
] as const;

/** Galvanised Sheet Gauge weights (G90 coating included), against the base
 *  steel thickness — see the note at the top of the file. */
const GSG_GALVANIZED = [
  ['8 ga', 0.1644, 7.031],
  ['9 ga', 0.1495, 6.406],
  ['10 ga', 0.1345, 5.781],
  ['11 ga', 0.1196, 5.156],
  ['12 ga', 0.1046, 4.531],
  ['13 ga', 0.0897, 3.906],
  ['14 ga', 0.0747, 3.281],
  ['15 ga', 0.0673, 2.969],
  ['16 ga', 0.0598, 2.656],
  ['17 ga', 0.0538, 2.406],
  ['18 ga', 0.0478, 2.156],
  ['19 ga', 0.0418, 1.906],
  ['20 ga', 0.0359, 1.656],
  ['21 ga', 0.0329, 1.531],
  ['22 ga', 0.0299, 1.406],
  ['23 ga', 0.0269, 1.281],
  ['24 ga', 0.0239, 1.156],
  ['25 ga', 0.0209, 1.031],
  ['26 ga', 0.0179, 0.906],
  ['27 ga', 0.0164, 0.844],
  ['28 ga', 0.0149, 0.781],
  ['29 ga', 0.0135, 0.719],
  ['30 ga', 0.012, 0.656],
] as const;

/** US Standard Gauge, as stainless is sold. Weight is derived from density. */
const STAINLESS = [
  ['7 ga', 0.1875, null],
  ['8 ga', 0.1719, null],
  ['9 ga', 0.1562, null],
  ['10 ga', 0.1406, null],
  ['11 ga', 0.125, null],
  ['12 ga', 0.1094, null],
  ['13 ga', 0.0937, null],
  ['14 ga', 0.0781, null],
  ['15 ga', 0.0703, null],
  ['16 ga', 0.0625, null],
  ['17 ga', 0.0562, null],
  ['18 ga', 0.05, null],
  ['19 ga', 0.0437, null],
  ['20 ga', 0.0375, null],
  ['21 ga', 0.0344, null],
  ['22 ga', 0.0312, null],
  ['23 ga', 0.0281, null],
  ['24 ga', 0.025, null],
  ['25 ga', 0.0219, null],
  ['26 ga', 0.0187, null],
  ['27 ga', 0.0172, null],
  ['28 ga', 0.0156, null],
] as const;

/** Brown & Sharpe, which is what an aluminium gauge callout means. Most
 *  aluminium is specified by decimal thickness instead. */
const BS_ALUMINUM = [
  ['6 ga', 0.162, null],
  ['7 ga', 0.1443, null],
  ['8 ga', 0.1285, null],
  ['9 ga', 0.1144, null],
  ['10 ga', 0.1019, null],
  ['11 ga', 0.0907, null],
  ['12 ga', 0.0808, null],
  ['13 ga', 0.072, null],
  ['14 ga', 0.0641, null],
  ['15 ga', 0.0571, null],
  ['16 ga', 0.0508, null],
  ['17 ga', 0.0453, null],
  ['18 ga', 0.0403, null],
  ['19 ga', 0.0359, null],
  ['20 ga', 0.032, null],
  ['21 ga', 0.0285, null],
  ['22 ga', 0.0253, null],
  ['23 ga', 0.0226, null],
  ['24 ga', 0.0201, null],
] as const;

/** The four families a sheet metal shop reads gauges for. A shop that cuts
 *  copper, brass or acrylic adds the family in Settings. */
export const REFERENCE_FAMILIES: readonly ReferenceFamily[] = [
  {
    key: 'steel',
    name: 'Steel',
    densityLbPerCuIn: 0.2836,
    aliases: ['CRS', 'HRS', 'HRPO', 'A36', 'CQ', 'mild steel', 'cold rolled', 'hot rolled'],
    gauges: MSG_STEEL,
  },
  {
    key: 'galvanized',
    name: 'Galvanized',
    densityLbPerCuIn: 0.2836,
    aliases: ['galv', 'G90', 'G60', 'G30', 'galvanneal', 'A60', 'EZC', 'hot dip'],
    gauges: GSG_GALVANIZED,
  },
  {
    key: 'stainless',
    name: 'Stainless',
    densityLbPerCuIn: 0.289,
    aliases: ['SS', 'CRES', 'ST STL', '304', '304L', '316', '316L', '430'],
    gauges: STAINLESS,
  },
  {
    key: 'aluminum',
    name: 'Aluminum',
    densityLbPerCuIn: 0.097,
    aliases: ['alum', 'AL', '5052', '5052-H32', '6061', '6061-T6', '3003'],
    gauges: BS_ALUMINUM,
  },
];

/** Ids match the seed adapter's convention, so a blank shop and a seeded one
 *  read the same way in an exported config JSON. */
const familyId = (key: string): string => `family:${key}`;
const gaugeId = (familyKey: string, label: string): string =>
  `gauge:${familyKey}-${label.replace(/\s+/g, '')}`;

/** The families, as `ShopConfig` rows. */
export function referenceFamilies(): MaterialFamily[] {
  return REFERENCE_FAMILIES.map((f) => ({
    id: familyId(f.key),
    name: f.name,
    densityLbPerCuIn: f.densityLbPerCuIn,
    defaultScrapPricePerLbUsd: 0,
    aliases: [...f.aliases],
  }));
}

/** Every gauge row across every family, as `ShopConfig` rows. */
export function referenceGauges(): GaugeEntry[] {
  return REFERENCE_FAMILIES.flatMap((f) =>
    f.gauges.map(([label, thicknessIn, lbPerSqFtOverride]) => ({
      id: gaugeId(f.key, label),
      familyId: familyId(f.key),
      label,
      thicknessIn,
      lbPerSqFtOverride,
    })),
  );
}
