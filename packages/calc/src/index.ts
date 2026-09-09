/**
 * ShopQuote costing engine.
 *
 * Pure by construction: this package takes a `ShopConfig` (every rate and
 * table a shop can differ on) plus a `QuoteInput`, and returns a `QuoteResult`.
 * No I/O, no database, no clock, no logging, and no runtime dependencies.
 * Everything that varies between shops is data, not code.
 *
 * The engine's definition of correct is `test/golden.test.ts`, which prices the
 * REQUIREMENTS §9 part and must reproduce the shop's workbook to the cent.
 *
 * Modules land here from BUILD-PLAN Task 1.2 onward:
 *   material.ts  nesting, blank cost, minimum charge      §5.1
 *   laser.ts     feature list -> cut inches -> hours/100  §5.2
 *   punch.ts     hit counter -> hours/100                 §5.3
 *   operations.ts setup and direct labour                 §5.4
 *   finish.ts    plating, coating, silkscreen             §5.5
 *   rollup.ts    cost stack per quantity break            §5.6
 */

/**
 * Shape version for `ShopConfig` and the seed JSON it is assembled from.
 * Bumped when a config written by an older build would no longer load.
 * REQUIREMENTS §8 pins the exported config to `schemaVersion: 1`.
 */
export const CALC_SCHEMA_VERSION = 1;
