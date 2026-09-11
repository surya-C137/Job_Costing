import { and, eq, isNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import type { MaterialRow } from '@shopquote/calc';

import type { Actor } from '../src/audit.js';
import {
  addMaterialPrice,
  archiveMaterial,
  archivePlatingSpec,
  createAssemblyStandard,
  createCoatingModel,
  createMaterial,
  createOperation,
  createPlatingSpec,
  createSilkscreenTier,
  materialPriceHistory,
  shopSettingsOf,
  updateAssemblyStandard,
  updateMaterial,
  updatePlatingSpec,
  updateShopSettings,
  type MaterialInput,
} from '../src/catalog.js';
import { loadShopConfig } from '../src/config.js';
import { openMigratedMemoryDatabase, type DatabaseHandle } from '../src/db.js';
import { DataError } from '../src/errors.js';
import { auditLog, intakeAliases, materialPrices } from '../src/schema.js';
import { seedWorkbookShop } from '../src/seed.js';
import { listUsers } from '../src/users.js';

/**
 * Settings writes one row at a time (§4 FR-1): what the owner's forms do, as
 * opposed to a whole-config import. The properties worth pinning are the ones
 * §7 turns on — a price is a new version and never an edit, archiving is soft
 * and frees the name — and that every write leaves an audit row.
 */

interface Shop {
  handle: DatabaseHandle;
  shopId: string;
  actor: Actor;
}

async function seeded(): Promise<Shop> {
  const handle = openMigratedMemoryDatabase();
  const { shopId } = await seedWorkbookShop(handle, { adminPassword: 'test' });
  const [admin] = listUsers(handle.db, shopId);
  if (admin === undefined) throw new Error('the seed made no admin');
  return { handle, shopId, actor: { userId: admin.id } };
}

const CRS = 'CRS 16 GA (.0598)';

function material(shop: Shop, name: string, asOf?: Date): MaterialRow {
  const found = loadShopConfig(shop.handle.db, shop.shopId, asOf).materials.find(
    (m) => m.name === name,
  );
  if (found === undefined) throw new Error(`no "${name}" in the catalog`);
  return found;
}

/** A material as its Settings form would send it back. */
function editable(m: MaterialRow): MaterialInput {
  const { id: _id, pricePerLbUsd: _price, sheetCostUsd: _cost, sheetLbs: _lbs, ...rest } = m;
  return rest;
}

function refusal(write: () => unknown): string {
  try {
    write();
  } catch (error) {
    if (error instanceof DataError) return error.code;
    throw error;
  }
  throw new Error('expected the write to be refused');
}

function audit(shop: Shop): { action: string; summary: string | null }[] {
  return shop.handle.db
    .select({ action: auditLog.action, summary: auditLog.summary })
    .from(auditLog)
    .all();
}

describe('material prices are versions, never edits (§7)', () => {
  it('adds a row and leaves the old one exactly as it was', async () => {
    const shop = await seeded();
    const { db } = shop.handle;
    const crs = material(shop, CRS);
    const before = db
      .select()
      .from(materialPrices)
      .where(eq(materialPrices.materialId, crs.id))
      .all();

    const version = addMaterialPrice(
      shop.handle,
      shop.shopId,
      crs.id,
      {
        pricePerLbUsd: 0.62,
        sheetCostUsd: 186,
        sheetLbs: 300,
        effectiveFrom: new Date('2026-06-01T00:00:00Z'),
        note: 'tariff',
      },
      shop.actor,
    );

    const after = db
      .select()
      .from(materialPrices)
      .where(eq(materialPrices.materialId, crs.id))
      .all();
    expect(after).toHaveLength(before.length + 1);
    for (const row of before) expect(after).toContainEqual(row);
    expect(version.enteredByUserId).toBe(shop.actor.userId);

    // Which version prices a quote depends on the day it is priced.
    expect(material(shop, CRS, new Date('2026-05-31T00:00:00Z')).pricePerLbUsd).toBeCloseTo(
      0.41,
      4,
    );
    const june = material(shop, CRS, new Date('2026-06-02T00:00:00Z'));
    expect(june.pricePerLbUsd).toBe(0.62);
    expect(june.sheetCostUsd).toBe(186);

    const history = materialPriceHistory(db, shop.shopId, crs.id);
    expect(history.map((v) => v.pricePerLbUsd)).toEqual([before[0]?.pricePerLbUsd, 0.62]);
    expect(audit(shop).at(-1)?.summary).toBe(`${CRS}: $0.62/lb from 2026-06-01 (was $0.41)`);
    shop.handle.close();
  });

  it('prices stock the workbook never priced, and says so', async () => {
    const shop = await seeded();
    const brushed = loadShopConfig(shop.handle.db, shop.shopId).materials.find(
      (m) => m.pricePerLbUsd === null,
    );
    if (brushed === undefined) throw new Error('the seed has no unpriced material');

    addMaterialPrice(
      shop.handle,
      shop.shopId,
      brushed.id,
      {
        pricePerLbUsd: 2.4,
        sheetCostUsd: null,
        sheetLbs: null,
        effectiveFrom: new Date('2024-01-01T00:00:00Z'),
        note: null,
      },
      shop.actor,
    );
    expect(material(shop, brushed.name).pricePerLbUsd).toBe(2.4);
    expect(audit(shop).at(-1)?.summary).toMatch(/\(first price\)$/);
    shop.handle.close();
  });

  it('will not price a material that has been removed', async () => {
    const shop = await seeded();
    const crs = material(shop, CRS);
    archiveMaterial(shop.handle, shop.shopId, crs.id, shop.actor);
    expect(
      refusal(() =>
        addMaterialPrice(
          shop.handle,
          shop.shopId,
          crs.id,
          {
            pricePerLbUsd: 0.5,
            sheetCostUsd: null,
            sheetLbs: null,
            effectiveFrom: new Date(),
            note: null,
          },
          shop.actor,
        ),
      ),
    ).toBe('not-found');
    shop.handle.close();
  });
});

describe('materials', () => {
  it('adds one with its first price, and refuses a second of the same name', async () => {
    const shop = await seeded();
    const crs = material(shop, CRS);
    const input: MaterialInput = {
      ...editable(crs),
      name: 'CRS 18 GA (.0478)',
      thicknessIn: 0.0478,
    };

    const created = createMaterial(shop.handle, shop.shopId, input, shop.actor, {
      pricePerLbUsd: 0.44,
      sheetCostUsd: null,
      sheetLbs: null,
      effectiveFrom: new Date('2025-01-01T00:00:00Z'),
      note: null,
    });
    expect(created.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(created.pricePerLbUsd).toBe(0.44);
    expect(refusal(() => createMaterial(shop.handle, shop.shopId, input, shop.actor))).toBe(
      'conflict',
    );
    shop.handle.close();
  });

  it('refuses a family that is not a live row of this shop', async () => {
    const shop = await seeded();
    const input: MaterialInput = { ...editable(material(shop, CRS)), name: 'X', familyId: 'nope' };
    expect(refusal(() => createMaterial(shop.handle, shop.shopId, input, shop.actor))).toBe(
      'invalid-reference',
    );
    shop.handle.close();
  });

  it('edits one without touching its price, and logs what moved', async () => {
    const shop = await seeded();
    const crs = material(shop, CRS);
    const updated = updateMaterial(
      shop.handle,
      shop.shopId,
      crs.id,
      { ...editable(crs), lbPerSqFt: 2.51 },
      shop.actor,
    );
    expect(updated.lbPerSqFt).toBe(2.51);
    expect(updated.pricePerLbUsd).toBe(crs.pricePerLbUsd);
    expect(audit(shop).at(-1)?.summary).toBe(`Updated material "${CRS}": lbPerSqFt 2.5 → 2.51`);
    shop.handle.close();
  });

  it('archiving frees the name and takes the machine rates and aliases with it', async () => {
    const shop = await seeded();
    const { db } = shop.handle;
    const crs = material(shop, CRS);
    updateMaterial(
      shop.handle,
      shop.shopId,
      crs.id,
      { ...editable(crs), aliases: ['CRS16'] },
      shop.actor,
    );
    const ratesBefore = loadShopConfig(db, shop.shopId).machineMaterialRates.filter(
      (r) => r.materialId === crs.id,
    );
    expect(ratesBefore.length).toBeGreaterThan(0);

    archiveMaterial(shop.handle, shop.shopId, crs.id, shop.actor);

    const config = loadShopConfig(db, shop.shopId);
    expect(config.materials.find((m) => m.id === crs.id)).toBeUndefined();
    expect(config.machineMaterialRates.filter((r) => r.materialId === crs.id)).toEqual([]);
    const liveAliases = db
      .select()
      .from(intakeAliases)
      .where(and(eq(intakeAliases.targetId, crs.id), isNull(intakeAliases.archivedAt)))
      .all();
    expect(liveAliases).toEqual([]);

    // The name and the alias are free for the stock that replaces it.
    const replacement = createMaterial(
      shop.handle,
      shop.shopId,
      { ...editable(crs), aliases: ['CRS16'] },
      shop.actor,
    );
    expect(replacement.name).toBe(CRS);
    expect(replacement.aliases).toEqual(['CRS16']);
    shop.handle.close();
  });

  it('lets an alias answer for one material only (§8)', async () => {
    const shop = await seeded();
    const crs = material(shop, CRS);
    const g30 = material(shop, 'G30 16 GA (.0598)');
    updateMaterial(
      shop.handle,
      shop.shopId,
      crs.id,
      { ...editable(crs), aliases: ['16GA'] },
      shop.actor,
    );
    expect(
      refusal(() =>
        updateMaterial(
          shop.handle,
          shop.shopId,
          g30.id,
          { ...editable(g30), aliases: ['16GA'] },
          shop.actor,
        ),
      ),
    ).toBe('conflict');
    shop.handle.close();
  });
});

describe('the other catalogs', () => {
  it('links an operation to a live machine, and allows a repeated name', async () => {
    const shop = await seeded();
    const config = loadShopConfig(shop.handle.db, shop.shopId);
    const laser = config.machines.find((m) => m.timeModel === 'featureBased');
    if (laser === undefined) throw new Error('no laser seeded');

    const base = {
      name: 'BRAKE, BEND',
      machineId: null,
      kind: 'manual' as const,
      setupHrs: 0.25,
      standardPerHr: 180,
      standardUnit: 'pieces' as const,
      ratePerHrUsd: 85,
      active: true,
    };
    // The workbook already has two BRAKE, BEND rows; a third is a real thing.
    expect(createOperation(shop.handle, shop.shopId, base, shop.actor).name).toBe('BRAKE, BEND');
    expect(
      createOperation(
        shop.handle,
        shop.shopId,
        { ...base, name: 'LASER 2', kind: 'machine', machineId: laser.id, standardPerHr: null },
        shop.actor,
      ).machineId,
    ).toBe(laser.id);
    expect(
      refusal(() =>
        createOperation(shop.handle, shop.shopId, { ...base, machineId: 'nope' }, shop.actor),
      ),
    ).toBe('invalid-reference');
    shop.handle.close();
  });

  it('keeps a plating spec’s old names as aliases, and lets them go when it goes', async () => {
    const shop = await seeded();
    const spec = createPlatingSpec(
      shop.handle,
      shop.shopId,
      {
        name: 'ZINC, ASTM B633 TYPE II',
        aliases: ['QQ-Z-325'],
        lotMinimumUsd: 125,
        pricePerSqInUsd: 0.05,
        partMinimumUsd: 0.5,
        rohsCompliant: false,
        active: true,
      },
      shop.actor,
    );
    expect(spec.aliases).toEqual(['QQ-Z-325']);
    const renamed = updatePlatingSpec(
      shop.handle,
      shop.shopId,
      spec.id,
      { ...spec, aliases: ['QQ-Z-325', 'ZINC CLEAR'], rohsCompliant: true },
      shop.actor,
    );
    expect(renamed.aliases).toEqual(['QQ-Z-325', 'ZINC CLEAR']);
    archivePlatingSpec(shop.handle, shop.shopId, spec.id, shop.actor);
    expect(
      loadShopConfig(shop.handle.db, shop.shopId).platingSpecs.find((p) => p.id === spec.id),
    ).toBeUndefined();
    shop.handle.close();
  });

  it('stores a coating model’s modern parameters as one group (§11.3)', async () => {
    const shop = await seeded();
    const model = createCoatingModel(
      shop.handle,
      shop.shopId,
      {
        name: 'Powder, textured',
        minimumChargeUsd: 1.5,
        legacy: null,
        modern: {
          specificGravity: 1.5,
          filmThicknessMils: 2.5,
          transferEfficiency: 0.65,
          powderPricePerLbUsd: 6,
          rackLaborUsdPerPart: 0.15,
          maskingUsdPerFeature: 0.3,
        },
      },
      shop.actor,
    );
    expect(model.modern?.transferEfficiency).toBe(0.65);
    expect(model.legacy).toBeNull();
    shop.handle.close();
  });

  it('adds silkscreen tiers and assembly standards', async () => {
    const shop = await seeded();
    const tier = createSilkscreenTier(
      shop.handle,
      shop.shopId,
      { name: 'Two colour', screenCostUsd: 90, printCostUsd: 0.4, active: true },
      shop.actor,
    );
    expect(tier.screenCostUsd).toBe(90);

    const standard = createAssemblyStandard(
      shop.handle,
      shop.shopId,
      { section: 'HARDWARE', action: 'INSTALL CAPTIVE SCREW', standardSeconds: 12 },
      shop.actor,
    );
    const faster = updateAssemblyStandard(
      shop.handle,
      shop.shopId,
      standard.id,
      { ...standard, standardSeconds: 9 },
      shop.actor,
    );
    expect(faster.standardSeconds).toBe(9);
    shop.handle.close();
  });

  it('writes one audit row per change, in the same transaction', async () => {
    const shop = await seeded();
    const before = audit(shop).length;
    const tier = createSilkscreenTier(
      shop.handle,
      shop.shopId,
      { name: 'One colour', screenCostUsd: 60, printCostUsd: 0.25, active: true },
      shop.actor,
    );
    // A refused write leaves no trace either.
    expect(
      refusal(() =>
        createSilkscreenTier(
          shop.handle,
          shop.shopId,
          { name: 'One colour', screenCostUsd: 1, printCostUsd: 1, active: true },
          shop.actor,
        ),
      ),
    ).toBe('conflict');
    const actions = audit(shop)
      .slice(before)
      .map((a) => a.action);
    expect(actions).toEqual(['silkscreen.create']);
    expect(tier.name).toBe('One colour');
    shop.handle.close();
  });
});

describe('shop settings', () => {
  it('changes the shop row and logs exactly what moved', async () => {
    const shop = await seeded();
    const current = shopSettingsOf(loadShopConfig(shop.handle.db, shop.shopId));
    const config = updateShopSettings(
      shop.handle,
      shop.shopId,
      {
        ...current,
        defaults: { ...current.defaults, laborMarkup: 1.25 },
        parity: { ...current.parity, machineTimeFactor: 1 },
      },
      shop.actor,
    );
    expect(config.defaults.laborMarkup).toBe(1.25);
    expect(config.parity.machineTimeFactor).toBe(1);
    expect(audit(shop).at(-1)).toEqual({
      action: 'config.update',
      summary: 'Changed defaults.laborMarkup 1.2 → 1.25; parity.machineTimeFactor 0.6 → 1',
    });
    shop.handle.close();
  });
});
