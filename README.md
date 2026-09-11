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

## The API

`apps/api` (Fastify) serves everything under `/api`. Every error is `application/problem+json` (RFC 9457), with JSON Pointers to the fields at fault. First run against a fresh database:

```bash
npm run db:migrate && npm run db:seed      # prints the admin's one-time password
npm run build && npm start -w apps/api     # http://127.0.0.1:3000
```

The seeded admin has to choose a password of their own before the server will do anything else for them:

```bash
curl -c jar -H 'content-type: application/json' \
  -d '{"username":"admin","password":"<printed>"}' http://127.0.0.1:3000/api/auth/login
curl -b jar -X PUT -H 'content-type: application/json' \
  -d '{"currentPassword":"<printed>","newPassword":"four ordinary words here"}' \
  http://127.0.0.1:3000/api/auth/password
curl -b jar http://127.0.0.1:3000/api/config
```

| Route | Who |
|---|---|
| `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/auth/me` · `PUT /api/auth/password` | anyone · signed in |
| `GET /api/config` (optionally `?asOf=` a date — the prices in force then) | signed in |
| `PUT /api/config` — shop defaults, parity flags, cost modules | owner, admin |
| `GET /api/config/export` · `POST /api/config/import` (`?dryRun=true` to preview) | owner, admin |
| `/api/materials` `/api/operations` `/api/plating-specs` `/api/coating-models` `/api/silkscreen-tiers` `/api/assembly-standards` — GET, POST, `PUT /:id`, `DELETE /:id` (archives) | read: signed in · write: owner, admin |
| `GET /api/materials/:id/prices` · `POST /api/materials/:id/price` — a new price version, never an edit | read: signed in · write: owner, admin |
| `/api/users` — GET, POST, `PUT /:id`, `DELETE /:id`, `POST /:id/password` | admin |

Environment: `SHOPQUOTE_DB_PATH`; `SHOPQUOTE_SHOP_ID` (only when one database holds several shops); `SHOPQUOTE_COOKIE_SECURE` (true behind HTTPS, and the default when `NODE_ENV=production`); `SHOPQUOTE_TRUST_PROXY` (behind a reverse proxy, so the login throttle sees the client); `HOST` and `PORT`.

A database created before Task 3.1 needs `npm run db:migrate` once: migration `0001` makes names unique among live rows only, so an archived material no longer blocks its successor.

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
