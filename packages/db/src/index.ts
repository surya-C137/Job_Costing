/**
 * ShopQuote persistence.
 *
 * Owns the Drizzle schema, migrations, the seed loader, and — the part that
 * matters to the engine — `loadShopConfig()`, which assembles a `ShopConfig`
 * for `@shopquote/calc` out of the catalog tables at a point in time.
 *
 * Direction of dependency is one-way: this package imports calc's types, calc
 * never imports this one.
 *
 * Arrives in BUILD-PLAN Tasks 2.1 and 2.2:
 *   schema.ts   tables, ULID keys, created/updated/archived      §3, §7
 *   migrate.ts  drizzle-kit migration runner
 *   seed.ts     loads seed/*.json into a fresh database
 *   config.ts   loadShopConfig(db, shopId, asOf?) / saveSnapshot()
 */

export { CALC_SCHEMA_VERSION } from '@shopquote/calc';
