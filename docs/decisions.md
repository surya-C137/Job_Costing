# Decisions

Choices made where the spec was silent. Newest first. Format: date · decision · why · alternatives.

---

## 2026-09-10 — Task 1.3, cutting time (laser and punch)

**§5.2's pallet rule did not reproduce §9, and the workbook wins.**
The section read "pallet change 60 s ÷ parts_per_sheet (only if pps < 100)".
For the golden part that is 60 ÷ 41.25 = 1.45 s per part, and it misses the
laser oracle by 4.91% — 0.0054818 h/part against 0.0052255. Reading the LASER
WORKSHEET directly settles it:

```
B27 Pierce Hours            2.7778e-05   = 1 x 0.1s / 3600
F29 PerimeterCut Hours      4.3939e-03   = 58 / 220 / 60
F31 Intersection Factor     8.3333e-05   = 1 x 0.3s / 3600
F32 Rapid Factor            1.6667e-04   = 1 x 0.6s / 3600
F33 Pallet Change Hrs/Part  1.6667e-04   = 0.6s  <- 60/100, not 60/41.25
F34 Total per 100 w/loss    0.52254545   = sum x 108   (100 parts x 1.08 loss)
```

So the rule is: one pallet change per batch of 100, spread across that batch,
charged only while a single sheet yields fewer than 100 parts. Both the
threshold and the divisor are that same 100, so `Machine.palletThresholdParts`
was renamed `palletBatchParts` and does both jobs. §5.2 was corrected; the
engine follows the workbook, not the prose, because §9 is the oracle and the
prose is not.

*This is not certain.* `F33` is numerically identical to `F32`, so a
copy-paste in the workbook would look the same from one saved quote, and
Office File Block prevents reading the formula. The reading that reproduces §9
was chosen, the ambiguity is now REQUIREMENTS §10 question 10, and the
extractor asserts the `F33 == F32` coincidence on every run so a newer save
that breaks the tie is noticed.

**Pierces are counted per feature instance, not per feature row.**
§5.2 says "feature count + 1"; a row of 200 holes is 200 pierces, because the
machine stops and pierces at each one. The golden part has no internal
features, so its single pierce cannot distinguish the readings — physics can.
*Alternative:* count rows (rejected — it would price a 200-hole part as though
it had one hole).

**Cutting returns hours; `operations.ts` turns them into dollars.**
§5.4 is explicit that machine ops take "hours from §5.2/§5.3 per part" and then
apply the rate and quirk Q2's factor. So `laser.ts` and `punch.ts` are not cost
contributors — they are time models, and Task 1.4's operations contributor is
what registers. This keeps `machineTimeFactor` in exactly one place rather than
duplicated across every cutting module.

**`cutting.ts` resolves; `laser.ts` and `punch.ts` compute.**
BUILD-PLAN 1.3 requires that inputs are explicit numbers and never looked up
inside calc, and separately that a missing rate warns rather than throws. Those
pull in opposite directions, so they are separate files: the time models take
plain numbers and have no idea what a `ShopConfig` is, and one resolver reads
the machine row and the machine-material rate, emits the warnings, and hands
down numbers. It also dispatches on `Machine.timeModel`, which is what lets a
waterjet reach the feature-based model without naming itself (§12 rule 2).

**Punch model, where §5.3 is silent.** `Σ(hits × multiplier ÷ (hitsPerHr ×
punchRateFactor)) + loadUnload ÷ partsPerBlank`, all times `lossFactor`. The
rate factor divides rather than multiplies time — a factor below 1 means the
stock punches more slowly. A factor of zero means the pairing cannot be punched
at all (the workbook seeds 0 against quarter-inch plate), which is a
`material-not-cuttable` warning rather than a division by zero. `lossFactor` is
applied to punching as well as cutting because it is a machine property, not a
laser one; a shop that disagrees sets 1.0 on that machine. No golden case
covers any of this — the §9 quote ran on the laser — so it is validated against
hand-worked cases and should be checked in the Task 5.2 pilot.

**Three new warning codes**: `cutting-model-mismatch` (a hit counter against a
laser), `unknown-punch-tool`, `material-not-cuttable`. All follow §12 rule 3 —
zero hours plus a warning naming what is missing, never a silent default.

---

## 2026-09-10 — Task 1.2, calc types, contributor registry, material module

**A machine's `timeModel` decides how it is priced, not its name.**
`CuttingInput` is keyed `featureBased | hitBased | none` rather than
`laser | punch`. A waterjet and a plasma torch are feature-based — a path cut at
a speed — so a shop adds one in Settings and the existing contributor prices it.
`Machine.kind` survives as a label for grouping and the UI, and nothing branches
on it. This is REQUIREMENTS §12 rule 2 made concrete, and it is what the earlier
`method: 'laser' | 'punch' | 'none'` union would have prevented. *Alternative:*
one contributor per machine kind (rejected — five near-identical modules, and a
sixth for every process a shop takes up).

**§5.1's nesting charges kerf to every part; the prototype charges it between
parts.** `fitCount()` is `floor(usable / (dim + kerf))`, so a part exactly
filling the stock yields one fewer than the prototype's
`floor((usable + gap) / (dim + gap))` would. Both reproduce the two acceptance
cases (33 up on 48 × 96 at 0.5 kerf; 42 up on 48 × 120 at 0.375), which is why
the difference went unnoticed — they only diverge when a part lands within one
kerf of the edge. §5.1 is the spec and the shop's convention, so §5.1 wins.
A `FIT_EPSILON` of 1e-9 keeps a division that should land on 6 from arriving as
5.999999999999999.

**The minimum charge is not capped at the blank length.** The prototype capped
it (`sheetPrice × min(minStrip, sl) / sl`); §5.1 does not. A 6-inch blank still
costs a 12-inch strip, which is the entire point of a minimum. No golden number
moves either way. *Alternative:* follow the prototype (rejected — it would let
a short blank price below the stock the shop has to buy).

**Registries are immutable and passed in.** `createRegistry()` returns a frozen
lookup; there is no module-level mutable map. Calc is pure, and a global
registry is shared mutable state that would make one test's registration visible
to the next. A second trade calls `createRegistry()` with its own list.
`resolve()` returns `unknown` ids separately so the caller warns rather than
pricing a switched-on module as zero (§12 rule 3). Duplicate ids throw — that is
a programming error at startup, not an expected condition, so it is the one
place calc throws.

**"Part does not fit" is both a typed failure and a warning.** `materialForPart()`
returns `Result` with `part-does-not-fit` so a caller can refuse; the contributor
turns it into an amber warning and returns $0, because CLAUDE.md's Design section
lists it among warnings that never block. The estimator sees the rest of the
stack and fixes the stock size. Task 1.4's roll-up must not print a quote
carrying that warning.

**Material surcharge folds into the effective $/lb.** It is a price adjustment on
the same stock (§11.2), so `pricePerLbUsd × (1 + surchargePct)` feeds blank cost
and minimum charge alike. §5.6's `sheet_extras` bucket stays free for freight-in
and the like. Zero on every seeded row, so no golden number moves.

**Scrap credit is not implemented yet.** §5.1's share-of-blank has no scrap term
and the golden case has no scrap. `MaterialRow.scrapPricePerLbUsd` and
`MaterialFamily.defaultScrapPricePerLbUsd` exist so the schema does not move
later; §11.4 item 4 keeps the feature off by default. The prototype's `costAt()`
has three costing methods (full sheet, yield, net footprint) with scrap credit in
each — none of that is §5.1, so none of it was ported.

**A per-workspace Vitest config, because the acceptance check needs one.**
`npm test -w packages/calc` — BUILD-PLAN's per-task check — failed with "No
projects were found": the root config's `projects: ['packages/*', 'apps/*']`
globs resolve against Vitest's root, which becomes the package directory when
run that way. `packages/calc/vitest.config.ts` gives the workspace a root of its
own. It deliberately has no `@shopquote/*` alias: a path back to a sibling
package is what must never resolve from calc.

**Coverage excludes three type-only modules.** `types/config.ts`, `types/part.ts`
and `types/contributor.ts` compile to nothing, so v8 counts every interface body
and JSDoc line as uncovered — `config.ts` alone is ~400 such lines, and the calc
threshold came out at 28% with the runtime code fully covered. `types/result.ts`
and `types/index.ts` are not excluded: they carry `ok()` and `err()`.
`packages/calc/src` now measures 99.6% statements, 98.7% branches, 100%
functions. *Alternative:* a `*.types.ts` naming convention and one glob
(reasonable, and worth doing if the list grows past a handful).

**The golden `ShopConfig` is built in a test helper, not from the seed.**
`test/helpers/golden-config.ts` assembles a config from the fixture's own inputs.
The seed-JSON-to-`ShopConfig` adapter — which has to split the workbook's
speed/pierce/punch-factor columns into `machineMaterialRates`, since §3 keeps
machine numbers off the material row — is still owed. BUILD-PLAN 2.1 has
`seed.ts` doing it, but Task 1.4's golden test runs with no database, so it needs
the same mapping first. Write it once in 1.4 and have `seed.ts` reuse it.
Three §5.2 constants the fixture does not carry (`intersectionSec` 0.3,
`rapidSecPerPierce` 0.6, `palletBatchParts` 100) are set from §5.2's stated
values in that helper and are pinned properly by Task 1.3's laser oracle.

---

## 2026-09-10 — Spec reconciliation before Task 1.2

Ten discrepancies found reviewing the revised REQUIREMENTS/BUILD-PLAN/CLAUDE.md against
the course correction and the seed. Four were resolved by the §3 rewrite (machines as
work centers) and §12 (data vs. code); the rest are below.

**Fixed cost is the setup roll-up, not a shop constant.** *(owner-approved)*
§5.6 read `fixed_cost = Σ op fixed_$ + shop fixed cost ($20) + NRE`, which prices the §9
part at $40 of fixed cost where the workbook shows $20 — it would have missed all six
selling prices. The evidence says D13 is a sum, not a setting: Σ(setupHrs × rate) over the
catalog is exactly $20.00, laser is the only operation carrying setup, and D13 is $20.00.
So `fixed_cost = Σ(setupHrs × ratePerHr) + shopFixedCostPerJob + NRE`, and the seed's
`shop_fixed_cost_per_job` is **0**, not 20 — a flat per-job adder a shop may set, seeded
empty. This is the same "loaded quote's output in a settings table" pattern already removed
from coating and punch. The extractor asserts the D13-equals-setup-roll-up relationship on
every run and files a note if a future save breaks it. *Alternative:* treat the $20 as a
shop charge and bill setup inside direct labor (rejected — a job with three setups would
then cost the same as a job with one).

**The oracle is seventeen numbers, stated once.** Six selling prices, six material
percentages, five intermediates. "The ten golden numbers" appeared in four places and
matched no reading: it omitted the material percentages that Task 1.4 asserts and the laser
hours that 1.3 asserts. §9 now carries the five intermediates in a table naming which task
asserts each; CLAUDE.md and BUILD-PLAN's three copies point at it instead of counting.

**Q5 withdrawn a second time, and the reason recorded where it will be read.**
The revised docs restored kerf as a parity flag in three places while §5.7's own text still
called it a Setting. Kerf is now a **machine row** field — §3 moved clamp/kerf off "process
presets" and onto machines, which is stronger than the earlier `ProcessPreset.kerfIn`: a
shop with two lasers gives each its own. §12 rule 1 settles it — a value that differs
between two shops in the same trade is Settings data, not a flag. Four flags remain.

**`parity.machineTimeFactor`, a number.** §5.4 and BUILD-PLAN 1.4 had reverted to
`machineOpsFactor60` with `(flag && machineOp ? 0.6 : 1)`, which puts 0.6 back in code —
the number the correction moved into config. Now `isMachineOp ? parity.machineTimeFactor : 1`.

**Operations carry `standard_unit`.** §3 asked for a unit of measure; the seed had a bare
`standard_per_hr`, so nothing could tell 4 bends from 11 inches of weld. Seeded `pieces`
everywhere except WELD and GRIND (`inches`), null for machine ops. Which of 200/hr and
120 in/hr the workbook's 200 actually is remains ambiguous — noted in `docs/discovery.md`
for §10 q1. Also aligned §3's `isMachineOp` to the seed's existing `kind: machine | manual`,
which extends to a third kind without a schema change and is implied by a machine link.

**The workbook's tumble formula is not seeded.** §6 carried
`time = min(0.004 × area + 0.6, 2) h/100` — a per-100 expression keyed to one operation's
name, and the only row in the catalog that would price unlike every other. Tumble seeds as
an ordinary 100/hr row. If the owner confirms the area rule matters it returns as an
optional area-based standard *any* operation can use. *Alternative:* special-case it in
`operations.ts` (rejected — §12 rule 1).

**Machine constants named, not inlined.** §5.2 still had `0.3 s`, `0.6 s`, `60 s`,
`pps < 100` and `1.08` as literals with no home. They are now machine-row fields —
`intersectionSec`, `rapidSec`, `palletChangeSec`, `palletBatchParts`, `lossFactor` —
listed in §3 and referenced by name in §5.2. Same for §5.1's literal 12
(`minChargeStripIn`) and its "laser 1 in, punch 2 in" clamp (`clampStripIn`).
A shuttle-table fiber laser has a different pallet time; a shop with better nesting software
a different loss factor.

**"TOTAL HIT COUNT" removed from §5.3 again**, matching the seed's ten tools.
It is a spreadsheet subtotal row that sat between TAP and Relief at 6000/hr.

Also: `packages/calc` described as "100% tested" in §2 where BUILD-PLAN 1.4 requires ≥95%;
CLAUDE.md's bare "Node 22" against `engines: ">=22"` on Node 24. Both aligned.

---

## 2026-09-10 — Course correction: the workbook is an oracle, not a spec

Full audit in `docs/course-correction.md`. Executed against it; these are the
calls that went beyond a straight reading of that document.

**The workbook stops being "the source of truth."**
It is three things: a record of how the shop thinks about cost, seed data the
owner overwrites on day one, and a validation oracle for the six §9 selling
prices. CLAUDE.md principle 1 and REQUIREMENTS §5.7 were amended to match. The
practical consequence is that the extractor now emits materially less than it
reads: index numbers, source rows, laser optics, the metric speeds `speed_in_min`
was derived from, helper columns, and every column holding the loaded quote's
own outputs. *Alternative:* keep everything and let calc ignore what it doesn't
need (rejected — an unused column is a column someone eventually writes a test
against, which is how the engine ends up shaped like a spreadsheet).

**The oracle is six prices, six percentages and five intermediates.**
Blank cost 68.8358, min charge 8.6045, material per part 2.0859, qty-1 material
10.3254, laser hours. Four of those are BUILD-PLAN 1.2's acceptance check and
the fifth is 1.3's, so the list is the build plan's own, not a new one. No test
may assert a workbook number outside it; `scaffold.test.ts` lost its
`parts_per_blank === 33` and material-property assertions on that basis.
*Alternative:* prices only (rejected — the four material intermediates are what
localise a failure to §5.1 instead of "the price is wrong somewhere").

**Laser hours are stored per part, not per 100.**
0.0052255 h/part is the workbook's 0.52255 h/100 divided by 100 — same quantity,
engine units. §11.4 already makes per-100 a display convention. The fixture
carries a `_note` with the conversion so the number stays traceable to the
sheet by eye. *Alternative:* store per-100 in the fixture only (rejected — the
one place a per-100 number survives is the one place it gets copied from).

**Operations carry `kind: machine | manual`, assigned here.**
The workbook has no such column; it encodes the distinction as `std = 100`
scaffolding so its `×K/std` formula resolves. `MACHINE_OPS` in the extractor
names three: LASER, PEGA (50 X 72), EM2510NT (60 X 98) — one laser and two
turret punches, whose hours come from the §5.2/§5.3 cutting worksheets rather
than a parts-per-hour standard. Their `standard_per_hr` is emitted null, which
drops EM2510NT's `F35 = 7` and PEGA's `F34 = 0`; both are noted in
`docs/discovery.md` for the owner. 30-30 is treated as manual on its 250/hr
standard. *Uncertain:* EM2510NT and 30-30 are the two a shop tour would settle
in ten seconds; this needs confirming alongside §10 question 1.

**`k_factor_observed` is gone; the ×60 survives as one number.**
This reverses the 2026-09-09 decision to emit it per operation. 60 is a property
of the pricing rule, not of any operation — 19 of 20 rows were null and could
only ever be null, since a saved quote can only observe the operations it ran.
It becomes `parity.machineTimeFactor = 0.6` (`60/100`, once the per-100
scaffolding is removed), and the extractor still prints the observation
`G33 × F33 / E33 = 60` on every run so the provenance is not lost.

**"TOTAL HIT COUNT" removed from the punch tool list.**
A spreadsheet subtotal row sitting between TAP and Relief with a 6000/hr rate.
REQUIREMENTS §5.3 listed it among the tool rates — the same transcription error
one level up — and was corrected too. Punch tools: 11 → 10.

**Coating constants nested under `legacy`, and `minimum_charge_usd` left unset.**
`s_constant` 5, `coverage` 100, `rate` 0.5 are quirk Q3's parameters, not
physics, so they sit under a key that says so, beside `modern: null` for the
§11.3 model the workbook has no source for. `CoatingModel.minimumChargeUsd`
likewise has no source: W67 holds the loaded quote's own cost (1.0619), not a
floor. Noted in `docs/discovery.md` rather than seeded with a number that looks
authoritative.

**Provenance moved out of config values.**
`min_charge_strip_in` was `{value: 12, source: "derived", from: "W7 / (V7, Q170,
R170)"}` — extraction metadata in a field an owner edits in Settings. It is now
`12`; the derivation lives in the extractor docstring and in this log. The same
reasoning removed `cell`/`source`/`from` from the fixture's intermediates.
`sheet_cost`/`sheet_lbs` stay on materials, because those are the owner's own
mental model when repricing ($/cwt, §11.2), not extraction bookkeeping.

**Kerf demoted from parity flag Q5 to `ProcessPreset.kerfIn`.**
§5.7 already described it as "Setting, default to workbook value", so this makes
the code match what the spec said. Four parity flags remain. Also drops
`clamp_subtracted_widths_in` from the seed: `[35, 36, 47, 48, 59, 60]` is each
width beside its width-minus-clamp twin, and clamp subtraction is one line of
arithmetic.

**Process preset labels lost their embedded clamp value.**
`LASER, 1" CLAMP DIM` restated `clamp_in: 1.0` in the label, which goes stale
the first time an owner edits the number. Now `"Laser"` and `"Punch"`.

**Seed JSON stays snake_case.**
`docs/course-correction.md` §2 names the TS types in camelCase
(`standardBlankLengthsIn`); the seed file that feeds them keeps the extractor's
snake_case (`standard_blank_lengths_in`). The rename was of the concept — the
workbook's "multiples" are standard blank lengths a shop buys — not of the
serialisation convention. Task 2.2's seed loader maps the two.

---

## 2026-09-09 — Task 1.1, monorepo scaffold

**Node `engines: ">=22"`, developed on Node 24.13.**
REQUIREMENTS §2 says Node 22 LTS; 24 is what is installed, and as of this date
24 is current LTS with 22 in maintenance. The range admits both rather than
silently swapping the stack. *Revisit at* Task 5.1, where the Docker base image
tag has to be pinned to one of them.

**Vitest 3 and Vite 7, aligned to a single copy.**
Vitest 2 pins Vite 5, which collided with the Vite 6 that `apps/web` wanted:
two copies of Vite meant two incompatible `Plugin` types under
`exactOptionalPropertyTypes`, and `tsc` rejected `vite.config.ts`. Vitest 3
also renamed workspace configuration to `test.projects` — the API this repo
uses — so v2 would have ignored it silently. Everything now resolves to one
Vite 7. *Watch for* the same failure shape whenever a workspace pins a Vite
major of its own.

**Split `tsconfig.json` (check) from `tsconfig.build.json` (emit).**
Typechecking wants to reach across packages into source so a clean checkout
needs no build first; emitting wants each package confined to its own `rootDir`.
One config cannot do both — mapping `@shopquote/*` to source made `tsc` fail
with TS6059 the moment `rootDir` was set. So `tsconfig.json` is `noEmit`, covers
`src` and `test`, and uses the `paths` map; `tsconfig.build.json` clears `paths`,
sets `rootDir: src`, and consumes dependencies through project references.
*Alternatives:* build calc before every typecheck (slow, and order-dependent);
project references alone (would leave a clean checkout unable to typecheck).

**ESLint enforces calc's purity rather than trusting review.**
"Calc is pure" is CLAUDE.md's second principle and the thing most likely to erode
quietly. `packages/calc/src/**` bans `node:*`/`fs`/`path`/`crypto`/`http`
imports, the `Date` and `process` globals, and all `console`. Its `tsconfig.json`
also sets `types: []` and omits `dom`, so the type system withholds a filesystem
and a browser. Verified by linting a deliberately impure probe file: all three
rules fire. *Alternative:* a note in CLAUDE.md (rejected — CLAUDE.md already says
it, and saying it twice is not enforcement).

**Prettier settings chosen here, not inherited.**
BUILD-PLAN Task 1.1 says "ESLint + Prettier with the settings in CLAUDE.md", but
CLAUDE.md specifies no formatting rules. Picked: 100 columns, single quotes,
semicolons, trailing commas, LF. Generated files (`packages/db/seed/`,
`packages/calc/test/fixtures/`) are in `.prettierignore` so reformatting cannot
create diff noise in files that should only change when the workbook does.

**`concurrently` for `npm run dev`.**
Backgrounding with `&` does not work in cmd.exe, and shops run Windows Server
(§2). Boring, widely used, dev-only.

**drizzle-orm 0.45.2 / drizzle-kit 0.31.10, ahead of Task 2.1 needing them.**
The 0.38 line carries a high-severity SQL-injection advisory
(GHSA-gpj5-g38j-94v9, improperly escaped SQL identifiers). npm calls the upgrade
breaking, but no schema exists yet, so the cost is zero now and non-zero later.
Production dependencies audit clean; seven moderate advisories remain in dev
tooling only (`@vitest/mocker`, and `esbuild` reached through drizzle-kit's
deprecated `@esbuild-kit/*` chain) and are not shipped.

---

## 2026-09-09 — Task 0.2, workbook extraction

**Extract cached values with `xlrd`, not formulas.**
Office's Trust Center File Block on this machine refuses to open legacy `.xls`
through Excel automation, and LibreOffice (BUILD-PLAN's suggested converter) is
not installed. Every number the seed files and the golden fixture need is a
value, so nothing is lost for Task 0.2 itself. *Alternatives:* relax the Trust
Center policy (declined — it is a machine-wide security setting and not ours to
change); install LibreOffice (heavier, and still unnecessary for values).
*Revisit if* Task 1.4 hits a roll-up mismatch that the values cannot explain.

**Recover formula-only constants arithmetically and tag them `"source": "derived"`.**
Two figures live inside formulas rather than cells: the 12-inch minimum strip
(REQUIREMENTS §5.1) and the blank cost (§9's 68.83). Both are solved from
values that are present — the strip from `W7 / (V7, Q170, R170)`, which lands on
exactly 12.000000 — and carry a `source` tag so a reader never mistakes them
for a direct cell read. *Alternative:* hard-code 12 from §5.1 (rejected: that is
typing the spec into the fixture, which is what Task 0.2 forbids).

**Use the observed row ranges, not the ones in BUILD-PLAN Task 0.2.**
Four of the six quoted ranges counted the header row as data or stopped short:
materials are 124–210 (not 123–210), plating 74–116 (not 72–115), silkscreen
215–221 (not 213–220), presets 282–283 (not 281–282). Operations 32–51 was
correct. The ranges are named constants at the top of the script.

**Derive `thickness_in` and `family` from the material name.**
The workbook has no column for either, but REQUIREMENTS §3 wants both. Thickness
comes from five ordered regex patterns (`(.0598)`, `3/4"`, `.020" THK`, …) and
family from name markers, with galvanised markers tested before `CRS` so
`CRS GAL HOT DIP` classifies as galv rather than steel. Anything unmatched stays
null and is listed in `docs/discovery.md`. Three rows are unmatched, all
legitimately: `NO MATERIAL SELECTED`, `Laminate`, and the G90 hot-dip row whose
gauge is written `18GA` without a decimal. *Alternative:* derive thickness from
lb/ft² ÷ density (rejected: only approximate — it puts CRS 16 GA at .0614
against a true .0598).

**Accept `U`/`V` as price provenance only when `U/V` reproduces `R`.**
Cost-per-sheet and lbs-per-sheet are how the owner actually arrives at $/lb, so
they are worth seeding (FR-1's day-one workflow is a price update). But those two
columns are reused for unrelated scratch values further up the table — row 145
holds thickness and steel density there. The arithmetic check accepts them only
where they are genuinely a price pair; elsewhere both are null.

**Seed only catalog columns from the operations table.**
The workbook is a live quote with the golden part loaded, so `E` (oper hrs),
`G` (hrs/100), `I`/`J` (extensions) and `K`/`L` (extras) are *that quote's*
numbers, not shop standards. Only `D` (setup hrs), `F` (standard) and `H` (rate)
are seeded. The same applies to `Assy-Handling`, where column `C` is a frequency
count from the last assembly estimated and only `B` (standard seconds) is seeded.

**Observe the ×60 machine-op factor rather than assume it.**
Quirk Q2 (§5.4) is emitted as `k_factor_observed`, computed as `G × F / E` only
where the saved quote left those non-zero. Just the laser row qualifies, and it
gives exactly 60.0 — so Q2 is now confirmed from the workbook rather than
inferred from the spec. The other 19 operations are null pending §10 question 1.
*Alternative:* hard-code 60 for laser/punch and 100 elsewhere (rejected: that is
the guess §10 q1 exists to eliminate).

**Disambiguate duplicate operation names by their standard.**
`BRAKE, BEND` appears twice, at 222/hr and 330/hr. Both are kept; the second
gets key `brake-bend-330` so downstream tables can address them separately.

**Python dependency: `xlrd` 2.0.2.**
Needed because `openpyxl` cannot read legacy `.xls`. Confined to
`scripts/extract-workbook.py`; nothing in the Node workspaces depends on it.
