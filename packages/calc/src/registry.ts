/**
 * The module registry — REQUIREMENTS §12 rule 5.
 *
 * A shop's `enabledModules` is a list of ids; this turns it into the
 * contributors the roll-up will sum. The roll-up therefore depends on the
 * `CostContributor` interface and on nothing else — it does not import
 * `material.ts`, does not know the word "laser", and does not grow a branch
 * when a shop takes up a process it has never seen.
 *
 * Registries are immutable. There is no mutable module-level map to pollute
 * between calls, because calc is pure: build a registry, hand it in, get the
 * same answer every time. A trade that needs different modules calls
 * `createRegistry()` with its own list rather than mutating a global.
 */

import { sheetMetalNestingContributor } from './material.js';
import type { ModuleId } from './types/config.js';
import type { CostContributor } from './types/contributor.js';

/** An immutable id → contributor lookup. */
export interface ContributorRegistry {
  /** The contributor with this id, or `undefined`. */
  get(id: ModuleId): CostContributor | undefined;
  /** Every id this registry knows, in registration order. */
  ids(): ModuleId[];
  /**
   * The contributors for a shop's enabled modules, in the order listed.
   *
   * `unknown` collects ids the shop has switched on that no build provides —
   * a config from a newer version, or a module that was renamed. The caller
   * warns about those rather than pricing as though the cost were zero
   * (§12 rule 3).
   */
  resolve(enabled: readonly ModuleId[]): {
    contributors: CostContributor[];
    unknown: ModuleId[];
  };
}

/**
 * Build a registry from a list of contributors.
 *
 * @throws if two contributors share an id — a programming error caught at
 * startup, not an expected condition, so this one really is a throw.
 */
export function createRegistry(contributors: readonly CostContributor[]): ContributorRegistry {
  const byId = new Map<ModuleId, CostContributor>();
  for (const contributor of contributors) {
    if (byId.has(contributor.id)) {
      throw new Error(`Duplicate cost contributor id: ${contributor.id}`);
    }
    byId.set(contributor.id, contributor);
  }

  return {
    get: (id) => byId.get(id),
    ids: () => [...byId.keys()],
    resolve: (enabled) => {
      const resolved: CostContributor[] = [];
      const unknown: ModuleId[] = [];
      for (const id of enabled) {
        const contributor = byId.get(id);
        if (contributor === undefined) unknown.push(id);
        else resolved.push(contributor);
      }
      return { contributors: resolved, unknown };
    },
  };
}

/**
 * The modules this build ships. Sheet metal is the first trade; the list grows
 * through Tasks 1.3 and 1.4 with `sheetMetal.laser`, `sheetMetal.punch`,
 * operations, finish, hardware and NRE.
 */
export const builtInContributors: readonly CostContributor[] = [sheetMetalNestingContributor];

/** The registry a shop gets unless it supplies its own. */
export const defaultRegistry: ContributorRegistry = createRegistry(builtInContributors);
