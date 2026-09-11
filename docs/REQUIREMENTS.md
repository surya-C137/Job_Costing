# ShopQuote — Requirements & Reference Spec
### Internal quoting system for a sheet metal job shop (v1, single shop; designed to be re-deployed per shop)

This document is the reference Claude should read before every task in BUILD-PLAN.md. It combines: (a) the shop's existing Excel estimator (`Quote_Metal_Cost.xls`), (b) the browser prototype (`sheet-metal-material-calculator.html`, the reference implementation of the material module and of CSV/PDF intake), and (c) decisions made during planning.

**How to use the workbook.** It is three things and only three: a record of *how this shop thinks about cost* (take the concepts, model them in our own types); *seed data* for Settings (the owner overwrites it on day one); and a *validation oracle* for the small set of numbers in §9. It is not a specification. Do not replicate its layout, helper columns, index-number lookups, "per 100" internal representation, or any mechanism that doesn't change a selling price or help the estimator. When in doubt: would a modern shop that never had this spreadsheet want it?

---

## 1. Purpose and scope

**Problem.** The estimator quotes from a 1998-era Excel workbook. It works, but it is one file, one user, no history, no quote log, no way to re-price a job when steel moves, and every quote is retyped from the drawing.

**Goal for v1.** Replace the workbook with a small on-premises web app that: prices the way this shop prices (validated by the golden case in §9), keeps every quote and its cost stack, prints the customer quote and the internal cost sheet, reads parts from CSV and PDF drawings, and lets the owner edit every rate and standard without a developer.

**Non-goals for v1.** Scheduling, job tracking, inventory, purchasing, invoicing, accounting integration, CAD/DXF nesting, customer portal. (The data model must not block these later — see §7.)

**Users.** 1 estimator (daily), 1 owner (reviews quotes, edits rates), occasionally an office admin (prints/emails). Max ~5 accounts. All on the shop LAN.

**Success criteria.**
1. Golden test (§9) passes: the app reproduces the workbook's six selling prices to the cent.
2. Estimator completes 10 real RFQs in the app in parallel with Excel; totals match within rounding, and each quote takes no longer than in Excel.
3. Owner changes a rate (e.g., $/lb on CRS) and every open quote re-prices without developer help.
4. Runs on the shop's server, survives a reboot, backs itself up nightly.

---

## 2. Architecture and stack (decided)

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js 22 LTS, TypeScript everywhere | One language; Claude Code is strongest here |
| Backend | Fastify | Small, fast, good TS typing |
| Database | SQLite via better-sqlite3 + Drizzle ORM | Single file on-prem, trivial backup (copy the file), no service to run. Postgres migration later if a shop ever needs it |
| Frontend | Vite + React + TypeScript, plain CSS (design tokens from the prototype) | No Tailwind build surprises; prototype's look carries over |
| PDF output | Puppeteer (headless Chromium) printing an HTML template | Pixel-accurate quotes, one template to maintain |
| PDF input | pdf.js (text layer) on the client, optional AI reader on the server (Anthropic API) | Same approach as the prototype |
| Auth | Local username/password, server-side sessions, roles: `estimator`, `owner`, `admin` | LAN-only; no SSO needed |
| Packaging | Docker Compose (app + nightly backup sidecar) **and** a plain `node` start script for Windows Server boxes | Shops run either |
| Tests | Vitest (unit + calc engine golden tests), Playwright (a few end-to-end flows) | |

**Repo layout (monorepo, npm workspaces):**
```
shopquote/
  CLAUDE.md                 project conventions (see file)
  docs/REQUIREMENTS.md      this file
  docs/BUILD-PLAN.md        task list
  docs/reference/           Quote_Metal_Cost.xls, prototype HTML, sample drawings/CSV
  packages/calc/            pure TS costing engine, zero deps, ≥95% covered
  packages/db/              Drizzle schema, migrations, seed
  apps/api/                 Fastify server
  apps/web/                 Vite React app
  deploy/                   docker-compose.yml, backup script, Windows service notes
```

**Principle: calc is a pure library.** `packages/calc` takes a `ShopConfig` (all rates and tables) and a `QuoteInput`, returns a `QuoteResult`. No DB, no I/O, deterministic. Everything else is plumbing around it. This is what makes the second shop a config change, not a rewrite.

**Principle: nothing about a shop is a constant.** Equipment, materials, gauges, stock sizes, finishes, standards, units, currency, quantity breaks, markups, terms — all data. Code knows *shapes* (a machine has a rate and a setup time; a material has a density and a form), never *instances* (a laser, 16 ga CRS). See §12 for the full split.

---

## 3. Domain model (what the app knows about)

- **Shop config** — one record per shop: name, logo, **unit system** (`imperial | metric`, display/entry only; engine is always in/lb), **currency**, quote terms and validity days, default quantity breaks `[1,5,10,30,50,100]`, fixed cost per job, labor markup, material markup, NRE rate and markup, minimum-charge strip, parity flags, enabled cost modules (§12).
- **Material families** — table: name (steel, galvanized, stainless, aluminum, copper, brass, …), density lb/in³, default scrap $/lb, aliases for intake matching (`CRS`, `A36`, `HRPO` → steel). Editable; a shop can add "acrylic" or "plywood".
- **Gauge reference** — table: family × gauge label → decimal thickness (and optional lb/ft² override for coated stock). Seeded with MSG/galvanized/stainless/aluminum tables; editable.
- **Material catalog** — one row per stock item: name, family, **form** (`sheet` in v1; `plate`, `bar`, `tube`, `purchased` reserved), thickness, lb/ft² (or lb/ft for bar), $/lb (versioned, §7), default stock size, scrap $/lb, aliases, active. No machine-specific numbers on this row. **$/lb may be absent** — the shop stocks it but has never priced it (the workbook has fourteen such rows, the brushed stainless range, and a shop part-way through entering its catalog has more). An unpriced material warns and refuses to cost the part; it is never treated as free (§12 rule 3).
- **Stock sizes** — table per material (or per family): length × width, preferred flag. Replaces the hardcoded sheet list.
- **Machines (work centers)** — table: name (`Laser 1`, `Pega 357`, `Brake 2`), type (`laser | punch | waterjet | plasma | shear | brake | weld | deburr | other`), rate $/hr, setup hrs default, consumables $/hr (assist gas), max sheet L × W, clamp strip in, part spacing/kerf in, pallet-change s, pallet batch parts, intersection s, rapid s per pierce, loss factor, load/unload s per blank, hit-rate table for punches, active. A shop with two lasers has two rows. `type` selects which cost contributor (§12) prices the machine — it is never switched on inside a formula, so adding a waterjet is a Settings row plus an existing feature-based contributor, not a code change. This table supersedes the workbook's "process presets": clamp and kerf live on the machine that has them.
- **Machine–material rates** — table: machine × material → cutting speed in/min, pierce s, punch rate factor. This is where the workbook's speed columns go. Missing pair → estimator is warned, not blocked.
- **Operations catalog** — name, optional machine (work center) it runs on, setup hours, standard (parts/hr, in/hr, bends/hr, etc.), `standardUnit` (`pieces | inches | sqIn`, so the UI can label the input and calc can validate it), rate $/hr (inherited from the machine when linked), `kind` (`machine | manual` — selects quirk Q2's factor; implied by a machine link, stored explicitly because the workbook has no such column), active. A shop defines its own list; the seed is the workbook's.
- **Finish tables** — plating specs (min lot $, $/in², part min $), coating models (powder/liquid), silkscreen tiers.
- **Assembly standards** — seconds per action.
- **Customer** — name, contact, email, terms, default markup override.
- **Part** — number, rev, description, material (catalog ref), flat length/width, finished area, cut length, pierces, bends, operations list with quantities, finish selections, hardware lines, NRE lines, notes, attachments (drawing PDF).
- **Quote** — number (`Q-YYYY-NNNN`), customer, date, status (`draft / sent / won / lost / expired`), lines (each a Part + its quantity breaks), config snapshot (frozen copy of every rate used), outputs (cost stack per break, selling price per break, material % of SP), PDF files, won/lost reason.

---

## 4. Functional requirements

### FR-1 Settings (owner)
- Edit every number in §3 through forms; no code. Changes take effect on new quotes; existing quotes keep their snapshot unless the user clicks "Re-price with current rates".
- Material price changes create a new price version with effective date (so history is auditable).
- Import/export the whole config as JSON (this is how the next shop starts).

### FR-2 Quote editor (estimator)
- Create quote → add parts (manually, from CSV, from PDF drawing, or copy from a past quote).
- Per part: material picker (search by name/gauge), flat size (in or mm), finished area, quantity breaks (default from config, editable per quote), process, nesting (auto grid with override), cutting (laser feature counter or entered cut length + pierces; punch hit counter), operations (pick from catalog with counts: bends, inches of weld, etc.), finish (plating pick, coating model, silkscreen), hardware lines, NRE lines.
- Live cost stack per quantity break, updated on every change: material, labor, fixed, finish, hardware; selling price; material % of SP; nesting preview.
- Warnings, not blocks: min charge applied, yield < 50%, part doesn't fit sheet, material inactive.
- Save is autosave; every save is a version.

### FR-3 Intake
- CSV parts list (contract as in the prototype: `part, material, thickness, length, width, qty, [units, finished_area, sheet, process, parts_per_sheet]`; loose header matching; flagged rows).
- PDF drawings: text-layer parse to a review card (found / guess / missing per field), user confirms → part line. Thumbnail of page 1. Multi-page PDF → one card per page (improvement over prototype).
- AI reader (server route `/api/read-drawing`): sends the PDF to the Anthropic API, returns the JSON contract in §8. Used for scans and when the estimator clicks "Read with AI". API key in server env only.

### FR-4 Outputs
- **Customer quote PDF**: header/logo, quote number, date, valid 30 days, customer, each part with description/rev and price per break, lead time, terms, notes. No costs.
- **Internal cost sheet PDF**: everything — nest, sheets, cost stack per break, margins, material %.
- **Email**: open mail client with PDF attached (v1), SMTP send (v1.1).
- **Quote log**: list/search/filter by customer, status, date, part number; status changes; won/lost reason; "copy to new quote".
- **Costed CSV export** per quote (same columns as prototype export).

### FR-5 Reporting (v1 minimal)
- Quote volume and win rate by month; material % of SP distribution; quotes by customer. Simple tables; charts later.

### FR-6 Users and audit
- Login, roles, password reset by admin. Every quote save records who/when. Config edits are logged.

---

## 5. Costing rules

These are the shop's pricing *concepts*, written as formulas. Implement them as clean per-part functions with explicit inputs; the workbook's cell mechanics are not the spec. Where the workbook's behavior is quirky, v1 reproduces the *result* behind a flag so the golden test passes (§5.7); it does not reproduce the mechanism.

### 5.1 Material
```
lb_ft²        from catalog (coated steels carry coated weight)
blank_area    = L × W  (in²)
blank_lbs     = blank_area / 144 × lb_ft²
nesting       clamp off one width edge (clampStripIn from the machine row); kerf/spacing added to each part dimension;
              parts_across = trunc((stock_width − clamp) / (dim + kerf)) ;  parts_along = trunc(std_length / (other_dim + kerf));
              try both orientations, take max  → parts_per_blank (pps)
blank_cost    = (stock_width × std_length / 144) × lb_ft² × $/lb
mtl_per_part  = blank_cost / pps                                   ["share of blank"]
min_charge    = (stock_width × minChargeStripIn / 144) × lb_ft² × $/lb   [shop default 12 in]
mtl_at_qty    = MAX(mtl_per_part, min_charge / qty × material_markup)   ← note markup inside the MAX (quirk Q1)
```
Std length comes from the material row (aluminum 144, steel 120). Blank length is a single user-editable input defaulting to std length; the UI may offer a short list of common cut lengths (e.g. 48, 60, 72, 96, 120, 144) with yield shown for each. The workbook's multiples lookup grid is not a data structure we keep.

### 5.2 Cutting — laser
```
cut_in        = Σ holes π·d·n + Σ obrounds ((L−W)·2 + π·W)·n + Σ rects (2L+2W)·n + perimeter + misc
pierces       = feature count + 1
pierce_hrs    = pierces × pierce_s / 3600
cut_hrs       = (cut_in / speed_in_min) / 60
intersections = n × intersectionSec ; rapids = pierces × rapidSec
pallet change = palletChangeSec ÷ palletBatchParts, only while parts_per_sheet < palletBatchParts
laserHrsPerPart = (pierce_hrs + cut_hrs + rapids + intersections + pallet) × lossFactor   [per part]
```
Every named constant above is a **machine row** field, not a literal: `intersectionSec` (0.3), `rapidSec` (0.6), `palletChangeSec` (60), `palletBatchParts` (100), `lossFactor` (1.08) — the workbook's values, seeded and editable.

**The pallet term divides by the batch, not by the sheet yield.** An earlier draft of this section read "60 s ÷ parts_per_sheet", which for the §9 part is 60 ÷ 41.25 = 1.45 s and misses the laser oracle by 4.9%. The worksheet's own cell (`F33` = 1.6667e-04 h) is 0.6 s — 60 ÷ 100. The rule is: one pallet change per batch of `palletBatchParts`, spread across that batch, charged only while a single sheet yields fewer parts than the batch. `F33` happens to equal `F32` (the rapid factor) in the saved quote, so a copy-paste error in the workbook would look identical from one save; see `docs/discovery.md` and §10. A shuttle-table fiber laser has a different pallet time and a shop with better nesting software a different loss factor, so none of them may be hardcoded. Speed and pierce come from the **machine–material rate** for the selected machine; clamp, kerf and assist-gas $/hr from the machine row. Seed values in §6 are loaded against a single seed machine ("Laser 1") — the owner renames it or adds more.

### 5.3 Cutting — turret punch
Hit counter by tool type × hit rate (seeded: bridges 5000/hr, cluster 4000, countersink 4500, EKO 4500, emboss 3500, extrusion 5000, tap 3000, relief 5500, trim 5000 — stored per punch machine; ten tools, not eleven: the workbook's "TOTAL HIT COUNT" row is a spreadsheet subtotal, not a tool) + load/unload s per blank (machine row); punch rate factor from the machine–material rate.

### 5.4 Operations (labor)
Per operation row: `setupHrs`, `standard` (parts/hr, or in/hr for weld/grind), `ratePerHr`. All engine math is **per part**; "per 100" is a display convention only.
```
fixed$        = setupHrs × ratePerHr                          (per job; ÷ qty in the roll-up)
hrsPerPart    = machine ops: hours from §5.2/§5.3 per part ;  manual ops: units / standard
directPerPart = hrsPerPart × ratePerHr × (isMachineOp ? parity.machineTimeFactor : 1)   ← quirk Q2 as a dialable factor
```
`parity.machineTimeFactor` is a **number**, not a boolean: 0.6 reproduces the workbook's ×60 (recovered as `G33 × F33 / E33 = 60`, i.e. 60/100), and 1.0 bills machine time as machine time. An owner can dial anything between. Seed standards in §6.

### 5.5 Finish
- **Plating**: `MAX(lot_min / qty, $/in² × blank_area, part_min)` per part.
- **Powder/liquid coat** (workbook model, reproduce as-is — quirk Q3): `cost = rate × (perimeter / T × S)` with the workbook's S=5, T=100, rate=0.5 for powder; plus plugs/caps 0.05, fill/prep 0.25, masking dots 0.05, mask/demask minutes × $25/hr, parts per hook (600/180) or hanger (600/90), liquid-texture adder +50%, minimum rate. `perimeter = 2(L+W)`.
- **Silkscreen**: screen charge (one-time, amortized) + print cost per part by tier.

### 5.6 Roll-up per quantity break
The roll-up is trade-agnostic: it sums *cost contributors*, each tagged with a bucket (`material | labor | fixed | finish | hardware | nre`) and a markup class. Sheet-metal modules (nesting, laser, punch, brake) are contributors; a machining shop would register different ones. The workbook's order, expressed in those buckets:
```
material_block = sheet_material(qty) + sheet_extras + hardware + plating          × material_markup
labor_block    = (fixed_cost / qty + direct_labor + setup_extra_labor)              × labor_markup
unmarked       = painting + silkscreen                                              (no markup — quirk Q4)
selling        = material_block + labor_block + unmarked
mtl_pct_sp     = sheet_material(qty) ÷ selling
```
Where `fixed_cost` = Σ op fixed_$ (that is, Σ `setupHrs × ratePerHr` over the operations on the part) + `shopFixedCostPerJob` + NRE.

`shopFixedCostPerJob` is an optional flat per-job adder and **seeds to 0**. The workbook's `D13` = $20 is not a shop constant: it is the sum of the per-operation fixed-dollar column, and for the golden part the laser's only setup (0.2 h × $100) accounts for all of it. Seeding it as a $20 shop default would double-count to $40 and miss every §9 price. A shop that does want a flat job charge sets it in Settings.

### 5.7 Quirks to reproduce behind flags (`config.parity.*`)
- **Q1** Material markup applied inside the minimum-charge MAX.
- **Q2** `machineTimeFactor` — machine-op hours are billed at 0.6× (the workbook's ×60 against manual ops' ×100). A number, not a boolean: 0.6 = workbook, 1.0 = machine time billed as machine time. Ask the owner what the 60 means; keep until answered.
- **Q3** Powder-coat "area" is actually the perimeter, and the constants (5, 100, 0.5) are unexplained. Reproduce, then confirm.
- **Q4** Painting and silkscreen are added after markups (no markup).
- **Q5** — *withdrawn; not a flag.* Kerf/part spacing is a **machine row** field (`kerfIn`, §3), seeded at the workbook's 0.5 for "Laser 1". A fiber shop types 0.375 in Settings; a shop with two lasers gives each its own. Nothing is lost — the golden case pins 0.5 in its fixture — and a flag would have needed a defensible "off" value that only the machine row can supply.

So `config.parity.*` carries **four** flags: Q1–Q4. Each defaults to the workbook behavior and the golden test runs with all of them on. Turning one off requires a row in `docs/parity-report.md` and, per §11.3, a real alternative path — never `else → 0`.

---

## 6. Seed data (from the workbook — load these into the catalog)

**Materials (excerpt; full table is in the xls, columns B..R rows 123–210):** name, thickness, lb/ft², $/lb, std length, speed in/min, pierce s, punch factor.
```
CRS 16 GA (.0598)      0.0598  2.500  0.41  120  254  0.10  0.95
CRS 14 GA (.074)       0.0747  3.125  0.41  120  236  0.10  0.90
CRS 11 GA (.120)       0.1196  5.000  0.41  120  140  1.00  0.85
CRS 10 GA (.134)       0.1345  5.625  0.41  120  130  1.00  0.80
HRPO PLATE .25         0.2500 10.210  0.70  120   94  2.00  0.00
G30 16 GA (.0598)      0.0598  2.656  0.8099 120 220  0.10  1.00   ← golden-test material
GALVANNEAL 16 GA A60   0.0598  2.656  0.465 120  268  0.10  1.00
ST STL 16 GA (.060)    0.0598  2.463  1.98  120  220  0.15  1.00
ST STL 11 GA (.119)    0.119   4.901  1.98  120  120  1.00  0.60
ALUM .063 5052-H32     0.063   0.880  5.109 144  268  0.20  1.00
ALUM .125 5052-H32     0.125   1.746  4.865 144   98  0.50  0.90
ALUM .090 6061-T6      0.090   1.257  2.50  144  177  0.50  0.95
COPPER .032            0.032   1.490  3.82   96   –    –     –
```
Prices are 2023-era; the owner will update on day one — which is exactly the workflow FR-1 must make easy.

**Operations:** shear 100/hr $75; laser setup 0.2 h, $100/hr; punch (Pega 50×72, EM2510NT 60×98) $75; drill/csk 167; drill/tap 200; deburr 100; tumble 100; brake 222 and 330; weld 200; grind 200; spot weld 215; PEM 350; stud weld 100; rivet 150; machining 100; check & straighten 60; assembly 80. All $75/hr except laser $100. Standards are per hour of the row's `standardUnit`: `pieces` for most, `inches` for weld and grind (the workbook also notes 120 in/hr for both — the estimator picks the row that matches how the feature is counted).

The workbook's tumble line carried a bespoke formula (`min(0.004 × area + 0.6, 2)` hours per 100). It is not seeded: a per-100 expression keyed to one operation's name is exactly the hardcoding §12 rule 1 forbids, and it would be the only operation in the catalog that prices differently from every other. Tumble seeds as an ordinary 100/hr row. If the owner confirms the area rule matters, it returns as an optional area-based standard *any* operation can use, not as a special case.

**Bends:** 220–250 bends/hr.  **Plating table:** 43 rows in xls rows 72–115 (spec, lot min, $/in², part min).  **Assembly standards:** xls sheet "Assy-Handling Cost Estimator" (seconds per action).  **Clamp/kerf:** laser 1.0/0.5, punch 2.0/0.7.  **Sheet widths:** 36/48/60.  **Blank multiples:** 12,18,20,24,28.8,30,36,40,48,60,72,80,96,100,120,144.

---

## 7. Data and non-functional requirements

- **Snapshot on save.** A quote stores the full `ShopConfig` used. Re-pricing is an explicit action.
- **Versioned prices.** `material_price(material_id, price_per_lb, effective_from, entered_by)`.
- **Soft delete only.** Nothing is hard-deleted; `archived_at`.
- **IDs.** ULIDs. Quote numbers are a separate human sequence.
- **Attachments** stored on disk under `data/attachments/<quote>/`, path in DB.
- **Backups.** Nightly copy of `data/` (SQLite file + attachments) to a second disk/NAS path, 30-day retention, restore procedure documented and tested.
- **Performance.** Cost stack recalculates in < 50 ms for a 20-line quote; page loads < 1 s on LAN.
- **Offline.** No internet dependency at runtime except the optional AI reader and font CDN (bundle fonts locally).
- **Security.** LAN only; HTTPS via self-signed or internal CA; sessions expire in 12 h; rate-limit login; API key for the AI reader in env; PDF uploads capped at 25 MB and stored, never executed.
- **Future-proofing.** `Part` and `Quote` shapes must map to a later `Job`/`WorkOrder` without renaming (job = won quote line + due date + routing).

---

## 8. Interface contracts

**AI drawing reader** — `POST /api/read-drawing` body `{ filename, pdfBase64 }` → `{ part, rev, material, thickness, length, width, qty, units: "in"|"mm", cutLength?, pierces?, bends?, notes }`; arrays allowed for multi-detail drawings. Model: `claude-sonnet-4-6`, PDF as document block, JSON-only prompt, temperature 0.

**CSV parts list** — as in prototype; response returns the created part lines with per-row notes.

**Config JSON** — full export/import; schema versioned (`schemaVersion: 1`). The file is `{ format: "shopquote.config", schemaVersion: 1, exportedAt, config: ShopConfig, priceHistory: [...] }`: the config as of `exportedAt`, plus every material price version (§7) so history survives the trip. Users, customers and quotes are not in it. Import makes the shop's catalog equal the file, matching rows by id (new ids insert, missing rows archive, nothing is deleted), and `?dryRun=true` reports the changes without making them. A file whose config prices disagree with its history is refused; a hand-written file may omit `exportedAt` and `priceHistory`, and its prices then take effect at import.

---

## 9. Golden test (must pass before any UI work) — the *only* workbook parity that matters

Inputs (taken from the workbook as saved):
- Material: `G30 16 GA (.0598)` — 2.656 lb/ft², $0.8099/lb, laser speed 220 in/min, pierce 0.1 s
- Part 13.38 × 7.858 in, blank area 105.14 in², blank lbs 1.9392
- Laser, clamp 1.0, kerf 0.5, stock width 48, blank length 96 → **33 parts per blank**
- Laser worksheet: perimeter cut 58 in, 1 pierce, 1 intersection → **0.0052255 laser hours per part** (with the 1.08 loss factor; the workbook displays this as 0.52255 per 100)
- Laser op: setup 0.2 h × $100 = **$20**, which *is* the job's fixed cost (§5.6); direct labor per part **$0.31353**
- Powder coat: perimeter 42.476 → **$1.0619** per part (min rate 1.0619)
- Shop flat charge 0, labor markup 1.2, material markup 1.2, NRE 0 — so fixed cost = $20, all of it laser setup
- Quantity breaks 1, 5, 10, 30, 50, 100

Expected:
| Qty | Sheet material | Selling price | Material % of SP |
|---|---|---|---|
| 1 | 10.3254 (min charge) | **37.8286** | 27.3% |
| 5 | 2.0859 | **8.7413** | 23.9% |
| 10 | 2.0859 | **6.3413** | 32.9% |
| 30 | 2.0859 | **4.7413** | 44.0% |
| 50 | 2.0859 | **4.4213** | 47.2% |
| 100 | 2.0859 | **4.1813** | 49.9% |

**The oracle, in full — six selling prices, six material percentages, and five intermediates.** Nothing else. The five:

| Intermediate | Value | Asserted by |
|---|---|---|
| blank cost | 68.8358 | §5.1, Task 1.2 |
| min charge | 8.6045 | §5.1, Task 1.2 |
| material per part | 2.0859 | §5.1, Task 1.2 |
| qty-1 material | 10.3254 = max(2.0859, 8.6045 × 1.2) | §5.1, Task 1.2 |
| laser hours per part | 0.0052255 | §5.2, Task 1.3 |

Tolerance ±0.005 on price, ±0.001 on material % of SP, 4 decimals on the intermediates. Add a second fixture once the estimator gives you a recent real quote with its Excel result.

**What not to test:** any other workbook intermediate (nesting-table cells, per-100 columns, lookup indices, sheet factors). Tests assert our own function outputs against the seventeen numbers above and against hand-derived cases; they never assert cell-for-cell agreement.

---

## 10. Open questions for the owner/estimator (answer in Phase 0)
1. What does the ×60 on machine operations represent (Q2)? Is laser labor meant to be 60% of machine time?
2. Powder coat constants 5 / 100 / 0.5 — what are they (Q3)?
3. Is the 12 in minimum strip still current? Different for aluminum?
4. Current $/lb for the ten most-used materials; which supplier; how often do prices change?
5. Laser: still CO₂, or fiber now? Current kerf/spacing? Which machine does most of the work (laser vs Pega/EM2510)?
6. Quote validity period, standard lead times by process, terms text, logo, who signs.
7. Which fields on the customer PDF; do any customers require their own quote form?
8. Where is the server; who is IT; backup target; how are drawings received (email/portal)?
9. Which 10 recent quotes can we use for parallel validation?
10. Pallet changes (§5.2): is the 60 s costed **once per 100-part run** — which is what the worksheet's `F33` does, and what reproduces §9 — or once per sheet, which for the golden part would be 2.4 changes and 4.9% more laser time? `F33` is numerically identical to the rapid-factor cell above it, so one save cannot tell the intended rule from a copy-paste.
11. NRE (§5.6): the section puts NRE inside `fixed_cost`, and `fixed_cost` takes the labor markup — so a 1.3 NRE markup on a 1.2 labor markup compounds to 1.56. Is engineering meant to be marked up **once at 1.3**, or twice? The golden case has no NRE, so the oracle cannot settle it. Reproduced as written for now; if the answer is "once", it is a one-line change in `nre.ts`.

---

## 11. Modernization review (what to keep, refresh, or add vs. the 1998 workbook)

Principle: parity first, then modernize as **data** (Settings) or **flags**, never as silent code changes.

### 11.1 Keep — still standard practice
Share-of-blank material costing; minimum-charge strip; quantity breaks with setup amortization; separate material/labor markups; material % of selling price; clamp-strip grid nesting for estimating; feature-count laser model with loss factor; punch hit-rate model; plating `MAX(lot min, $/in², part min)`; assembly standard seconds.

### 11.2 Refresh as seed/settings data (day-one owner task, guided by Settings screens)
| Item | Workbook | 2026 reality | Action |
|---|---|---|---|
| Laser speeds / pierce | CO₂-era (16 ga CRS 254 in/min, 0.1 s) | Fiber 6–12 kW: ~3–4× faster thin gauge; sub-0.1 s pierces | Speed/pierce columns editable per material; add a "laser type" note; add **assist-gas $/hr** to the laser rate |
| Kerf/spacing | 0.5 in laser | 0.25–0.375 in fiber | Machine row (`kerfIn`), per machine — not a flag (see §5.7 Q5) |
| Shop rates | $75 manual, $100 laser | ~$85–125 manual, $150–250 laser | Operations table |
| Material prices | 2023 | tariff-volatile | Versioned prices; add **$/cwt** input (÷100) alongside $/lb; optional surcharge % line |
| Plating spec names | QQ-P-35, MIL-C-5541, QQ-P-416, QQ-N-290, MIL-C-13924, MIL-C-26074 | ASTM A967/AMS 2700, MIL-DTL-5541, AMS-QQ-P-416, AMS-QQ-N-290, MIL-DTL-13924, ASTM B733 | Refresh names; keep old names as aliases for reading old drawings |
| RoHS / REACH | not modeled | hex-chrome yellow chromate, cadmium restricted for most commercial work | `rohs_compliant` flag per plating spec; trivalent alternatives added; estimator warned when a non-compliant finish is picked for a customer flagged RoHS |
| Quantity breaks | 1/5/10/30/50/100 | often also 250/500 | Config default; per-quote editable (already) |

### 11.3 Change behind flags (see §5.7)
Q2 (×60 machine factor) and Q3 (perimeter-as-area coating) are almost certainly artifacts. The modern coating model uses the powder industry's standard coverage formula rather than the workbook's unexplained constants:

```
coverage ft²/lb = 192.3 ÷ specific gravity ÷ film mils × transfer efficiency
cost            = coated area ft² ÷ coverage × powder $/lb + rack/hang + masking
coated area     = L × W × sides ÷ 144
```

192.3 ft² is one pound of a specific-gravity-1.0 powder at 1 mil with perfect transfer. Storing the three inputs rather than a single coverage number matters because they are what an owner knows and changes: the powder's data sheet gives specific gravity, the finish spec gives film build, and the booth gives transfer efficiency (50–80% on a first pass, higher with reclaim). Implement it as the non-parity path so switching the flag off yields a defensible number, not zero.

**A note on the plating rate, checked against the trade.** §5.5 charges plating at `$/in² × blank_area`, i.e. one face. Plating shops quote on exposed surface area — both faces — at roughly $0.75–$3.50/ft², with a $50–$400 lot minimum. The workbook's $0.05/in² is $7.20/ft² of *footprint*, which is $3.60/ft² of actual two-sided area and lands in the upper part of that range. The rate already has both sides in it. Doubling the area to "correct" the model would double the price; the seeded lot minimums ($125) are in range too. Left as it is, deliberately.

### 11.4 Add — capabilities the workbook couldn't have
1. **DXF flat-pattern import** (Phase 4, after PDF intake): parse DXF (lines, arcs, circles, polylines, splines approximated) → outer profile bounding box, net area (shoelace on outer minus inner loops), total cut length, pierce count (= closed loops), hole list by diameter. Populates flat size, finished area, and the entire laser feature worksheet automatically. Library: `dxf-parser` (client or server), pure geometry in `packages/calc/src/intake/dxf.ts`, tested with three sample DXFs. STEP unfolding is out of scope (requires CAD kernel).
2. **Freight, packaging, rush multiplier, minimum order charge** as quote-level lines.
3. **Material surcharge %** and **price alerts** (open quotes older than N days with material price changes since snapshot).
4. **Scrap credit** — supported, default off (unchanged from prototype).
5. **Hours per 100** — display convention only; engine stores per-part.

### 11.5 Explicitly not changing
Nesting method (grid) for estimating; per-operation standards structure; the six-break quote layout the shop's customers already know.


---

## 12. Configurability model — what is data vs. what is code

| Data (Settings, per shop; exported/imported as config JSON) | Code (shared by every shop) |
|---|---|
| Machines and their rates, setup, kerf/clamp, capacities, consumables | The shape of a machine and how its time turns into cost |
| Machine × material speeds, pierce times, punch factors | The laser/punch time models |
| Material families, gauge tables, catalog, stock sizes, versioned prices, aliases | The material module (sheet nesting, share-of-blank, minimum strip) |
| Operations catalog and standards | Setup + standard + rate → cost |
| Plating specs, coating models, silkscreen tiers, assembly standards | The MAX(lot, per-in², part-min) rule; the coating model |
| Markups, fixed cost, NRE rate, quantity breaks, minimum strip, validity, terms, logo | The roll-up and PDF templates |
| Unit system, currency, number formats | Conversion at the edges; engine in in/lb/$ |
| Parity flags | The alternate code paths they select |
| Enabled cost modules (`sheetMetal.nesting`, `sheetMetal.laser`, `sheetMetal.punch`, `forming.brake`, `finish.plating`, …) | The module registry and the contributor interface |
| Intake aliases (material names, header synonyms, drawing keywords) | The resolvers and parsers |
| Users, roles | Auth |

Rules:
1. If a value could differ between two shops in the same trade, it is a Settings field.
2. If a *capability* could differ between trades (sheet vs. bar stock, laser vs. CNC mill), it is a module behind the contributor interface, switchable per shop.
3. Seed data is a starting point, never a fallback in code. Missing data produces a visible warning ("no speed for Laser 2 × 304 SS 11 ga"), never a silent default.
4. The multi-shop schema (`shops` table, `shop_id` on every table) is kept even though v1 deploys single-tenant, so a hosted multi-shop version later is a deployment choice, not a migration.
5. `packages/calc` exposes `CostContributor { id, bucket, markupClass, compute(input, config, qty): ContributorResult }`. The sheet-metal modules are the first implementations; the roll-up depends only on the interface.
