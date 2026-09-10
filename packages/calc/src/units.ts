/**
 * Unit conversion for the *edges* of the system.
 *
 * CLAUDE.md is explicit that conversion happens in the UI and intake layers
 * and never inside calc: the engine is inches, pounds, dollars and hours all
 * the way through. These helpers live here so there is one implementation of
 * the constant rather than one per caller — calc itself never calls them.
 */

/** Inches in one millimetre. Exact by definition: 1 in = 25.4 mm. */
const MM_PER_IN = 25.4;

/** Millimetres to inches. For the intake and UI layers (§3, CLAUDE.md). */
export function mmToIn(mm: number): number {
  return mm / MM_PER_IN;
}

/** Inches to millimetres, for displaying a metric shop's numbers back. */
export function inToMm(inches: number): number {
  return inches * MM_PER_IN;
}
