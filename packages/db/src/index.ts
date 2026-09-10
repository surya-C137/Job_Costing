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
 * `writeShopConfig()` is one direction; Task 2.2's `loadShopConfig()` is the
 * other, and the golden test runs through both.
 *
 *   schema.ts       tables, ULID keys, created/updated/archived   §3, §7  ✔ 2.1
 *   db.ts           connection, pragmas, migration runner                 ✔ 2.1
 *   migrate.ts      `npm run db:migrate`                                  ✔ 2.1
 *   seed-files.ts   seed/*.json -> SeedBundle, Zod-validated              ✔ 2.1
 *   write-config.ts ShopConfig -> rows                                    ✔ 2.1
 *   seed.ts         `npm run db:seed`, the workbook shop                  ✔ 2.1
 *   seed-blank.ts   `npm run db:seed-blank`, a shop with no workbook      ✔ 2.1
 *   password.ts     PHC-format password hashing                  §4 FR-6  ✔ 2.1
 *   config.ts       rows -> ShopConfig, and quote snapshots        §7     ✔ 2.2
 */

export { CALC_SCHEMA_VERSION } from '@shopquote/calc';

export * as schema from './schema.js';
export * from './config.js';
export * from './db.js';
export * from './migrate.js';
export * from './password.js';
export * from './paths.js';
export * from './seed.js';
export * from './seed-blank.js';
export * from './seed-files.js';
export * from './write-config.js';
export { REFERENCE_FAMILIES, referenceFamilies, referenceGauges } from './reference/gauges.js';
