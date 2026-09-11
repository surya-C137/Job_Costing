/**
 * ShopQuote persistence.
 *
 * Owns the Drizzle schema, migrations, the seed loaders, and — the part that
 * matters to the engine — the translation between stored rows and
 * `@shopquote/calc`'s `ShopConfig`.
 *
 * Direction of dependency is one-way: this package imports calc's types, calc
 * never imports this one. Calc does no I/O at all, so every file read in the
 * seed path happens here and hands calc parsed objects.
 *
 * The organising idea, stated once in `schema.ts` and worth repeating: the
 * catalog tables are the normalised form of `ShopConfig` and nothing more.
 * `writeShopConfig()` is one direction; `loadShopConfig()` is the other, and
 * the golden test runs through both. Every SQL statement the app runs lives in
 * this package; `apps/api` calls functions, it does not query tables.
 *
 *   schema.ts          tables, ULID keys, created/updated/archived   §3, §7  ✔ 2.1
 *   db.ts              connection, pragmas, migration runner                 ✔ 2.1
 *   migrate.ts         `npm run db:migrate`                                  ✔ 2.1
 *   seed-files.ts      seed/*.json -> SeedBundle, Zod-validated              ✔ 2.1
 *   columns.ts         entity -> columns, shared by both writers             ✔ 3.1
 *   write-config.ts    ShopConfig -> rows: a new shop, or replace one        ✔ 2.1 3.1
 *   seed.ts            `npm run db:seed`, the workbook shop                  ✔ 2.1
 *   seed-blank.ts      `npm run db:seed-blank`, a shop with no workbook      ✔ 2.1
 *   config.ts          rows -> ShopConfig, price history, snapshots  §7      ✔ 2.2
 *   config-schema.ts   Zod for ShopConfig, fields and cross-references §8    ✔ 3.1
 *   config-document.ts the config JSON: export and import         §4 FR-1   ✔ 3.1
 *   catalog.ts         Settings writes, one row at a time          §4 FR-1   ✔ 3.1
 *   users.ts           accounts, roles, password changes           §4 FR-6   ✔ 3.1
 *   sessions.ts        server-side sessions, 12 h                  §7        ✔ 3.1
 *   password.ts        argon2id; scrypt still verified             §4 FR-6   ✔ 3.1
 *   audit.ts           who changed what, in the same transaction   §4 FR-6   ✔ 3.1
 *   errors.ts          DataError: the expected refusals                      ✔ 3.1
 */

export { CALC_SCHEMA_VERSION } from '@shopquote/calc';

export * as schema from './schema.js';
export * from './audit.js';
export * from './catalog.js';
export * from './columns.js';
export * from './config.js';
export * from './config-document.js';
export * from './config-schema.js';
export * from './db.js';
export * from './errors.js';
export * from './migrate.js';
export * from './password.js';
export * from './paths.js';
export * from './seed.js';
export * from './seed-blank.js';
export * from './seed-files.js';
export * from './sessions.js';
export * from './users.js';
export * from './write-config.js';
export { REFERENCE_FAMILIES, referenceFamilies, referenceGauges } from './reference/gauges.js';
