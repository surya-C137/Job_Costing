# Decisions

Choices made where the spec was silent. Newest first. Format: date · decision · why · alternatives.

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
