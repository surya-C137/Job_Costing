import type { ShopConfig } from '@shopquote/calc';

import { canonicalJson } from '../../src/config.js';

/**
 * A `ShopConfig` with every id replaced by something stable across a round
 * trip, and every list in a fixed order.
 *
 * §7 re-issues ids as ULIDs on the way into the database, so a config that came
 * back out can never be `toEqual` one that went in. Names are what an estimator
 * and an exported config JSON identify a row by, so names are what this
 * compares — which also means a rename would show up as a difference, correctly.
 *
 * Shared by the seed round trip (`config.test.ts`) and the import round trip
 * (`import.test.ts`): the same comparison, so "comes back the same" means the
 * same thing in both.
 */
export function canonicalise(config: ShopConfig): unknown {
  const names = new Map<string, string>();
  for (const f of config.families) names.set(f.id, `family:${f.name}`);
  for (const m of config.materials) names.set(m.id, `material:${m.name}`);
  for (const m of config.machines) names.set(m.id, `machine:${m.name}`);
  for (const m of config.machines) {
    for (const h of m.hitRates) names.set(h.id, `tool:${m.name}/${h.name}`);
  }
  for (const o of config.operations) names.set(o.id, `operation:${o.name}/${o.standardPerHr}`);
  for (const p of config.platingSpecs) names.set(p.id, `plating:${p.name}`);
  for (const c of config.coatingModels) names.set(c.id, `coating:${c.name}`);
  for (const s of config.silkscreenTiers) names.set(s.id, `silkscreen:${s.name}`);
  for (const a of config.assemblyStandards) names.set(a.id, `assembly:${a.section}/${a.action}`);

  const ref = (id: string | null): string | null =>
    id === null ? null : (names.get(id) ?? `UNRESOLVED:${id}`);

  // These two are identified by what they point at, so they can only be named
  // once the rows above have been.
  for (const g of config.gauges) names.set(g.id, `gauge:${ref(g.familyId)}/${g.label}`);
  for (const s of config.stockSizes) {
    const owner = ref(s.materialId) ?? ref(s.familyId);
    names.set(s.id, `stock:${owner}/${s.lengthIn}x${s.widthIn}`);
  }

  // Aliases are a set, not a list: `loadShopConfig` sorts them and the
  // declaration order they were written in means nothing. Everything else
  // keeps its order, because order elsewhere is data.
  const sortAliases = <T>(row: T): T =>
    'aliases' in (row as object)
      ? { ...row, aliases: [...(row as { aliases: string[] }).aliases].sort() }
      : row;

  const withIds = <T extends { id: string }>(rows: T[]): unknown[] =>
    rows.map((r) => sortAliases({ ...r, id: ref(r.id) })).sort(sortByJson);

  return {
    schemaVersion: config.schemaVersion,
    defaults: config.defaults,
    parity: config.parity,
    enabledModules: [...config.enabledModules],
    families: withIds(config.families),
    gauges: config.gauges
      .map((g) => ({ ...g, id: ref(g.id), familyId: ref(g.familyId) }))
      .sort(sortByJson),
    materials: config.materials
      .map((m) => sortAliases({ ...m, id: ref(m.id), familyId: ref(m.familyId) }))
      .sort(sortByJson),
    stockSizes: config.stockSizes
      .map((s) => ({
        ...s,
        id: ref(s.id),
        materialId: ref(s.materialId),
        familyId: ref(s.familyId),
      }))
      .sort(sortByJson),
    machines: config.machines
      .map((m) => ({ ...m, id: ref(m.id), hitRates: withIds(m.hitRates) }))
      .sort(sortByJson),
    machineMaterialRates: config.machineMaterialRates
      .map((r) => ({ ...r, machineId: ref(r.machineId), materialId: ref(r.materialId) }))
      .sort(sortByJson),
    operations: config.operations
      .map((o) => ({ ...o, id: ref(o.id), machineId: ref(o.machineId) }))
      .sort(sortByJson),
    platingSpecs: withIds(config.platingSpecs),
    coatingModels: withIds(config.coatingModels),
    silkscreenTiers: withIds(config.silkscreenTiers),
    assemblyStandards: withIds(config.assemblyStandards),
  };
}

export function sortByJson(a: unknown, b: unknown): number {
  const x = canonicalJson(a);
  const y = canonicalJson(b);
  return x < y ? -1 : x > y ? 1 : 0;
}
