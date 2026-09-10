/**
 * Shared bits of the three command-line entry points (`migrate`, `seed`,
 * `seed-blank`).
 *
 * Each of those exports a plain function that takes a database handle, so a
 * test can call it without a subprocess, and wraps it in a `main()` that only
 * runs when the file *is* the process's entry point. That is the split that
 * lets `db:seed` be both a command and a tested function.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * True when this module was started directly, rather than imported.
 *
 * `pathToFileURL`, not `new URL(argv[1], 'file://')`: on Windows `argv[1]` is
 * `D:\...`, and the URL parser reads `d:` as a scheme. `realpathSync` on top
 * because npm may invoke through a symlinked path.
 */
export function isEntryPoint(importMetaUrl: string): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  if (pathToFileURL(invoked).href === importMetaUrl) return true;
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}

/** Print a two-column summary — what was written, and how much of it. */
export function printCounts(counts: Record<string, number>, heading = 'table'): void {
  const width = Math.max(heading.length, ...Object.keys(counts).map((k) => k.length));
  console.log(`${heading.padEnd(width)}  ${'rows'.padStart(7)}`);
  console.log('-'.repeat(width + 9));
  for (const [table, n] of Object.entries(counts)) {
    console.log(`${table.padEnd(width)}  ${String(n).padStart(7)}`);
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log('-'.repeat(width + 9));
  console.log(`${'total'.padEnd(width)}  ${String(total).padStart(7)}`);
}

/** Report a failure the way a command should: the message, not a stack. */
export function fail(error: unknown): number {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  return 1;
}
