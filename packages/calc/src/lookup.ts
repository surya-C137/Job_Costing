/**
 * Resolving ids into `ShopConfig` rows.
 *
 * Every module needs this and none of them should re-implement it, least of
 * all with a silent fallback: REQUIREMENTS §12 rule 3 says missing data
 * produces a visible warning, never a default. So these return `undefined`
 * and let the caller decide what to warn about.
 */

import type {
  Machine,
  MachineMaterialRate,
  MaterialRow,
  Operation,
  ShopConfig,
} from './types/config.js';

/** The stock item, or `undefined` when the id is not in this config. */
export function findMaterial(config: ShopConfig, materialId: string): MaterialRow | undefined {
  return config.materials.find((m) => m.id === materialId);
}

/** The work centre, or `undefined`. */
export function findMachine(config: ShopConfig, machineId: string): Machine | undefined {
  return config.machines.find((m) => m.id === machineId);
}

/** The catalog operation, or `undefined`. */
export function findOperation(config: ShopConfig, operationId: string): Operation | undefined {
  return config.operations.find((o) => o.id === operationId);
}

/**
 * What this machine achieves in this material (§3). Deliberately not defaulted:
 * a missing pairing means the owner has not told us how fast the machine cuts
 * that stock, and guessing would put a number on a quote that nobody chose.
 */
export function findMachineMaterialRate(
  config: ShopConfig,
  machineId: string,
  materialId: string,
): MachineMaterialRate | undefined {
  return config.machineMaterialRates.find(
    (r) => r.machineId === machineId && r.materialId === materialId,
  );
}

/**
 * The rate a piece of time is billed at: an operation's own rate when it has
 * one, otherwise its machine's, plus that machine's consumables (§3, §11.2).
 * `undefined` when neither supplies a rate.
 */
export function effectiveRatePerHrUsd(config: ShopConfig, operation: Operation): number | undefined {
  if (operation.ratePerHrUsd !== null) return operation.ratePerHrUsd;
  if (operation.machineId === null) return undefined;
  const machine = findMachine(config, operation.machineId);
  if (machine === undefined) return undefined;
  return machine.ratePerHrUsd + machine.consumablesPerHrUsd;
}
