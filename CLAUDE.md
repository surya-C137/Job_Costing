# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# ShopQuote

Internal quoting system for a sheet metal job shop. Replaces a 1998-era Excel estimator. Read `REQUIREMENTS.md` before working; `BUILD-PLAN.md` is the ordered task list.

## Current state — read this first
No code exists yet. On disk: `CLAUDE.md`, `docs/REQUIREMENTS.md` (the spec; § numbers are cited from everywhere), `docs/BUILD-PLAN.md` (ordered tasks, each ≤ one session, with prompts and acceptance checks), and `docs/reference/Quote_Metal_Cost.xls`. Git initialized on `main`, nothing committed yet. There is no `package.json` and no workspaces — the commands and layout below describe the target, not what's on disk. `docs/decisions.md`, `docs/discovery.md`, `docs/parity-report.md`, and `docs/pilot-log.md` are created as the work reaches them.

**Reference material still missing.** BUILD-PLAN lists these as prerequisites for Task 1.1:
- `docs/reference/sheet-metal-material-calculator.html` — the prototype. Source of the design tokens (see Design, below), the nesting math (`nest`, `costAt`, `computePart`), and the CSV/PDF resolvers (`resolveMaterial`, `resolveThickness`, `parseCSV`, `mapHeaders`, `parseDrawingText`). Tasks 1.2, 3.3, 4.1 and 4.3 all cite it.
- `docs/reference/sample-parts.csv`, `docs/reference/sample-drawing-*.pdf` — needed for the Task 3.3 and 4.4 acceptance checks, not before.

Ask for these rather than reinventing them; the design system and the intake heuristics are meant to be ported, not redesigned.

**The workbook is the source of truth.** Task 0.2 extracts the seed JSON *and* the golden fixture from its cached values — explicitly not typed by hand. Don't substitute the excerpt in REQUIREMENTS §6 (a partial table, ~12 of ~80 materials) or hand-enter the §9 numbers as a fixture; a fixture typed from the spec proves only that you can copy, not that the engine matches the workbook.

**Where to start.** Task 0.2 (extract workbook → seed JSON), then 1.1 (scaffold). Tasks are ordered and each assumes the previous is green. The golden test must pass before any UI work (§9).

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

`rollup.ts` implements REQUIREMENTS §5.6 and the **order is load-bearing** — material block and labor block take their markups, then painting/silkscreen are added *after*, unmarked (quirk Q4). Rearranging the arithmetic changes the answer.

## Golden numbers (§9)
The `G30 16 GA` part, 13.38 × 7.858 in, laser, 48 in stock, 96 in blank. Keep these where you can see them:

| Qty | 1 | 5 | 10 | 30 | 50 | 100 |
|---|---|---|---|---|---|---|
| Selling price | 37.8286 | 8.7413 | 6.3413 | 4.7413 | 4.4213 | 4.1813 |

Intermediates: 33 parts per blank · blank cost 68.83 · min charge 8.6045 · material per part 2.0859 · qty-1 material 10.3254 = max(2.0859, 8.6045 × 1.2) · laser 0.52255 h/100. Tolerance ±0.005 on price, ±0.001 on material % of SP.

## Stack (do not swap without a note in docs/decisions.md)
Node 22 · TypeScript strict · npm workspaces · Fastify · SQLite (better-sqlite3) + Drizzle · Vite + React · plain CSS with tokens from `docs/reference/sheet-metal-material-calculator.html` · Puppeteer for PDF · Vitest · Playwright · Zod at every boundary.

## Commands
Created by Task 1.1 (root) and 2.1 (db) — they do not exist yet.

```
npm install
npm run dev            # api + web
npm run typecheck
npm run lint
npm test
npm run build

npm run db:migrate     # → data/shopquote.db
npm run db:seed        # loads packages/db/seed/*.json, admin user from env
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
- IDs are ULIDs; quote numbers `Q-YYYY-NNNN`.
- Soft delete (`archivedAt`); `createdAt/updatedAt` on every table.
- Errors: problem+json from the API; typed `Result` in calc (no throws for expected conditions like "part doesn't fit").
- Tests next to code in `test/`; fixtures in `test/fixtures/`; every formula from REQUIREMENTS §5 has at least one test that cites the section. Tests first for anything with a number in it.
- Commits: conventional (`feat:`, `fix:`, `chore:`, `docs:`), one task per commit, spec section in the body.
- No new dependencies in `packages/calc`. Elsewhere, prefer boring, well-maintained packages; note additions in `docs/decisions.md`.

## Design
Carry the prototype's look: off-white paper, ink text, one accent (`--dykem: #1F45A3`), IBM Plex Sans (bundled, no CDN), tabular numerals, dense tables, sentence-case labels, minimal borders. Results panel dark. Warnings amber, never blocking — min charge applied, yield < 50%, part doesn't fit, material inactive are all warnings, not errors. Keyboard-first: the estimator lives on Tab and Enter, and Tab order follows the workbook's left-to-right flow.

## Parity quirks (keep behind flags; see REQUIREMENTS §5.7)
Q1 markup inside min-charge MAX · Q2 ×60 machine-op factor · Q3 legacy coating model · Q4 painting/silkscreen unmarked · Q5 laser kerf 0.5. Default on, and the golden test runs with all of them on. Turning any off requires a row in `docs/parity-report.md`. Q1–Q3 are open questions for the owner (§10) — reproduce them, don't correct them.

## When the spec is silent
Choose the simplest reversible option, record it in `docs/decisions.md` (date · decision · why · alternatives), keep going. Ask the user only for irreversible choices: schema that affects entered data, or pricing behavior the owner hasn't approved.

## Definition of done for any task
`npm run typecheck && npm run lint && npm test` green · golden test green · acceptance check from BUILD-PLAN performed · docs updated if behavior changed.
