/**
 * ShopQuote costing engine.
 *
 * Pure by construction: this package takes a `ShopConfig` (every rate and
 * table a shop can differ on) plus a `QuoteInput`, and returns a `QuoteResult`.
 * No I/O, no database, no clock, no logging, and no runtime dependencies.
 * Everything that varies between shops is data, not code.
 *
 * The engine's definition of correct is `test/golden.test.ts`, which prices the
 * REQUIREMENTS §9 part and must reproduce the six selling prices to ±0.005,
 * the six material percentages to ±0.001, and five named intermediates. That
 * is the whole of the oracle: the workbook's own intermediate columns are not
 * a specification, and nothing here is shaped to match them.
 *
 * Modules land here from BUILD-PLAN Task 1.2 onward:
 *   material.ts   nesting, blank cost, minimum charge      §5.1  ✔ 1.2
 *   registry.ts   module id -> cost contributor            §12   ✔ 1.2
 *   laser.ts      feature list -> cut inches -> hrs/part    §5.2
 *   punch.ts      hit counter -> hrs/part                   §5.3
 *   operations.ts setup and direct labour                   §5.4
 *   finish.ts     plating, coating, silkscreen              §5.5
 *   rollup.ts     cost stack per quantity break             §5.6
 *   intake/       material and thickness resolvers          §8
 *   intake/dxf.ts flat-pattern geometry                     §11.4
 *
 * Two rules hold everything else up:
 *
 * **Code knows shapes, never instances** (§12). There is a `Machine` type and
 * no `Laser`; a `MaterialRow` and no `CRS16GA`. Adding a waterjet is a
 * Settings row plus the feature-based contributor that already exists.
 *
 * **Hours are stored per part.** "Hours per 100" is a display convention the
 * workbook uses and §11.4 keeps for the estimator's screen; the conversion
 * happens at the edge, never in here.
 *
 * Every parity flag needs both branches. §11.3 is explicit that turning one
 * off has to yield a defensible number rather than zero — so `finish.ts` will
 * own two coating models, and `operations.ts` reads `parity.machineTimeFactor`
 * where 0.6 is the workbook and 1.0 bills machine time as machine time.
 *
 * `intake/` takes parsed input, never raw files: `dxf-parser` and pdf.js live
 * in the caller, and the geometry and resolution live here. That is what keeps
 * the dependency count at zero.
 */

/**
 * Shape version for `ShopConfig` and the seed JSON it is assembled from.
 * Bumped when a config written by an older build would no longer load.
 * REQUIREMENTS §8 pins the exported config to `schemaVersion: 1`.
 */
export const CALC_SCHEMA_VERSION = 1;

export * from './types/index.js';
export * from './lookup.js';
export * from './material.js';
export * from './registry.js';
export * from './units.js';
