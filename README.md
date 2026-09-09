# ShopQuote

Internal quoting system for a sheet metal job shop. Replaces a 1998-era Excel estimator with something that keeps a quote log, re-prices when steel moves, and lets the owner change a rate without a developer.

The costing engine has one job: reproduce the shop's workbook to the cent. `packages/calc/test/golden.test.ts` is the definition of correct.

## Setup

Requires Node 22 or newer.

```bash
npm install
npm run typecheck
npm test
```

Then:

```bash
npm run dev          # api on :3000, web on :5173
```

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | API and web together |
| `npm test` | Vitest across every workspace |
| `npm run test:watch` | Same, watching |
| `npm run test:coverage` | Coverage; `packages/calc` is held to 95% |
| `npm run typecheck` | `tsc --noEmit` in every workspace |
| `npm run lint` | ESLint |
| `npm run format` | Prettier |
| `npm run build` | Build every workspace |

Single file or single test:

```bash
npm test -w packages/calc -- test/golden.test.ts
npm test -w packages/calc -- -t "min charge"
```

## Layout

```
packages/calc/   pure costing engine — zero runtime dependencies, no I/O, no clock
packages/db/     Drizzle schema, migrations, seed JSON, ShopConfig assembly
apps/api/        Fastify server; calc runs here so results are authoritative
apps/web/        Vite + React estimator
deploy/          docker-compose, Windows service, backup
scripts/         extract-workbook.py — regenerates seed data from the workbook
docs/            REQUIREMENTS.md (spec) · BUILD-PLAN.md (task list) · decisions.md
```

Dependencies point one way: `web → api → db → calc`, and calc depends on nothing. That is what makes deploying to a second shop a config change rather than a rewrite.

## Regenerating seed data

`packages/db/seed/*.json` and `packages/calc/test/fixtures/golden-workbook.json` are generated from `docs/reference/Quote_Metal_Cost.xls` and checked in. To regenerate after the workbook changes:

```bash
python -m pip install xlrd
npm run extract-workbook
```

It is idempotent, prints the six golden selling prices, and exits non-zero if any drifts past ±0.005.

## Where to start

`docs/BUILD-PLAN.md` is an ordered task list; each task assumes the previous one is green. `CLAUDE.md` carries the conventions and the current state of the build.
