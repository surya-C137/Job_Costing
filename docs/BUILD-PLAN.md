# ShopQuote — Build Plan for Claude
### Step-by-step task list. Each task is one Claude Code session or less.

**How to use this.** Work through tasks in order. Before each task, paste the block marked *Prompt to Claude* into Claude Code (or claude.ai with the repo attached). Every prompt begins by telling Claude to read `CLAUDE.md` and the named sections of `docs/REQUIREMENTS.md`. Don't skip the acceptance checks — they are what keeps quality up when the tasks compound. If a task produces something surprising, stop and fix it before the next one; each task assumes the previous one is green.

**Ground rule for every task.** The workbook is concepts + seed data + the §9 oracle (six selling prices, six material percentages, five intermediates — seventeen numbers, listed in one table there). It is not a spec. If a task prompt could be read as "replicate the spreadsheet," it means "capture the concept and validate against the golden case." Ask of every feature: would a modern shop that never had this spreadsheet want it?

**Files to put in the repo before Task 1.1:** `CLAUDE.md`, `docs/REQUIREMENTS.md`, `docs/BUILD-PLAN.md`, `docs/reference/Quote_Metal_Cost.xls`, `docs/reference/sheet-metal-material-calculator.html`, `docs/reference/sample-parts.csv`, `docs/reference/sample-drawing-*.pdf`.

Legend: ⏱ rough effort for Claude · ✅ acceptance check you run · 🧑 something only you/the shop can do

---

## Phase 0 — Discovery (you + the shop, ~half a day)

### 0.1 🧑 Get the answers in REQUIREMENTS §10
Sit with the estimator for an hour with the workbook open. Record answers in `docs/discovery.md`. Get the ten recent quotes (Excel copies) for Task 2.4.

### 0.2 Extract the workbook into machine-readable seed files ⏱ 30 min
*Prompt to Claude:*
> Read CLAUDE.md and docs/REQUIREMENTS.md §5–§6 and §9. Write `scripts/extract-workbook.py` that reads `docs/reference/Quote_Metal_Cost.xls` (use xlrd; convert to xlsx with LibreOffice if you need formulas via openpyxl) and writes JSON seed files to `packages/db/seed/`: `materials.json` (rows 123–210 of PART COST WORKSHEET: name, thickness, lb_ft2, price_per_lb, std_length, speed_in_min, pierce_s, punch_factor), `operations.json` (rows 31–51), `plating.json` (rows 72–115), `coating.json`, `silkscreen.json` (rows 213–220), `assembly_standards.json` (sheet "Assy-Handling Cost Estimator"), `punch_rates.json` (rows 31–41 cols N–V), `blank_multiples.json`, `process_presets.json` (rows 281–282 — clamp and kerf per process; Task 2.1's `seed.ts` turns these two into the "Laser 1" / "Punch 1" machine rows of §3, so do not add a `process_presets` table), and `shop_defaults.json` (markups, breaks, NRE rate, min strip, shop flat charge — note the workbook's D13 is the setup roll-up, not a shop constant; see §5.6). Also write `packages/calc/test/fixtures/golden-workbook.json` containing only the inputs and the §9 oracle — six selling prices, six material percentages, five intermediates — read from the workbook's cached values. Do not extract other intermediate cells. Print a summary table of what was extracted. Skip rows with empty names. Do not guess a value — if a cell is ambiguous, write `null` and list it in `docs/discovery.md` under "Unresolved cells".

✅ Open the JSON files; spot-check five materials against the xls. `golden-workbook.json` contains 37.8286 / 8.7413 / 6.3413 / 4.7413 / 4.4213 / 4.1813.

---

## Phase 1 — Repo and the costing engine (the foundation; do not rush)

### 1.1 Scaffold the monorepo ⏱ 20 min
*Prompt to Claude:*
> Read CLAUDE.md and REQUIREMENTS §2. Create the monorepo layout exactly as specified with npm workspaces: `packages/calc`, `packages/db`, `apps/api`, `apps/web`, `deploy/`. TypeScript strict everywhere, shared `tsconfig.base.json`, ESLint + Prettier with the settings in CLAUDE.md, Vitest configured at the root, a `README.md` with the one-command dev setup. `packages/calc` must have zero runtime dependencies. Add `npm run dev`, `npm run test`, `npm run lint`, `npm run typecheck`, `npm run build`. Commit as "chore: scaffold".

✅ `npm install && npm run typecheck && npm test` all pass on an empty project.

### 1.2 Calc engine — types, contributor interface, material module ⏱ 1.5 h
*Prompt to Claude:*
> Read CLAUDE.md, REQUIREMENTS §3, §5.1, §5.7, §9 and §12, and the material math in `docs/reference/sheet-metal-material-calculator.html` (functions `nest`, `costAt`, `computePart`). In `packages/calc` define the types `ShopConfig` (families, gauges, materials, stockSizes, machines, machineMaterialRates, operations, finishes, assemblyStandards, defaults, parityFlags, enabledModules), `MaterialRow` with a `form` field, `Machine`, `PartInput`, `QuoteInput`, `CostStack`, `QuoteResult` (document every field with a JSDoc line and its unit), and the `CostContributor` interface from §12. Nothing in these types may name a specific machine, alloy or gauge — those are instances in config. Write a `registry.ts` that maps module IDs to contributors. Implement `material.ts`: nesting per §5.1 (clamp on one width edge, kerf added to each part, both orientations, max), blank cost, minimum charge, and `materialAtQty()` honoring parity flag Q1. Blank length is a plain input; a helper `yieldForLengths(lengths[])` is fine, but no lookup grid. Write unit tests: the prototype's cases (13.38×7.858, 16 ga, 48×120 laser → 42/sheet with 0.375 spacing; 33 per 96-in blank with 0.5 kerf), the golden material numbers from §9 (blank cost 68.83, min 8.6045, 2.0859 per part, 10.3254 at qty 1), a part that doesn't fit, and mm inputs. No I/O, no DB, no console output.

✅ `npm test -w packages/calc` green; `material.test.ts` asserts the four *material* intermediates to 4 decimals (the fifth, laser hours, belongs to Task 1.3).

### 1.3 Calc engine — cutting (laser + punch) ⏱ 1 h
*Prompt to Claude:*
> Read REQUIREMENTS §5.2, §5.3, §6, §12 and the LASER WORKSHEET formulas in `docs/discovery.md` / the xls. Speeds, pierce times, kerf, clamp, pallet time, loss factor and gas cost come from the selected `Machine` and its `machineMaterialRates` entry — never from the material row and never from a constant. Missing rate → a typed warning in the result, not a throw. Implement `laser.ts` (feature list → cut inches, pierces, hours **per part** with the 1.08 loss factor, pallet-change rule) and `punch.ts` (hit counter → hours per part). Inputs are explicit numbers, never looked up from the DB inside calc. Tests: the golden laser case (perimeter 58 in, 1 pierce, 1 intersection, 220 in/min, 0.1 s pierce, 33 per blank → 0.0052255 h per part), zero-feature part, a 200-hole part, a punch part with 40 bridges + 4 embosses.

✅ Golden laser hours match to 5 decimals.

### 1.4 Calc engine — operations, finish, roll-up ⏱ 1.5 h
*Prompt to Claude:*
> Read REQUIREMENTS §5.4–§5.7 and §9. Implement `operations.ts` (per-part fixed $ and direct $, rate inherited from the linked machine when present, quirk Q2 as the dialable `parity.machineTimeFactor`, 0.6 in the workbook), `finish.ts` (plating MAX rule; coating model with `parity.legacyCoatingModel`; silkscreen), `hardware.ts`, `nre.ts` — each as a `CostContributor` — and `rollup.ts` implementing §5.6 over the list of enabled contributors (it must not import any sheet-metal module directly), returning a `CostStack` per quantity break with the intermediates the UI shows — material, labor, fixed, finish, hardware, NRE, selling, `materialPctOfSelling` — and nothing that exists only because the workbook had a column for it. Then write `test/golden.test.ts` that loads `fixtures/golden-workbook.json`, builds a `ShopConfig` from the seed JSON, runs `computeQuote()`, and asserts all six selling prices within ±0.005 and the six material % values within ±0.001. If any number is off, do NOT tweak the fixture — trace the formula in the xls and fix the engine; explain the discrepancy in the commit message.

✅ Golden test green with all parity flags on. Coverage on `packages/calc` ≥ 95%.

### 1.5 Calc engine — parity flags off, and a second fixture ⏱ 45 min
*Prompt to Claude:*
> Add tests that run the golden case with each parity flag turned off individually, and record the resulting selling prices in `docs/parity-report.md` as a table (flag, qty, workbook price, corrected price, delta). This is what we'll show the owner when we ask about §10 questions 1–2. Then add a second fixture from `docs/discovery/quote-2.xlsx` (a real recent quote — if it's not there yet, leave a TODO test marked `.todo`).

✅ `docs/parity-report.md` exists and the deltas are explainable in one sentence each.

---

## Phase 2 — Database and seed

### 2.1 Schema and migrations ⏱ 1 h
*Prompt to Claude:*
> Read CLAUDE.md, REQUIREMENTS §3 and §7. In `packages/db` define the Drizzle schema for SQLite: shops, users, sessions, material_families, gauge_reference, materials, material_prices (versioned), stock_sizes, machines, machine_material_rates, punch_hit_rates, operations, plating_specs, coating_models, silkscreen_tiers, assembly_standards, intake_aliases, customers, parts, quotes, quote_lines, quote_versions (JSON snapshot of ShopConfig + inputs + results), attachments, audit_log. Every table carries `shop_id`. ULID primary keys, `created_at/updated_at/archived_at` everywhere, foreign keys on. Generate the initial migration. Write `seed.ts` that loads `seed/*.json` from Task 0.2 into a fresh DB — creating one seed machine per workbook process ("Laser 1", "Punch 1") and moving the workbook's speed/pierce/punch-factor columns into `machine_material_rates` — and creates an `admin` user from env. Also write `seed-blank.ts` that creates an empty shop with only the gauge reference tables and unit defaults, for a shop that has no workbook. Add `npm run db:migrate` and `npm run db:seed`.

✅ `npm run db:migrate && npm run db:seed` produces `data/shopquote.db`; `sqlite3` shows ≥ 80 materials and the operations table.

### 2.2 Config assembly ⏱ 30 min
*Prompt to Claude:*
> Write `packages/db/src/config.ts` with `loadShopConfig(db, shopId, asOf?: Date): ShopConfig` that assembles the calc engine's config from the tables (using the price version effective at `asOf`). Write `saveSnapshot(quoteId, config, input, result)`. Add a test that loads the seeded config and runs the golden test through it — this proves seed + assembly + calc agree.

✅ Golden test passes through the DB path too.

---

## Phase 3 — API

### 3.1 Server, auth, config endpoints ⏱ 1.5 h
*Prompt to Claude:*
> Read CLAUDE.md, REQUIREMENTS §2, §4 FR-1 and FR-6, §7 security. In `apps/api` set up Fastify with: session auth (cookie, 12 h, argon2 passwords, login rate-limit), role guard, `GET/PUT /api/config` (full config; owner/admin), `GET/POST/PUT /api/materials`, `POST /api/materials/:id/price` (new version), same for operations / plating / coating / silkscreen / assembly, `GET/POST /api/config/export|import` (JSON, schemaVersion 1), audit log writes on every mutation. Zod-validate every body. Return problem+json errors. Write integration tests with a temp DB for auth, a price version, and export→import round-trip.

✅ Tests green; `curl` login + `GET /api/config` returns the seeded config.

### 3.2 Quotes and parts endpoints ⏱ 1.5 h
*Prompt to Claude:*
> Read REQUIREMENTS §4 FR-2 and FR-4 and §7. Implement customers CRUD; `POST /api/quotes` (allocates `Q-YYYY-NNNN`), `GET /api/quotes` with filters, `GET /api/quotes/:id`, `PUT /api/quotes/:id` (saves a new quote_version, runs calc, stores snapshot + result, returns result), `POST /api/quotes/:id/reprice` (with current config), `POST /api/quotes/:id/copy`, status transitions with won/lost reason, `POST /api/quotes/:id/attachments` (multipart, 25 MB cap, PDF only), `GET /api/quotes/:id/export.csv`. Calc runs server-side on every save so results are authoritative. Tests: create → add golden part → assert selling prices; reprice after a price change; copy keeps inputs but new number.

✅ Integration test reproduces the golden prices through HTTP.

### 3.3 Intake endpoints ⏱ 1 h
*Prompt to Claude:*
> Read REQUIREMENTS FR-3 and §8, and the CSV/PDF resolver code in the prototype HTML (`resolveMaterial`, `resolveThickness`, `parseCSV`, `mapHeaders`, `parseDrawingText`). Port the resolvers to `packages/calc/src/intake/` (pure, tested with the prototype's cases: "CRS", "5052-H32", "304 SS", "Galvanneal A60", "16 ga", ".063", "1/4", "1.5 mm", "titanium" → flagged) but make `resolveMaterial` match against the shop's live material catalog names and aliases rather than a hardcoded list. Add `POST /api/quotes/:id/import-csv` and `POST /api/read-drawing` (Anthropic SDK, model claude-sonnet-4-6, PDF document block, JSON-only prompt, temperature 0, key from env, 30 s timeout, returns the §8 contract; if no key configured return 501 with a clear message). Tests for CSV with the sample file and messy headers; the AI route mocked.

✅ Sample CSV imports 4 lines with the expected notes; `read-drawing` returns 501 without a key and the contract with a mocked client.

---

## Phase 4 — Web app

### 4.1 App shell, auth, design tokens ⏱ 1 h
*Prompt to Claude:*
> Read CLAUDE.md (design section) and take the CSS custom properties, typography and component styles from the prototype HTML as the design system. In `apps/web`: Vite + React + TS, react-router, a typed API client generated from the Zod schemas, login page, app shell (left nav: Quotes, Customers, Settings; user menu), toast + error boundary. Fonts bundled locally (IBM Plex Sans). No Tailwind. Keep components small and in `src/components`. Storybook is not needed; add a `/dev/kitchen-sink` route showing every base component.

✅ Login works against the API; kitchen-sink page renders inputs, buttons, tables, tags, warning box in the prototype's look.

### 4.2 Settings screens ⏱ 1.5 h
*Prompt to Claude:*
> Read REQUIREMENTS FR-1 and §11.2 (add $/cwt entry, assist-gas rate, RoHS flag on plating specs, surcharge %). Build Settings: Shop (name, logo, unit system, currency, defaults, markups, breaks, min strip, validity, terms, enabled modules), Machines (list + detail: type, rate, setup, kerf/clamp, capacities, consumables; a Rates tab editing the machine × material grid with blanks highlighted), Material families and Gauge reference, Materials (searchable table, inline edit, "new price" dialog with effective date, price history drawer, stock sizes, aliases, active toggle), Operations (with machine link), Plating, Coating, Silkscreen, Assembly standards, Intake aliases, Parity flags (with the explanation text from §5.7 next to each), Config export/import, Users. Every table: sort, filter, keyboard-friendly. Owner/admin only; estimator sees read-only.

✅ Change CRS $/lb → save → material history shows two versions → export JSON contains both.

### 4.3 Quote editor — parts and live cost stack ⏱ 3 h (split into two sessions if needed)
*Prompt to Claude:*
> Read REQUIREMENTS FR-2 and §5 and the prototype's form + result panel for layout and behaviors (nesting preview SVG, quantity-break table, three-method comparison, warnings). Build the Quote page: header (customer picker, number, date, status, validity), lines list, and a Part editor panel with sections: Material (catalog picker with search by gauge/alloy; shows lb/ft² and $/lb), Flat size (in/mm toggle, finished area), Nesting (process preset, clamp/kerf, stock width, blank length picker showing yield per multiple, override, SVG preview), Cutting (laser feature counter with hole/obround/rect rows, perimeter, pierces; or punch hit counter), Operations (add from catalog, counts), Finish (plating spec picker, coating model fields, silkscreen tier), Hardware lines, NRE lines, Notes. Right rail: live cost stack per quantity break as a table (material / labor / fixed / finish / hardware / selling / material % of SP), updated by debounced server calc (300 ms), plus warnings. Autosave with a version indicator. Keyboard: Tab order matches the workbook's left-to-right flow.

✅ Enter the golden part by hand and see 37.83 / 8.74 / 6.34 / 4.74 / 4.42 / 4.18 in the rail. Estimator can do it in under 3 minutes.

### 4.4 Intake UI ⏱ 1.5 h
*Prompt to Claude:*
> Read FR-3 and the prototype's drop zone, parts table and drawing review cards. On the Quote page add "Add parts from file": drop CSV or PDFs; CSV → preview table with per-row notes → confirm → lines. PDF → one review card per page (pdf.js text layer + thumbnail; fields tagged found/guess/missing; "Read with AI" button calling `/api/read-drawing`; "Show text"); confirm → line with the PDF attached. Scans show the no-text-layer message.

✅ Drop the four sample PDFs: three read correctly, the scan says so; sample CSV creates four lines.

### 4.4b DXF flat-pattern import ⏱ 2 h
*Prompt to Claude:*
> Read REQUIREMENTS §11.4 item 1. Implement `packages/calc/src/intake/dxf.ts` (pure geometry: entities → closed loops → outer loop bounding box, net area via shoelace minus inner loops, total cut length with arcs/circles exact and splines approximated to 0.005 in, pierce count = closed loops, hole list by diameter) with tests on three sample DXFs you generate (a rectangle with four holes, an L-bracket flat with an obround slot, a circular flange with a bolt pattern). Add drop-zone support for `.dxf` on the Quote page: creates or fills a part line with flat size, finished area and the full laser feature list, tagged as source "dxf". Show the parsed outline in the nesting preview instead of a rectangle.

✅ Drop the rectangle-with-holes DXF: cut length equals 2(L+W)+4πd to 0.01 in; pierces = 5; area = LW − 4π(d/2)².

### 4.5 Quote log, customers, outputs ⏱ 2 h
*Prompt to Claude:*
> Read FR-4 and FR-5. Build the Quotes list (search, filters, status chips, won/lost with reason, copy to new), Customers list/detail, and the PDF outputs: an HTML template for the customer quote (logo, number, date, valid-until, customer, per-part price at each break, lead time, terms, notes — no costs) and one for the internal cost sheet (everything, including nest and the parity flags used), rendered by Puppeteer via `GET /api/quotes/:id/pdf?kind=customer|internal`. "Email" button opens `mailto:` with a link for v1. Reports page: quotes per month, win rate, material % of SP histogram (plain tables).

✅ Print both PDFs for the golden quote; the customer one has no cost figures; the internal one shows the stack and "parity: Q1 on, Q2 on…".

---

## Phase 5 — Deploy, backup, pilot

### 5.1 Packaging ⏱ 1 h
*Prompt to Claude:*
> Read REQUIREMENTS §2 and §7. Create `deploy/docker-compose.yml` (app + caddy for HTTPS with internal CA or self-signed + a backup sidecar that copies `data/` nightly to `BACKUP_PATH` with 30-day rotation), `deploy/windows/` (node service via nssm, scheduled-task backup script, restore steps), `.env.example` with every variable documented, and `docs/RUNBOOK.md`: install, first login, restore from backup (tested steps), upgrade, where logs are. Health endpoint `/healthz`.

✅ Fresh machine → follow RUNBOOK → login → golden quote reproduces. Restore from a backup copy works.

### 5.2 🧑 Pilot: parallel run
Estimator quotes the next 10 RFQs in both Excel and ShopQuote. Log differences in `docs/pilot-log.md` (quote, field, Excel value, app value, cause). Bring each cause to Claude as a bug or as a spec clarification.

### 5.3 Fix-and-harden session(s) ⏱ variable
*Prompt to Claude:*
> Read `docs/pilot-log.md`. For each row: reproduce in a test first, then fix, then re-run the golden test and the full suite. Do not change parity behavior without a corresponding flag and a line in `docs/parity-report.md`.

✅ 10 quotes match; estimator signs off; Excel retired.

---

## Phase 6 — Second shop (the repeatable part)

What changes for another sheet metal shop: nothing in code. They get an empty shop (`seed-blank.ts`) or their workbook loaded, then enter their machines, materials, rates and terms in Settings — or import a config JSON. Parity flags default off. What should not change: `packages/calc`, the UI, deploy. For a shop in a different trade (machining, millwork) the roll-up, operations, finish, hardware and NRE contributors are reused; a new material form (bar/board) and new time-model contributors are added behind the interface and enabled per shop — that is why calc is split by module.

*Prompt to Claude (when the time comes):*
> Read REQUIREMENTS and `docs/parity-report.md`. We're deploying for a second shop. Write `docs/ONBOARDING.md`: the questionnaire (§10 generalized), the config JSON they must provide, how to load their workbook if they have one, which parity flags to start with (default all off for a fresh shop), and the pilot procedure. Add a `scripts/new-shop.ts` that creates a shop record, admin user, and imports a config JSON.

---

## Working rules for every session (also in CLAUDE.md)
- Read the referenced spec sections before writing code; quote the section number in the commit message.
- Tests first for anything with a number in it. The golden test must stay green at all times.
- Never "fix" a mismatch by editing the fixture. Find the formula.
- Parity means the §9 oracle and nothing else: six selling prices, six material percentages, five intermediates. Don't add tests or code paths to match other workbook cells.
- Small commits, one task per commit, conventional commit messages.
- When the spec is silent, choose the simplest option and write the decision to `docs/decisions.md` (date, decision, why, alternatives). Don't ask the user for choices you can make reversibly.
- Stop and ask only when a decision is irreversible (schema shape that affects data already entered, pricing behavior the owner hasn't approved).
