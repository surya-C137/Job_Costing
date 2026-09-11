# Decisions

Choices made where the spec was silent. Newest first. Format: date · decision · why · alternatives.

---

## 2026-09-10 — Task 3.1, server, auth and config endpoints

`apps/api` serves sign-in and accounts, the whole config (read, the shop page,
export, import) and six catalogs a row at a time, all problem+json on failure.
`test/config.test.ts` fetches the config over HTTP and prices §9 from it to the
cent, so nothing is lost to JSON between the database and the wire.

### Authentication

**argon2id, from the `argon2` package — and so the seeders are now async.**
The PHC dispatch Task 2.1 built is kept exactly: `verifyPassword()` reads the
algorithm out of the stored string, a `$scrypt$` row still verifies, nothing
writes scrypt any more, and a successful login re-hashes whatever
`needsRehash()` flags. No row is migrated in bulk. Parameters are RFC 9106's
second recommended set (64 MiB, t=3, p=4). *Alternatives:* Node's own
`crypto.argon2()` (arrived in 24.7 as experimental, and `engines` still admits
22); `@node-rs/argon2` (sync and async both, but it ships each platform's
binary as an optional dependency, and a lockfile written on a Windows box has
been known to drop the Linux one before a Docker build — Task 5.1's exact
path). The `argon2` package bundles every platform's prebuilt binary in one
tarball. Its API is async only, which made `seedWorkbookShop()`,
`seedBlankShop()` and both seed commands async; thirteen test call sites
changed with them. The seeders also now write the shop and its first admin in
one transaction, where Task 2.1 wrote them as two.

**The cookie carries a token; the table stores its SHA-256.** A copy of the
database — which is what the nightly backup makes — holds no usable session.
256 random bits, so an unsalted hash is enough. Sessions last twelve hours
from sign-in, not from last activity: §7's "expire in 12 h" read plainly, and a
sliding window would keep a browser left open on the shop floor signed in
indefinitely.

**Closed by default, and the bootstrap password is enforced by the server.**
A route with no `access` in its config needs a signed-in user; it must say
`public` to be open. A user whose password someone else set — the seed's
admin, an admin's reset — reaches only who-am-I, change-password and sign-out
until they choose their own. `mustChangePassword` existed since Task 2.1 and
nothing enforced it. The consequence for BUILD-PLAN 3.1's acceptance check is
one step: login, `PUT /api/auth/password`, then `GET /api/config`.

**The login throttle counts failures, not requests.** Five per address and
username in fifteen minutes, twenty per address. No limit on a username alone:
on a shop LAN that would let anyone lock the owner out by mistyping the owner's
name five times. An unknown username is verified against a decoy argon2id hash
so it costs what a wrong password does. Kept in memory; a restart clears it.
*Alternative:* `@fastify/rate-limit` (counts every request, so an estimator
signing in and out through the day is throttled like a guesser).

**Passwords: fifteen characters, no composition rules** (NIST SP 800-63B-4 for
a single factor). A few ordinary words is easier on a shop-floor keyboard than
`Tr0ub4dor&3` and stronger. The policy applies to passwords a person chooses
through the API; a seed's bootstrap password is exempt because it has to be
replaced at first sign-in. Not done: the blocklist of common passwords 800-63B
also asks for. *Alternatives:* 12, or NIST's 8 (the floor only when there is a
second factor, which there is not).

**CSRF is SameSite=Strict plus JSON-only bodies.** Fastify parses `text/plain`
by default, and that is one of the bodies a cross-site HTML form can send, so
the parser is removed: a write needs a JSON body no form can produce.

**Usernames are stored lowercase.** "Admin" at the login box is the admin; the
unique index cannot then hold two spellings of one person.

**Accounts are admin-only, and got routes although BUILD-PLAN 3.1 does not list
them.** FR-6 is on 3.1's reading list and says "password reset by admin"; without
`/api/users` the estimator's account could only come from the seed. A shop
cannot lose its last admin, and nobody removes themselves.

**Cookie `Secure` defaults on when `NODE_ENV=production`,** with
`SHOPQUOTE_COOKIE_SECURE` to override either way, so plain-HTTP development
works and Task 5.1's Caddy deployment does not have to remember.
`SHOPQUOTE_TRUST_PROXY` makes the throttle see the client behind that proxy.

### The config

**`PUT /api/config` takes the shop page, not the catalogs.** BUILD-PLAN writes
"GET/PUT /api/config (full config)". The full config is what GET returns; a PUT
of all of it from a Settings tab opened an hour earlier would archive every
material another tab had added since. Catalogs change a row at a time through
their own routes, and replacing them all is an import — explicit, with a dry
run.

**Import makes the shop's catalog equal the file, matching rows on id.** A row
the file names is updated in place (and un-archived); an id the shop has never
seen becomes a new row; a live row the file leaves out is archived. So a shop's
own export imports as zero changes, a restore brings rows back under their old
ids, and open quotes keep pointing at live materials. It lives inside
`writeShopConfig()` as `replace: true`, because creating a shop is the same walk
over an empty one — the Task 2.1/2.2 round-trip tests now exercise the import
path too. *Alternatives:* archive everything and insert fresh (every open
quote's parts would then reference archived rows, and "re-price with current
rates" would fail on all of them); import only into an empty shop (useless in a
running app, which always has one).

**The file carries every price version.** A `ShopConfig` holds only the price
in force; BUILD-PLAN 4.2's acceptance check wants both versions in the export.
So the file is `{format: "shopquote.config", schemaVersion: 1, exportedAt,
config, priceHistory}` (REQUIREMENTS §8). A file whose config prices disagree
with its history as of `exportedAt` is refused and the row named — either
silent choice would throw away something the owner wrote. A hand-written file
may omit both history and timestamp; its prices become versions dated at
import, and only where they differ from what is in force.

**The Zod schema checks across rows, not only fields.** Ids unique across the
config, every reference resolving inside it, names unique wherever the database
holds them so — a file that would fail half-way through a write fails up front
with the path of the row. Field bounds are physics, not policy: nothing
negative, no zero where calc divides. One exception: the Q2 factor is capped at
5, because the likeliest mistake with a field the workbook displays as "×60" is
typing 60, which bills machine time a hundredfold. Module ids this build does
not ship are refused (§12 rule 3).

### Schema

**Uniqueness holds among live rows (migration `0001`).** Every unique index on a
soft-deletable table is now partial, `WHERE archived_at IS NULL`. This was a
latent defect from Task 2.1: archive "CRS 16 GA" and no material could ever be
called that again, and an import could not archive the old catalog and write
the new one beside it. Quote numbers stay unique outright — they are never
reused. The migration touches indexes only; an existing `data/shopquote.db`
needs `npm run db:migrate`.

**Archiving takes the rows that mean nothing alone.** A material's machine
rates and stock sizes and its aliases go with it, freeing the name and the
aliases at once. `loadShopConfig()` also drops gauges, stock sizes and rates
whose parent is archived, so an export can never mention something it does not
contain.

### Structure

**Every SQL statement stays in `packages/db`.** `catalog.ts` (Settings writes),
`users.ts`, `sessions.ts`, `audit.ts`, `config-document.ts`. The API validates,
authorises and calls functions; its reads go through `loadShopConfig()`, so a
list shows exactly what the engine would price with. Entity-to-column mapping
is `columns.ts`, shared by the whole-config writer and the one-row writer, so a
field added to `MaterialRow` is stored the same way by both.

**The audit row is written inside the data layer's transaction,** by the
function making the change, with a one-line summary of what moved
(`defaults.laborMarkup 1.2 → 1.25`). An audit call in a route handler is one the
next route forgets.

**Catalog paths are the `ShopConfig` keys in kebab case** — `/api/plating-specs`,
`/api/coating-models`, `/api/silkscreen-tiers`, `/api/assembly-standards` —
where BUILD-PLAN names them loosely. DELETE archives (§7); there is no restore
route yet, because an import restores.

**Not yet routed:** machines, families, gauges, stock sizes, machine × material
rates, aliases. BUILD-PLAN 3.1 does not list them and Task 4.2's Settings needs
them; each is one `Resource` entry in `catalog.ts` and one `register()` call.
Until then import covers them.

**`npm run dev -w apps/api` builds, then watches.** It ran `node
--experimental-strip-types src/index.ts`, which cannot resolve the `.js`
specifiers NodeNext requires — the same trap as the db scripts (Task 2.1).

Dependencies added: `argon2` (packages/db), `@fastify/cookie` (apps/api).
`npm audit --omit=dev` is clean.

---

## 2026-09-10 — Task 2.2, config assembly and quote snapshots

The golden case prices through the database: `packages/db/test/golden.test.ts`
seeds a shop, loads the config back out and reproduces §9's six selling prices,
six material percentages and the intermediates that survive a round trip.

**The round trip is asserted directly, not just implied by the prices.**
`config.test.ts` builds the same `ShopConfig` two ways — `shopConfigFromSeed()`
in memory, and seed-then-`loadShopConfig()` — canonicalises both by replacing
ids with names, and compares them entity for entity. That is the test that
would catch a field quietly dropped on the way in or out; the golden test only
exercises the handful of rows the §9 part touches, and a catalog can be wrong
in 79 materials while pricing the eightieth perfectly. Both seeders are covered,
because the blank shop is the only one with gauge rows and aliases in it.

**Ids can never round-trip, so names are what the comparison uses.** §7 issues
ULIDs on the way in. Names are what the estimator picks by and what an exported
config JSON identifies a row by, so a rename showing up as a difference is
correct rather than noise. The same reasoning decides the test's one other
tolerance: alias arrays are sorted before comparing, because an alias list is a
set and `loadShopConfig()` returns it sorted, while a hand-written config
declares it in whatever order read best.

**`asOf` is the whole point of versioned prices.** `loadShopConfig(db, shopId)`
gives today's rates; `loadShopConfig(db, shopId, quote.quoteDate)` gives the
ones a quote was written against. A same-day tie — the owner fat-fingers a price
and re-enters it that afternoon — breaks on the row written last. A material
with no version on or before `asOf` comes back with `pricePerLbUsd: null`, which
is the same null the seed writes for stock that was never priced, and the
material module warns rather than costing it (§12 rule 3).

**Archived is invisible; inactive is not.** Soft delete (§7) means a removed
row still exists for the quotes that used it, so `loadShopConfig()` filters
`archived_at` everywhere — but `active: false` travels through, because an
inactive material is still quotable with an amber note (`material-inactive`),
which is a different thing from a deleted one.

**A model group is configured or it is not.** The coating `legacy_*` and
`modern_*` column groups come back as `null` unless every column in the group is
set. A half-filled group would price off whichever constants happened to be
there, which is precisely the `else → 0` hole §11.3 forbids for a parity flag's
off-path. Two tests pin it: the modern parameters survive the round trip once an
owner enters them, and a lone specific gravity leaves the model unconfigured.

**Snapshots: one config row per distinct config, referenced by hash.**
`saveSnapshot()` writes the version, the input and the result every time, but
stores the `ShopConfig` once per distinct config — `canonicalJson()` sorts object
keys (arrays keep their order; order in an array is data), SHA-256 addresses it.
Twenty autosaves against untouched Settings write twenty versions and one
snapshot row; changing a rate writes the next. The arithmetic behind that is in
the Task 2.1 entry. Whole thing is one transaction, so a version can never point
at a snapshot that is not there and `quotes.current_version_no` can never
disagree with the versions that exist.

**`loadSnapshot()` was not in the task, and a snapshot you cannot read is not a
snapshot.** Fifteen lines, and it is what makes §7's "re-pricing is explicit"
testable rather than a sentence: the test reopens a version priced at a 1.2
material markup after Settings has moved to 1.6 and gets the old price back.

**`loadShopConfig` takes the Drizzle handle, `saveSnapshot` takes ours.**
BUILD-PLAN 2.2 writes `loadShopConfig(db, ...)`, and reading really does need
nothing more — which also means it works unchanged inside a transaction. Saving
needs the raw connection to open one, so it takes the `DatabaseHandle`.

---

## 2026-09-10 — Task 2.1, schema, migrations and the two seed loaders

`npm run db:migrate && npm run db:seed` produces `data/shopquote.db` with 80
materials, 20 operations and 25 tables. `db:seed-blank` produces the same
database with gauge tables and nothing else.

### The organising decision

**The catalog tables are the normalised form of `ShopConfig`, and nothing
more.** Everything from `shops` down to `assembly_standards` exists because a
field of `ShopConfig` needs somewhere to live. The consequence is that the seed
does *not* map seed JSON to SQL: it reads the files, calls calc's
`shopConfigFromSeed()` — the same call the golden test makes with no database
in sight — and then `writeShopConfig()` turns that config into rows. So there
is one mapping from the workbook's shape to the app's rather than two, and
Task 2.2's `loadShopConfig()` is simply this function's inverse, which is what
makes "seed it, load it back, price §9 through it" a test rather than a hope.
*Alternative:* a direct seed-JSON-to-SQL loader (rejected — it is the obvious
shape and it silently breaks the guarantee that the database holds what the
golden test proves).

The same rule decides what is *not* stored. `coating.json`'s adders (plugs and
caps, mask time, parts per hook) and `blank_multiples.json`'s standard blank
lengths have no `ShopConfig` field yet, so they get no table yet: a table
nothing writes back into a config cannot take part in the round trip and would
rot. They stay in the seed files, and land when §5.5's full coating model and
§5.1's length picker reach the types.

### Schema shape

**A part's repeating structures are JSON columns; its identity is columns.**
`part_number`, `rev`, `material_id`, `flat_length_in` and the rest are real
columns because the quote log, part search and a later material-usage report
filter on them. The cut-feature list, operation lines, finish selections,
hardware and NRE are JSON typed to `PartInput`'s own members. Normalising those
would be five more tables, a mapping layer to keep in step with `PartInput`, and
a migration every time the engine learns a new feature shape — and nothing
queries across them; no screen asks which parts have more than four bends. Zod
validates the JSON at the API boundary in Phase 3, against `PartInput` itself.
*Alternative:* full normalisation (rejected on the above); a single JSON blob
per part (rejected — the quote log needs SQL).

**One table beyond BUILD-PLAN's list: `config_snapshots`, content-addressed.**
§4 FR-2 makes every autosave a version and §7 makes every version carry the
config it was priced with, but a `ShopConfig` with this catalog in it is ~100 KB
of JSON. One copy per version is tens of megabytes a day into a file whose
backup story is "copy it", and every copy identical — Settings changes a few
times a year, autosave fires every few seconds. So the snapshot is stored once
per distinct config, keyed by a SHA-256 of it, and `quote_versions` points at
it. A day of editing shares one row; re-pricing after a rate change writes one
more. *Alternative:* the config JSON on `quote_versions` (rejected on the
arithmetic); storing only a diff (rejected — reconstructing a config to price
against is exactly where you do not want cleverness).

**Ids are re-issued as ULIDs and the old id becomes `source_key`.** §7 says
stored ids are ULIDs; the seed's are slugs (`material:g30-16-ga-0598`).
`writeShopConfig()` issues a ULID per entity, keeps the config id in
`source_key` for provenance, and returns the map so anything following a
reference can translate. Nothing joins on `source_key`; an owner-created row
leaves it null.

**`material_prices` carries `sheet_cost_usd` and `sheet_lbs`.** They are how the
owner arrives at a $/lb — what a sheet cost and what it weighed (§11.2's $/cwt
entry) — so they are provenance *for that price version*, not a property of the
material. They move with the price.

**Timestamps are epoch milliseconds; `archived_at` only where soft delete means
something.** Sessions expire; `quote_versions`, `config_snapshots` and
`audit_log` are append-only history. Everything the owner can remove is
soft-deleted per §7.

**`operations` has no unique index on the name.** The workbook carries
"BRAKE, BEND" twice, at 222/hr and 330/hr, and both are real standards the
estimator picks between. Materials, machines, families, plating specs, coating
models and silkscreen tiers do carry one — a duplicate there is a data problem
the owner should see.

**Machines keep the seed's names, "Laser" and "Punch".** BUILD-PLAN 2.1 says
"Laser 1" and "Punch 1"; renaming them in the DB layer would make the database
disagree with `shopConfigFromSeed()` and break 2.2's round trip for the sake of
a suffix the owner renames on day one anyway.

### What the boundary check found

**`MaterialRow.pricePerLbUsd` is now `number | null`, and this was a live bug.**
Adding Zod to the seed loader (CLAUDE.md: at every boundary) immediately failed
on `price_per_lb: null` — fourteen brushed-stainless rows the workbook never
priced. calc's `SeedMaterial` declared it `number`, so `shopConfigFromSeed()`
has been putting a runtime `null` typed as `number` into those materials since
Task 1.4, and any arithmetic on them would have produced `NaN`. The type is now
honest, `materialParamsFor()` returns a typed `missing-material-price` failure,
and the contributor turns it into a named amber warning at $0 — §12 rule 3, and
the alternative is quoting a job as though the steel were free. The seed writes
no price row for those materials rather than a zero. Two warning codes came with
it: `missing-material-price` and `unknown-reference` (the contributor had been
reporting every resolution failure as `part-does-not-fit`, which was already
wrong for an unknown material and would have been worse for this).

**The extractor was emitting duplicate assembly-standard keys.** Five actions
appear more than once on the `Assy-Handling` sheet — INSTALL POP RIVETS under
both HARDWARE and RIVETING, ATTACH SPRING twice under LATCH ASSEMBLY/S — and
`slug(label)` collapsed them into one key, which is a duplicate
`AssemblyStandard.id` the moment calc builds a config. The sheet is a worksheet,
not a catalog: those are one standard each, listed twice so the estimator has
two slots to count into. `extract_assembly()` now keys on section + action and
collapses an identical repeat, keeping both only when the times differ — the
same treatment `extract_operations()` already gave duplicate names. 38 rows
became 34, no §9 number moved, and the run prints what it collapsed.
`writeShopConfig()` also now throws on a duplicate id rather than absorbing it.

### Things that are only true on Windows

**`db:migrate` and `db:seed` run the built output, not `node
--experimental-strip-types`.** The scaffold's scripts assumed Node could run
`src/*.ts` directly. It can strip types, but it does not resolve `./schema.js`
to `schema.ts`, and NodeNext + `verbatimModuleSyntax` requires that `.js`
extension. So each script is `npm run build && node dist/x.js`. *Alternative:*
`tsx` (a dependency for something `tsc` already does); rewriting the imports to
`.ts` (breaks the emitted build).

**The root `db:*` scripts call `node` directly rather than a second `npm run`.**
Two levels of npm mangle `-- --shop-name "Two Words"` on Windows into
caret-escaped nonsense; one level is fine. Both seeders also accept
`SHOPQUOTE_SHOP_NAME`, which is the reliable route on a Windows Server box and
consistent with how the admin credentials arrive.

**`drizzle-orm` is a root devDependency as well as `packages/db`'s
dependency.** drizzle-kit resolves `drizzle-orm/version` from its own location
in the hoisted root `node_modules`, and npm deterministically nests the
workspace copy under `packages/db/node_modules` where the generator cannot see
it — `drizzle-kit generate` fails with "Please install latest version of
drizzle-orm". Both are pinned to the same range and the lockfile holds them to
one version. *Alternative:* hand-writing the migration SQL (fragile, and the
snapshot in `drizzle/meta` has to match it exactly).

### Passwords, seeded shops, and gauge tables

**Password hashing is scrypt inside a PHC string, with argon2 still the plan.**
BUILD-PLAN 3.1 names argon2 and that has not changed. What Task 2.1 needs is a
*stored format*, and one that cannot accept argon2 later means re-hashing every
password in a migration. So the stored value is
`$scrypt$n=16384,r=8,p=1$salt$hash`, `verifyPassword()` dispatches on the
algorithm named inside it, and 3.1 adds an `$argon2id$` branch that re-hashes on
the next successful login. scrypt in the meantime is Node's own — no native
module on a Windows box — and memory-hard. `needsRehash()` is already there.

**The seed refuses a database that already holds a shop.** The schema is
multi-shop (§12 rule 4) so a second shop is a real thing to want, but on a v1
deployment it is almost always a re-run of the command, and a silently doubled
catalog is very hard to spot. `--force` says you meant it.

**Seeded prices are dated 2023-01-01, not today.** §6 says the workbook's prices
are 2023-era. §7's versioned prices exist so `loadShopConfig(asOf)` can answer
what a material cost on the day a quote was priced; stamping the seed "now"
makes every historical answer wrong, and it hides the fact that the first thing
the owner does is update them. The seed prints how many of the 80 materials
actually carry a price.

**Gauge tables are hand-authored in `src/reference/gauges.ts`, not in `seed/`.**
`seed/` is extractor output and gets overwritten; MSG, galvanised, US Standard
and Brown & Sharpe come from the trade. Two conventions in there look like
errors and are not: steel and galvanised rows carry the standard's *book weight*
as `lbPerSqFtOverride` rather than thickness × density (MSG defines 16 ga as
2.5 lb/ft²; mild steel at 0.2836 lb/in³ would say 2.44 — and the workbook's own
four gauges agree with the book), and a galvanised row pairs the *base*
thickness with the *coated* weight, which is what the workbook's G30 16 GA
(.0598) at 2.656 lb/ft² does and what a drawing calling out 16 ga galvanised
means. One deliberate divergence: the stainless table is US Standard Gauge
(16 ga = 0.0625), where this shop's catalog reads stainless on the steel table
(.0598). The reference table is only ever a starting point for a shop that does
not have this workbook.

**A blank shop starts at markup 1.0 with a 0-inch minimum strip and all four
parity flags off.** "Not set yet" as arithmetic that changes nothing, rather
than this shop's 1.2 and 12 inches wearing another shop's name — and a quote
priced at markup 1.0 is visibly priced at cost. The parity flags exist to
reproduce one 1998 workbook; a shop that never had it should not inherit its
quirks (Phase 6 says the same).

**Zod is a `packages/db` dependency now**, at the same range `apps/api` already
declares. Its schemas mirror calc's `Seed*` interfaces rather than replacing
them — calc owns the shape because calc owns the mapping — and
`readSeedBundle()`'s return type is annotated `SeedBundle`, so the type checker
fails the build if the two drift.

---

## 2026-09-10 — Task 1.5, parity flags off, and the report

`docs/parity-report.md` exists, generated rather than written, and every delta
in it is pinned by a test.

**Quirk Q4 was a flag that did nothing, and Task 1.5 is what caught it.**
`finishesUnmarked` was declared on the coating and silkscreen contributors as
`markupClass: 'none'` and read by nobody — switching it off produced identical
prices to switching it on. That is precisely the failure §11.3 names, shipped
in the Task 1.4 commit and found the moment something actually toggled the
flag. The fix puts Q4 in `rollup.ts`, which is where §5.6 puts it: the quirk is
not about what coating *costs*, it is about where coating sits in the
arithmetic. With the flag off, coating and silkscreen take the material markup
alongside plating — the other bought finishing service already in that block.
*Alternative:* the labor block (rejected — plating is the closest analogue and
it is material-side; a shop that disagrees is changing pricing, which is an
owner decision, not a default).

There is a lesson worth keeping: a parity flag that no test toggles is
indistinguishable from a comment. Task 1.5's tests now assert, for all four,
that switching the flag *moves the price* — not merely that it moves it to the
right number.

**The report is generated, not typed.** `scripts/parity-report.mjs` imports the
built package, prices the §9 part five ways and writes the markdown;
`npm run parity-report` regenerates it. Hand-maintaining a table of prices
beside an engine that computes them is how the two end up disagreeing on the
day the owner reads it. It imports `dist` rather than `src` deliberately — what
it reports should be what the app would quote.

**Q3's "off" number rests on assumed powder parameters, and says so.**
The workbook has no source for specific gravity, film build, transfer
efficiency or powder price — that is the whole of §10 question 2 — so the Q3
row uses trade-typical placeholders (SG 1.5, 2 mils, 60%, $5/lb) and the report
carries a table naming each one and where a real value comes from. Without
them, Q3-off would price coating at zero, which is the hole §11.3 forbids; with
them, the row is a real number that will move once the owner answers. The test
asserts both: the number, and that an unspecified powder produces a *warning*
rather than a zero.

**The golden part is coated on both faces.** The legacy model prices off the
perimeter and ignores sides, so this changes no §9 number; the modern model
prices off area, where it doubles the coating. Two faces is what actually
happens to a powder-coated sheet metal part, so both the golden test and the
report now say so.

**What the deltas came out as.** Q1 is the only flag that touches one quantity
alone: −$2.07 at qty 1 and nothing above it, because above one the nest beats
the minimum charge. Q2 is +$0.25 flat, the labour markup on the 0.4× of laser
time the workbook forgives. Q3 is −$0.77 flat. Q4 is +$0.21 flat, the material
markup on the coating. Each is one sentence in the report, which is BUILD-PLAN
1.5's acceptance check.

**The second fixture is blocked, not skipped.** `docs/discovery/quote-2.xlsx`
does not exist; BUILD-PLAN 0.1 asks the shop for ten recent quotes and this is
the first of them. Left as `it.todo` with a note on what the second case most
needs to cover: a punched part, plating, hardware and NRE. The §9 case
exercises none of those, and the punch model has no oracle whatever (see the
Task 1.3 entry) — it is the largest untested surface in the engine.

**ESLint now knows `scripts/**` is Node.** The new `.mjs` script tripped
`no-undef` on `console`. Declared the four globals in the existing scripts
override rather than adding the `globals` package.

---

## 2026-09-10 — Task 1.4, operations, finish, roll-up, and the golden test

The golden test is green: six selling prices within ±0.005, six material
percentages within ±0.001, five intermediates, built from `packages/db/seed/*`
rather than a hand-made fixture.

### Formulas checked against current practice, not just against the workbook

**Powder coating coverage is a standard formula, and the workbook hides it.**
The trade computes `coverage ft²/lb = 192.3 ÷ specific gravity ÷ film mils ×
transfer efficiency` — 192.3 ft² being one pound of a specific-gravity-1.0
powder at one mil with perfect transfer. §11.3's modern model originally stored
a single opaque `coverageSqFtPerLb`, which hides all three of the numbers an
owner actually has: the data sheet gives specific gravity, the finish spec gives
film build, and the booth gives transfer efficiency (50–80% first-pass, higher
with reclaim). `CoatingModel.modern` now stores the three inputs and derives
coverage. *Alternative:* keep one coverage number and let the owner do the
arithmetic (rejected — it puts a formula in a spreadsheet next to the app, which
is how this project started).

**Markup is a multiplier, not a margin, and the UI has to say so.**
`materialMarkup: 1.2` is a 20% markup, which is a 16.7% *margin*. Those get
confused constantly, and a shop aiming at a 35% margin needs a 1.54 multiplier.
The engine is unchanged — ×1.2 is what reproduces §9 — but Task 4.2's Settings
screen should label the field "markup ×" and show the resulting margin beside
it. Also worth knowing when the owner refreshes the seed: 10–15% is the more
common material markup now, against the workbook's 20%.

**The plating rate is a footprint rate, and "fixing" it would double the price.**
§5.5 charges `$/in² × blank_area`, i.e. one face, where plating houses quote on
exposed surface area — both faces — at roughly $0.75–$3.50/ft² with a $50–$400
lot minimum. The workbook's $0.05/in² is $7.20/ft² of footprint, which is
$3.60/ft² of actual two-sided area and lands in the upper part of that range.
The rate already has both sides in it. Left alone deliberately, and the reasoning
is now in §11.3 so nobody "corrects" it later. The seeded $125 lot minimums are
in range too, and the three-way `MAX(lot ÷ qty, per-area, part min)` is exactly
how the trade quotes.

### Decisions

**NRE is marked up twice, because §5.6 says so.** The section puts NRE inside
`fixed_cost`, and `fixed_cost` takes the labor markup — so 1.3 × 1.2 = 1.56.
The golden case has no NRE, so the oracle cannot settle it either way.
Reproduced as written on the same grounds as Q1 and Q2, flagged loudly in
`nre.ts`, and raised as REQUIREMENTS §10 question 11. If the owner says once,
deleting `× nreMarkup` is the whole fix. *Alternative:* silently mark once
(rejected — it is a pricing change the owner has not approved, which CLAUDE.md
puts on the ask-first list).

**Buckets map one-to-one onto cost-stack lines.** `CostBucket` was
`material | labor | fixed | finish | hardware | nre`, which could not place a
contributor: "finish" covers plating (material block, marked) and coating
(unmarked), and they land on different lines. Now one bucket per `CostStack`
field, with `MarkupClass` carrying the arithmetic. Placing a contributor is a
lookup rather than a decision, and a new bucket cannot be added without deciding
where the estimator sees it.

**Cutting time is charged once, to the operation that runs the cutting machine.**
A part can carry several machine operations; only the one whose `machineId`
matches the part's nesting machine gets the §5.2/§5.3 hours. Without that, a
part routed across a laser and a punch would be billed the laser's time twice.

**`shopConfigFromSeed()` lives in calc, not in `@shopquote/db`.**
Two callers need the same mapping — Task 1.4's golden test, which runs with no
database, and Task 2.1's `seed.ts`, which loads the same files into SQLite. If
they each had their own, they would drift and the golden test would stop saying
anything about what the database holds. Purity is intact: the caller reads the
files and hands over parsed objects, the same split `intake/` uses.

**The §5.2 timing constants are extracted, not typed.** `intersection_s` 0.3,
`rapid_s_per_pierce` 0.6, `pallet_batch_parts` 100 and `loss_factor` 1.08 are
solved out of the LASER WORKSHEET (`F31 × 3600 / F30`, and so on) and seeded on
the machine row. The alternative was hardcoding them in calc, which §12 rule 1
forbids and §5.2 explicitly calls out. They come from a single saved quote that
ran one pierce and one intersection, so they reproduce §9 exactly but are not
independently confirmed — noted in `docs/discovery.md` for the Task 5.2 pilot.

**Two `PartInput` fields §5.6 names but §3 did not.** `materialExtrasUsd`
(freight-in, cut-to-size) and `setupExtraLaborUsd` (fixturing, first article).
Both optional, both zero in the golden case.

**Coverage excludes nothing new.** `packages/calc/src` measures 99.9%
statements, 97.8% branches, 100% functions. The branch gap that remained after
the behavioural tests was `seed.ts`'s null-handling, so it is covered by a
sparse-bundle test rather than by an exclusion — that bundle is what a shop
onboarding without a workbook actually supplies, which Task 2.1's
`seed-blank.ts` will need anyway.

**A test tried to pin a workbook cell and the type checker caught it.**
`finish.test.ts` reached for `golden.coating.cost_per_part`, which the course
correction deleted from the fixture as a loaded-quote output. Both coating
assertions now derive $1.0619 from the seeded constants and the part's own
perimeter — a hand-derived case, which §9 allows, rather than a cell read.

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
