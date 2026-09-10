# Course correction — audit and proposed simplification

**Status: executed 2026-09-10.** Approved as written; the four open decisions are answered in §3. The seed, the golden fixture, `scaffold.test.ts`, CLAUDE.md and REQUIREMENTS §5.3/§5.7 now match this document, and `docs/decisions.md` carries the calls that went beyond it. Kept as the record of what was cut and why — read it before adding anything back.

The workbook is (1) a record of how this shop thinks about cost, (2) seed data the owner
overwrites on day one, and (3) a validation oracle for a handful of numbers. It is not a
specification to replicate. This document audits what was built against that, and proposes the
replacement types.

The test applied throughout: **would a shop that never had this spreadsheet want this?**

---

## 1. Audit

### 1.1 Seed data — `packages/db/seed/`

| Item | Verdict | Notes |
|---|---|---|
| `materials[].name`, `family`, `thicknessIn`, `lbPerSqFt`, `pricePerLb`, `stdLength`, `speedInMin`, `pierceS`, `punchRateFactor`, `active` | **KEEP** | Real material properties. Any shop wants these. |
| `materials[].sheet_cost`, `sheet_lbs` | **KEEP** | Provenance for $/lb, and the owner's actual mental model when repricing (§11.2 wants `$/cwt` entry for the same reason). Null on most rows — the workbook reuses those columns for scratch. |
| `materials[].item` | **DELETE** | The workbook's index number ("material #47"). Reference by id. |
| `materials[].row` | **DELETE** | Spreadsheet row. Provenance belongs in the extractor's log, not in runtime data. Applies to every table below — I'll stop listing it. |
| `materials[].optics_in` | **DELETE** | Laser lens size. A machine attribute filed under material, and nothing reads it. |
| `materials[].speed_max_m_min`, `speed_min_m_min`, `speed_avg_m_min` | **DELETE** | The workbook's derivation of `speedInMin`, in metres. Keeping the arithmetic's inputs alongside its output invites the two to disagree. **This reverses a call you made earlier in the session** ("Full, with price provenance") — flagging it rather than quietly dropping it. |
| `operations[].name`, `setupHrs`, `ratePerHr`, `active` | **KEEP** | setup + standard + rate is the concept worth having. |
| `operations[].std` | **SIMPLIFY** | Meaningful for manual ops (features/hr). For machine ops it is the literal constant `100`, present only so the `×K/std` formula resolves. Becomes `standardPerHr: number \| null`, null for machine ops. |
| `operations[].k_factor_observed` | **DELETE** | 19 of 20 rows are null, and the one populated value (60) is a property of the *pricing rule*, not of the operation. Replaced by `kind: 'machine' \| 'manual'` plus one parity number. See §2.3. |
| `plating[].spec`, `lotMinCharge`, `pricePerSqIn`, `partMin` | **KEEP** | The `MAX(lot min, $/in², part min)` concept, unchanged. |
| `coating.models[].s_constant`, `coverage`, `rate` | **KEEP, renamed** | Unexplained constants 5/100/0.5, but they are Q3's legacy model and the golden case needs them. Named as legacy-model params so nobody mistakes them for physics. |
| `coating.models[].observed_area_or_perimeter`, `observed_cost`, `observed_vpf` | **DELETE** | These are the *loaded quote's outputs* sitting in a settings table. `observed_cost: 1.0619` is the golden part's coating cost. Not seed data at all. |
| `coating.observed_sub_total`, `observed_minimum_rate` | **DELETE** | Same — one quote's totals. |
| `coating.adders` | **KEEP** | Plugs, fill/prep, masking, mask/demask $/hr, parts per hook/hanger. Real finishing costs. |
| `punch_rates.tools[]` | **KEEP, minus one** | Hit rate by tool type is a real model. |
| `punch_rates.tools[] "TOTAL HIT COUNT"` | **DELETE** | A spreadsheet subtotal row masquerading as a tool, sitting between "TAP" and "Relief" with a 6000/hr rate. |
| `punch_rates.observed_sheets_for_100`, `observed_hit_density_per_sq_ft` | **DELETE** | Quote outputs again. |
| `punch_rates.load_unload_s_per_blank` | **KEEP** | 40 s/blank is a real standard. |
| `blank_multiples.multiples_in` | **KEEP, renamed** | → `standardBlankLengthsIn`. Shops buy standard lengths and pick the one that nests best; §5.1 makes this a visible feature. This is the *list*, not the workbook's 48-row precomputed yield grid — that grid was never extracted. |
| `blank_multiples.clamp_subtracted_widths_in` | **DELETE** | `[35, 36, 47, 48, 59, 60]` — each width and its width-minus-clamp twin. Pure helper-column residue; clamp subtraction is one line of arithmetic. |
| `process_presets[].index` | **DELETE** | Dropdown position ("sheet width #2"). |
| `process_presets[].name` | **SIMPLIFY** | `"LASER, 1\" CLAMP DIM"` encodes the clamp value in the label *and* in `clamp_in`. → `"Laser"`. |
| `shop_defaults.min_charge_strip_in` | **SIMPLIFY** | Currently `{value: 12, source: "derived", from: "W7 / (V7, Q170, R170)"}`. Extraction provenance leaking into config. → `12`. |
| `shop_defaults.*` (markups, fixed cost, NRE, breaks, widths) | **KEEP** | All owner-editable settings. |
| `assembly_standards[]` | **KEEP** | Seconds per action. Genuinely useful and hard to reconstruct. |

### 1.2 Golden fixture — `packages/calc/test/fixtures/golden-workbook.json`

Currently 138 lines carrying the whole workbook state. The oracle is much smaller.

| Item | Verdict |
|---|---|
| Inputs: material properties, part geometry, clamp/kerf/stock/blank, laser features, op setup+rate, coating params, markups, breaks | **KEEP** — the engine needs them to reproduce the case |
| `expected.selling_price[6]`, `expected.material_pct_of_selling[6]` | **KEEP** — the parity test |
| `intermediates.blank_cost`, `min_charge`, `material_per_part`; `sheet_material[0]` (qty-1 = 10.3254); laser hours | **KEEP** — the named intermediates |
| `material.cell: "C170"`, `intermediates.*.cell` / `.source` / `.from` | **DELETE** — cell addresses in a test fixture |
| `laser_op.k_factor_observed`, `oper_hrs`, `std`, `hrs_per_100` | **DELETE** — workbook mechanics |
| `laser.parts_per_sheet`, `sheets_to_make_100`, `blanks_per_sheet` | **DELETE** — intermediate columns |
| `expected.fixed_cost[6]`, `direct_labor[6]`, `painting[6]` | **DELETE** — these assert the workbook's cost-stack rows line by line, which is exactly the over-fitting to avoid |

### 1.3 Code

| Item | Verdict |
|---|---|
| Monorepo scaffold, tsconfigs, ESLint (incl. calc purity rules), Vitest, Prettier | **KEEP** — nothing workbook-shaped |
| `packages/calc/src/index.ts` doc comment | **SIMPLIFY** — says "feature list → cut inches → hours/100"; per-part now |
| `packages/calc/test/scaffold.test.ts` | **SIMPLIFY** — asserts `parts_per_blank === 33` and material properties, which is fixture integrity, not engine behaviour. Reduce to the six prices once the engine exists. |
| `scripts/extract-workbook.py` cell map | **KEEP** — reading an `.xls` is inherently cell-addressed. The fix is what it *emits*, not how it reads. |

**Not carried over in the first place** (listed for completeness, since they were called out): the
Vantage sheet factor, the 48-row blank-efficiency grid, hidden helper columns AF–AT, the per-quote
columns in the operations and assembly tables, and every quirk beyond the five in §5.7.

---

## 2. Proposed calc types

Rules: per-part everywhere, units in field names, dollars as `Usd`, references by id, no per-100,
no index lookups.

### 2.1 ShopConfig

```ts
interface ShopConfig {
  schemaVersion: 1;
  shopId: string;

  rates: {
    fixedCostPerJobUsd: number;      // 20
    laborMarkup: number;             // 1.2
    materialMarkup: number;          // 1.2
    nreRatePerHrUsd: number;         // 100
    nreMarkup: number;               // 1.3
    minChargeStripIn: number;        // 12
  };

  defaultQuantityBreaks: number[];   // six slots, editable contents (§11.2/§11.5)
  sheetWidthsIn: number[];           // [36, 48, 60]
  standardBlankLengthsIn: number[];  // 12 … 144

  materials: Material[];
  operations: Operation[];
  platingSpecs: PlatingSpec[];
  coatingModels: CoatingModel[];
  silkscreenTiers: SilkscreenTier[];
  processPresets: ProcessPreset[];
  punchTools: PunchTool[];
  assemblyStandards: AssemblyStandard[];

  parity: ParityFlags;
}

interface Material {
  id: string;                 // ULID at runtime; the slug is the stable seed key
  name: string;               // "G30 16 GA (.0598)"
  family: 'steel' | 'galv' | 'stainless' | 'aluminum' | 'copper' | 'brass' | 'wood' | 'other';
  thicknessIn: number | null;
  lbPerSqFt: number;
  pricePerLbUsd: number;
  surchargePct: number;       // §11.2, default 0
  standardLengthIn: number;
  cutSpeedInPerMin: number;
  pierceSeconds: number;
  punchRateFactor: number;
  sheetCostUsd: number | null;   // provenance for pricePerLbUsd
  sheetLbs: number | null;
  active: boolean;
}

interface Operation {
  id: string;
  name: string;
  kind: 'machine' | 'manual';
  setupHrs: number;
  standardPerHr: number | null;  // manual: features or inches per hour. machine: null
  ratePerHrUsd: number;
  assistGasPerHrUsd: number;     // §11.2, default 0
  active: boolean;
}

interface ProcessPreset {
  id: string;
  name: string;                  // "Laser", "Punch"
  clampIn: number;
  kerfIn: number;                // 0.5 legacy, 0.25-0.375 fibre - a setting, not a flag
}

interface PlatingSpec {
  id: string;
  name: string;
  aliases: string[];             // §11.2 - old drawings carry old spec names
  lotMinimumUsd: number;
  pricePerSqInUsd: number;
  partMinimumUsd: number;
  rohsCompliant: boolean | null;
  active: boolean;
}

interface CoatingModel {
  id: string;
  name: string;
  minimumChargeUsd: number;
  /** Q3. cost = rateUsd × (perimeterIn ÷ coverage × sConstant). Constants unexplained; §10 q2. */
  legacy: { rateUsd: number; coverage: number; sConstant: number } | null;
  /** §11.3. cost = coatedAreaSqIn ÷ coverageSqFtPerLb × powderPricePerLbUsd + rack + masking. */
  modern: {
    coverageSqFtPerLb: number;
    powderPricePerLbUsd: number;
    rackLaborUsdPerPart: number;
  } | null;
}
```

### 2.2 PartInput

```ts
interface PartInput {
  id: string;
  partNumber: string;
  rev?: string;
  description?: string;

  materialId: string;
  flatLengthIn: number;
  flatWidthIn: number;
  finishedAreaSqIn?: number;

  nesting: {
    processPresetId: string;
    stockWidthIn: number;
    blankLengthIn: number;
    clampInOverride?: number;
    kerfInOverride?: number;
    partsPerBlankOverride?: number;
  };

  cutting:
    | { method: 'laser'; features: LaserFeature[]; perimeterCutIn: number; intersections: number }
    | { method: 'punch'; hits: { punchToolId: string; countPerPart: number }[] }
    | { method: 'none' };

  /** countPerPart, never per 100: 4 bends, 11 inches of weld. */
  operations: { operationId: string; countPerPart: number }[];

  finish: {
    platingSpecId?: string;
    coating?: { coatingModelId: string; sidesCoated: 1 | 2; maskedFeatures: number };
    silkscreenTierId?: string;
  };

  hardware: { description: string; qtyPerPart: number; unitCostUsd: number }[];
  nre: { description: string; hours: number }[];

  quantityBreaks: number[];
}

type LaserFeature =
  | { shape: 'hole'; diameterIn: number; count: number }
  | { shape: 'obround'; lengthIn: number; widthIn: number; count: number }
  | { shape: 'rect'; lengthIn: number; widthIn: number; count: number }
  | { shape: 'misc'; cutLengthIn: number; count: number };
```

### 2.3 Where the ×60 goes

Working the workbook's arithmetic through to per-part:

```
laser machine time    0.522545 h per 100  →  0.00522545 h per part
workbook charges      × 60/100            →  × 0.6
direct labour         0.00522545 × 0.6 × $100/hr = $0.313527 per part   ✓ matches
```

So Q2 is one number — machine labour is billed at 0.6 × machine time — and `std = 100` was
scaffolding for Excel's formula. Manual ops need no factor at all: `countPerPart ÷ standardPerHr`
gives hours directly.

```ts
interface ParityFlags {
  /** Q1. Material markup applied inside the minimum-charge MAX. */
  markupInsideMinChargeMax: boolean;
  /** Q2. Machine labour billed at this × machine time. 0.6 = workbook, 1.0 = defensible. */
  machineTimeFactor: number;
  /** Q3. Perimeter-as-area coating vs the §11.3 model. */
  legacyCoatingModel: boolean;
  /** Q4. Coating and silkscreen added after markups. */
  finishesUnmarked: boolean;
}
```

**Q5 stops being a flag.** Kerf is a `ProcessPreset` field an owner edits, which is what §11.2
already calls it ("Process preset"). Nothing is lost: the golden case pins kerf 0.5 in its fixture,
and a fibre shop sets 0.375 in Settings without a code path. That drops the flag count to four.

### 2.4 CostStack

Every field is **dollars for one part at that quantity**.

```ts
interface CostStack {
  quantity: number;

  materialUsd: number;          // share of blank, or the minimum charge
  materialExtrasUsd: number;
  hardwareUsd: number;
  platingUsd: number;
  materialBlockUsd: number;     // the four above × materialMarkup

  setupAmortizedUsd: number;    // fixed cost ÷ quantity
  directLaborUsd: number;
  laborBlockUsd: number;        // the two above × laborMarkup

  coatingUsd: number;           // unmarked while Q4 is on
  silkscreenUsd: number;

  sellingPriceUsd: number;
  materialPctOfSelling: number;

  warnings: Warning[];          // min charge applied, yield < 50%, doesn't fit, non-RoHS finish
}

interface QuoteResult {
  breaks: CostStack[];
  nesting: { partsPerBlank: number; orientation: 'length' | 'width'; yieldPct: number };
  warnings: Warning[];
}
```

Hours appear in `QuoteResult` only if the UI wants them, converted at the edge — §11.4 already
calls hours-per-100 a display convention.

---

## 3. Decisions — answered 2026-09-10

1. **The oracle is five intermediates**, besides the six selling prices and six material
   percentages: blank cost 68.8358, min charge 8.6045, material per part 2.0859, qty-1 material
   10.3254, laser hours. BUILD-PLAN 1.2's acceptance check is the first four and 1.3's is the fifth.
   No test may assert a workbook number outside this list.

2. **The laser oracle is stored per part**: `laser_hours_per_part` = 0.005225454545, the workbook's
   0.52255 h/100 divided by 100. The fixture carries a `_note` with the conversion so the number is
   still traceable to the sheet by eye.

3. **`speed_max/min/avg_m_min` are deleted**, confirming the reversal flagged in §1.1.
   `speed_in_min` is what the engine uses; keeping the metric inputs it was derived from invites the
   two to disagree the first time an owner edits a speed in Settings. `sheet_cost`/`sheet_lbs` stay,
   because those are the owner's repricing model rather than extraction bookkeeping.

4. **§1 and §2 executed as written**, including Q5-kerf-as-a-`ProcessPreset`-field (five flags → four)
   and Q2 as a numeric `machineTimeFactor` rather than a boolean.

One item in §2.1 is still open and is now noted in `docs/discovery.md`:
`CoatingModel.minimumChargeUsd` has no source in the workbook — W67 holds the loaded quote's own
cost (1.0619), not a floor — so it is left unset rather than seeded with a number that would look
authoritative.

---

## 4. CLAUDE.md amendment — applied 2026-09-10

Replacing principle 1:

> 1. **Parity on the golden outputs, not on the workbook's mechanics.** The engine must reproduce
>    the six §9 selling prices to ±0.005 and the named intermediates. Nothing else in the workbook
>    needs to reproduce. Never edit the fixture to make a test pass — but equally, never add a test
>    that pins a workbook intermediate outside that list.

And a new section near the top:

> ## What the workbook is
> `docs/reference/Quote_Metal_Cost.xls` is three things and no others:
> 1. **A record of how this shop thinks about cost** — share-of-blank material, minimum strip,
>    setup amortised over quantity, operations as setup + standard + rate, plating as
>    lot-min/per-in²/part-min. Take the concepts; model them in our own types.
> 2. **Seed data** — materials, speeds, rates, plating, assembly seconds. Settings rows the owner
>    overwrites on day one, not logic.
> 3. **A validation oracle** for the six selling prices and a handful of intermediates.
>
> Do not carry over: cell layout, helper columns, index-number lookups, "hours per 100" as an
> internal representation, the blank-multiples yield grid, or any quirk beyond the four in §5.7.
> If a mechanism doesn't change a selling price or help the estimator, it doesn't go in.
>
> The measure of the app is the estimator's workflow: RFQ in → parts entered fast (CSV/PDF/DXF) →
> live cost stack → quote PDF → logged. When unsure whether something belongs, ask whether a shop
> that never had this spreadsheet would want it.
