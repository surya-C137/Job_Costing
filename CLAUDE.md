# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# ShopQuote

Internal quoting system for a sheet metal job shop. Replaces a 1998-era Excel estimator. Read `REQUIREMENTS.md` before working; `BUILD-PLAN.md` is the ordered task list.

## Current state — read this first
**Done through BUILD-PLAN Task 1.1.** The monorepo is scaffolded and `npm install && npm run typecheck && npm test && npm run lint && npm run build` are all green, but every workspace is a stub: calc exports only a schema version, the API serves only `/healthz`, and the web app is a placeholder. The engine starts at Task 1.2.

```
CLAUDE.md · docs/REQUIREMENTS.md · docs/BUILD-PLAN.md   the spec set
docs/reference/Quote_Metal_Cost.xls                     the workbook
docs/decisions.md · docs/discovery.md                   choices made · unresolved cells
scripts/extract-workbook.py                             Task 0.2
packages/db/seed/*.json                                 10 seed files, 80 materials
packages/calc/test/fixtures/golden-workbook.json        the §9 fixture
```

`scripts/extract-workbook.py` is re-runnable and idempotent: it rewrites the seed JSON and refreshes only its own delimited block in `docs/discovery.md`, so hand-written Phase 0.1 notes survive. It prints the six §9 selling prices and exits non-zero if any drifts past ±0.005 — a cheap regression check if the workbook is ever replaced with a newer save. `docs/parity-report.md` (Task 1.5) and `docs/pilot-log.md` (Task 5.2) don't exist yet.

**Two quirks are now confirmed from the workbook, not inferred.** Q2's machine-op factor is exactly 60.0, recovered as `G33 × F33 / E33`; the 12-inch minimum strip solves to exactly 12 from `W7 / (V7, Q170, R170)`. Both are recorded in `docs/decisions.md`. Six cells remain genuinely unresolved and need the owner — see `docs/discovery.md`.

**Reference material still missing.** BUILD-PLAN lists these as prerequisites for Task 1.1:
- `docs/reference/sheet-metal-material-calculator.html` — the prototype. Source of the design tokens (see Design, below), the nesting math (`nest`, `costAt`, `computePart`), and the CSV/PDF resolvers (`resolveMaterial`, `resolveThickness`, `parseCSV`, `mapHeaders`, `parseDrawingText`). Tasks 1.2, 3.3, 4.1 and 4.3 all cite it.
- `docs/reference/sample-parts.csv`, `docs/reference/sample-drawing-*.pdf` — needed for the Task 3.3 and 4.4 acceptance checks, not before.

Ask for these rather than reinventing them; the design system and the intake heuristics are meant to be ported, not redesigned.

**The workbook is the source of truth.** Task 0.2 extracts the seed JSON *and* the golden fixture from its cached values — explicitly not typed by hand. Don't substitute the excerpt in REQUIREMENTS §6 (a partial table, ~12 of ~80 materials) or hand-enter the §9 numbers as a fixture; a fixture typed from the spec proves only that you can copy, not that the engine matches the workbook.

**Where to start.** Task 1.2 (calc types and the material module). Tasks are ordered and each assumes the previous is green. The golden test must pass before any UI work (§9).

**Two scaffold details worth knowing before you edit.** Each package has *two* tsconfigs: `tsconfig.json` is `noEmit`, covers `src` and `test`, and maps `@shopquote/*` to source so a clean checkout typechecks without building; `tsconfig.build.json` clears that map, pins `rootDir: src`, and emits through project references. Add new source to both by leaving the `include` globs alone. And calc's purity is enforced, not just documented — ESLint bans `node:*`/`fs`/`path`/`crypto` imports, the `Date` and `process` globals, and `console` under `packages/calc/src/**`, while its tsconfig sets `types: []` and omits `dom`. If you need a clock or a file in calc, the answer is to pass the value in through `ShopConfig`, not to relax the rule.

## What matters most
1. **Parity first.** The costing engine must reproduce the shop's workbook (`docs/reference/Quote_Metal_Cost.xls`) to the cent. The golden test in `packages/calc/test/golden.test.ts` is the definition of correct. Never edit the fixture to make a test pass — trace the formula in the xls, fix the engine, explain the discrepancy in the commit message.
2. **Calc is pure.** `packages/calc` has zero runtime dependencies, no I/O, no DB, no Date.now(). Config in, result out. Everything about a shop that can differ lives in `ShopConfig`, not in code.
3. **Owner-editable.** Any number an owner might change is a settings field, not a constant.
4. **Snapshots.** Quotes store the config they were priced with. Re-pricing is explicit.

## Architecture
Monorepo, npm workspaces. Dependencies point one way — `apps/web` → `apps/api` → `packages/db` → `packages/calc`, and calc depends on nothing:

```
packages/calc/   pure TS costing engine, zero deps, ≥95% coverage
packages/db/     Drizzle schema, migrations, seed JSON, config assembly
apps/api/        Fastify server (calc runs here; results are authoritative)
apps/web/        Vite + React
deploy/          docker-compose, Windows service, backup
```

The one flow worth holding in your head:

```
DB tables ──loadShopConfig(db, shopId, asOf?)──► ShopConfig ─┐
                                                             ├─► computeQuote() ─► QuoteResult
PartInput[] + quantity breaks ───────────────────────────────┘         │
                                                                       ▼
                                        saveSnapshot(quoteId, config, input, result) → quote_versions
```

Every quote save re-runs calc server-side and stores a frozen copy of the whole `ShopConfig` alongside the result. The web app never computes a price — it debounces (300 ms) and asks the API. "Re-price with current rates" is a deliberate user action that loads today's config and writes a new version. Material prices are versioned by effective date, so `asOf` reconstructs any past quote.

Calc is split by module because that's what makes the second shop a config change: `material.ts`, `laser.ts`, `punch.ts`, `operations.ts`, `finish.ts`, `hardware.ts`, `nre.ts`, `rollup.ts`, `intake/`. Another sheet metal shop reuses all of it; a different trade swaps cutting and finish only.

`intake/` is where the zero-dependency rule bites hardest, because parsing formats is exactly what libraries are for. The split is: **parsers live outside calc, geometry and resolution live inside it.** `dxf-parser` (§11.4) belongs to the caller in `apps/web` or `apps/api`; `intake/dxf.ts` receives already-parsed entities and does pure geometry — loops, shoelace area, cut length, pierce count. Same shape for CSV and PDF (§8, Task 3.3): the file is read outside, the resolvers inside. calc's `package.json` has no `dependencies` block, so a stray import fails to resolve rather than quietly shipping.

`rollup.ts` implements REQUIREMENTS §5.6 and the **order is load-bearing** — material block and labor block take their markups, then painting/silkscreen are added *after*, unmarked (quirk Q4). Rearranging the arithmetic changes the answer.

## Golden numbers (§9)
The `G30 16 GA` part, 13.38 × 7.858 in, laser, 48 in stock, 96 in blank. Keep these where you can see them:

| Qty | 1 | 5 | 10 | 30 | 50 | 100 |
|---|---|---|---|---|---|---|
| Selling price | 37.8286 | 8.7413 | 6.3413 | 4.7413 | 4.4213 | 4.1813 |

Intermediates: 33 parts per blank · blank cost 68.83 · min charge 8.6045 · material per part 2.0859 · qty-1 material 10.3254 = max(2.0859, 8.6045 × 1.2) · laser 0.52255 h/100. Tolerance ±0.005 on price, ±0.001 on material % of SP.

## Stack (do not swap without a note in docs/decisions.md)
Node 22+ (`engines: ">=22"`; developing on 24 — Task 5.1 has to pin one in the Docker tag) · TypeScript strict · npm workspaces · Fastify · SQLite (better-sqlite3) + Drizzle · Vite + React · plain CSS with tokens from `docs/reference/sheet-metal-material-calculator.html` · Puppeteer for PDF · Vitest · Playwright · Zod at every boundary.

## Commands

```
npm install
npm run dev            # api on :3000, web on :5173
npm run typecheck
npm run lint
npm test
npm run build
npm run extract-workbook   # regenerate seed JSON + golden fixture from the xls

npm run db:migrate     # → data/shopquote.db          ] not wired until
npm run db:seed        # loads packages/db/seed/*.json ] Task 2.1
```

Per workspace and per test (Vitest):

```
npm test -w packages/calc
npm test -w packages/calc -- test/golden.test.ts     # one file
npm test -w packages/calc -- -t "min charge"          # one test by name
```

## Conventions
- Units: inches, pounds, in², lb/ft², $/lb, $/hr, hours. Convert at the edge (mm → in in the UI/intake layer), never inside calc. Name fields with units: `flatLengthIn`, `lbPerSqFt`, `pricePerLb`, `setupHrs`.
- Money as numbers in dollars (not cents) with 4-decimal internal precision; round only for display.
- "Hours per 100" is a display convention the workbook uses; the engine stores per-part and converts at the edge (§11.4).
- IDs are ULIDs; quote numbers `Q-YYYY-NNNN`.
- Soft delete (`archivedAt`); `createdAt/updatedAt` on every table.
- Errors: problem+json from the API; typed `Result` in calc (no throws for expected conditions like "part doesn't fit").
- Tests next to code in `test/`; fixtures in `test/fixtures/`; every formula from REQUIREMENTS §5 has at least one test that cites the section. Tests first for anything with a number in it.
- Commits: conventional (`feat:`, `fix:`, `chore:`, `docs:`), one task per commit, spec section in the body.
- No new dependencies in `packages/calc`. Elsewhere, prefer boring, well-maintained packages; note additions in `docs/decisions.md`.

## Design
Carry the prototype's look: off-white paper, ink text, one accent (`--dykem: #1F45A3`), IBM Plex Sans (bundled, no CDN), tabular numerals, dense tables, sentence-case labels, minimal borders. Results panel dark. Warnings amber, never blocking — min charge applied, yield < 50%, part doesn't fit, material inactive, and a non-RoHS finish on a RoHS customer (§11.2) are all warnings, not errors. Keyboard-first: the estimator lives on Tab and Enter, and Tab order follows the workbook's left-to-right flow.

## Parity quirks (keep behind flags; see REQUIREMENTS §5.7)
Q1 markup inside min-charge MAX · Q2 ×60 machine-op factor · Q3 legacy coating model · Q4 painting/silkscreen unmarked · Q5 laser kerf 0.5. Default on, and the golden test runs with all of them on. Turning any off requires a row in `docs/parity-report.md`. Q1–Q3 are open questions for the owner (§10) — reproduce them, don't correct them.

**A flag has two sides.** §11.3 is explicit that switching one off must produce a defensible number, not zero and not a hole. So each flag needs a real alternative implemented next to the legacy path — most substantially Q3, where the modern model is `coated area (both sides) ÷ coverage × powder $/lb + rack/hang labour + masking`, against the workbook's perimeter-as-area. Q2's off-path is the plain `×100`. Writing only the legacy branch and leaving `else → 0` is the failure mode to avoid; `docs/parity-report.md` (Task 1.5) exists to show the owner both numbers side by side.

## Modernization (REQUIREMENTS §11)
The workbook is 1998-era and some of it is genuinely out of date. §11's rule for that: **parity first, then modernize as data (Settings) or as flags — never as a silent code change.** The seed in `packages/db/seed/` is deliberately faithful to the workbook, CO₂-era laser speeds and 2023 prices included. Don't "correct" a seeded number in code or in the extractor; those get refreshed by the owner through Settings on day one, which is exactly the workflow FR-1 has to make easy.

**Fields §11 needs that §3's domain model doesn't mention.** These are cheap in Task 2.1 (schema) and a migration afterwards, so land them then even though nothing consumes them until Phase 4:

| Table | Field | Why |
|---|---|---|
| plating specs | `rohsCompliant` | Hex-chrome and cadmium are restricted for most commercial work; the estimator gets a warning, not a block |
| plating specs | `aliases[]` | Specs were renamed (QQ-P-35 → ASTM A967/AMS 2700, MIL-C-5541 → MIL-DTL-5541, …). Old drawings still carry the old names, so both must resolve |
| customers | `rohsRequired` | What the warning above triggers against |
| materials | `surchargePct` | Tariff-volatile pricing, optional per material |
| operations / laser | `assistGasPerHr` | Folds into the laser rate |
| quote | freight, packaging, rush multiplier, minimum order charge | Quote-level lines (§11.4), not part costs |

`$/cwt` is an *input convention*, not a stored unit — the UI accepts it and divides by 100; the column stays `pricePerLb`. Price alerts (§11.4) need no new field: versioned prices plus the config snapshot already answer "has this material moved since this quote was priced".

**Quantity breaks.** The workbook's six are the config default and the seed carries them. §11.2 wants the *values* editable (250 and 500 are common now); §11.5 keeps the *six-column layout* the shop's customers recognise. Both hold at once — six slots, editable contents. Don't hardcode `[1,5,10,30,50,100]` anywhere, and don't make the printed table grow either.

## When the spec is silent
Choose the simplest reversible option, record it in `docs/decisions.md` (date · decision · why · alternatives), keep going. Ask the user only for irreversible choices: schema that affects entered data, or pricing behavior the owner hasn't approved.

## Definition of done for any task
`npm run typecheck && npm run lint && npm test` green · golden test green · acceptance check from BUILD-PLAN performed · docs updated if behavior changed.
