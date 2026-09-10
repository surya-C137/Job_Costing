# CLAUDE.md — ShopQuote

Internal quoting system for a sheet metal job shop. Replaces a 1998-era Excel estimator. Read `docs/REQUIREMENTS.md` before working; `docs/BUILD-PLAN.md` is the ordered task list.

## What matters most
1. **Parity on the golden outputs, not on the workbook's mechanics.** `docs/reference/Quote_Metal_Cost.xls` is three things only: (a) a record of how this shop thinks about cost — take the concepts, model them cleanly in our own types; (b) seed data for Settings — the owner overwrites it on day one; (c) a validation oracle for one small table — the six selling prices, six material percentages and five intermediates in REQUIREMENTS §9. Nothing else in the workbook needs to reproduce. Do not carry over its layout, helper columns, index lookups, per-100 conventions, or quirks beyond the four flagged in §5.7. Never edit the fixture to make a test pass.
2. **Calc is pure.** `packages/calc` has zero runtime dependencies, no I/O, no DB, no Date.now(). Config in, result out. Everything about a shop that can differ lives in `ShopConfig`, not in code.
3. **Nothing about a shop is a constant.** Machines, materials, gauges, stock sizes, finishes, standards, units, currency, breaks, markups, terms are all Settings data (REQUIREMENTS §12). Code knows shapes (a machine has a rate), never instances (a laser). Cost modules implement `CostContributor` and are enabled per shop; the roll-up never imports a trade-specific module. Missing data warns visibly; it never silently defaults.
4. **Snapshots.** Quotes store the config they were priced with. Re-pricing is explicit.

## Stack (do not swap without a note in docs/decisions.md)
Node 22+ (`engines: ">=22"`; developing on 24 — Task 5.1 pins one in the Docker tag) · TypeScript strict · npm workspaces · Fastify · SQLite (better-sqlite3) + Drizzle · Vite + React · plain CSS with tokens from `docs/reference/sheet-metal-material-calculator.html` · Puppeteer for PDF · Vitest · Playwright · Zod at every boundary.

## Conventions
- Units: inches, pounds, in², lb/ft², $/lb, $/hr, hours. Convert at the edge (mm → in in the UI/intake layer), never inside calc. Name fields with units: `flatLengthIn`, `lbPerSqFt`, `pricePerLb`, `setupHrs`.
- Money as numbers in dollars (not cents) with 4-decimal internal precision; round only for display.
- IDs are ULIDs; quote numbers `Q-YYYY-NNNN`.
- Soft delete (`archivedAt`); `createdAt/updatedAt` on every table.
- Errors: problem+json from the API; typed `Result` in calc (no throws for expected conditions like "part doesn't fit").
- Tests next to code in `test/`; fixtures in `test/fixtures/`; every formula from REQUIREMENTS §5 has at least one test that cites the section.
- Commits: conventional (`feat:`, `fix:`, `chore:`, `docs:`), one task per commit, spec section in the body.
- No new dependencies in `packages/calc`. Elsewhere, prefer boring, well-maintained packages; note additions in `docs/decisions.md`.

## Design
Carry the prototype's look: off-white paper, ink text, one accent (`--dykem: #1F45A3`), IBM Plex Sans (bundled), tabular numerals, dense tables, sentence-case labels, minimal borders. Results panel dark. Warnings amber, never blocking. Keyboard-first: the estimator lives on Tab and Enter.

## Parity quirks (keep behind flags; see REQUIREMENTS §5.7)
Four flags: Q1 `markupInsideMinChargeMax` · Q2 `machineTimeFactor` (a dialable number — 0.6 is the workbook's ×60, 1.0 bills machine time as machine time) · Q3 `legacyCoatingModel` · Q4 `finishesUnmarked`. Each defaults to the workbook. Turning one off requires a row in `docs/parity-report.md` and a real alternative path, never `else → 0`.

**Q5 was withdrawn.** Kerf is a machine-row field (`kerfIn`), not a flag — per §12 it is exactly the kind of number that differs between two shops in the same trade, so it is Settings data. Same reasoning makes Q2 a number rather than a boolean.

## The test for every feature
Would a modern shop that never had this spreadsheet want it? If no, leave it out. The app is measured by the estimator's workflow — RFQ in → parts entered fast → live cost stack → quote PDF → logged — not by faithfulness to the spreadsheet.

## When the spec is silent
Choose the simplest reversible option, record it in `docs/decisions.md` (date · decision · why · alternatives), keep going. Ask the user only for irreversible choices: schema that affects entered data, or pricing behavior the owner hasn't approved.

## Definition of done for any task
`npm run typecheck && npm run lint && npm test` green · golden test green · acceptance check from BUILD-PLAN performed · docs updated if behavior changed.
