import { afterEach, describe, expect, it } from 'vitest';

import type { MaterialRow, ShopConfig } from '@shopquote/calc';

import { admin, auditActions, harness, problemOf, type Harness } from './helpers.js';

/**
 * The catalogs, a row at a time (BUILD-PLAN 3.1; §4 FR-1). Material prices get
 * the most attention because §7 is strictest about them: a new price is a new
 * version, the old one stays, and a quote dated before the change still reads
 * the price it was written against.
 */

let h: Harness;
afterEach(async () => {
  await h.close();
});

const DAY = 86_400_000;
const G30 = 'G30 16 GA (.0598)';

async function configOf(me: Awaited<ReturnType<typeof admin>>, query = ''): Promise<ShopConfig> {
  return (await me.request({ method: 'GET', url: `/api/config${query}` })).json<ShopConfig>();
}

function material(config: ShopConfig, name: string): MaterialRow {
  const found = config.materials.find((m) => m.name === name);
  if (found === undefined) throw new Error(`no "${name}"`);
  return found;
}

describe('material prices (§7)', () => {
  it('posts a new version, keeps the old one, and old dates still read the old price', async () => {
    h = await harness();
    const me = await admin(h);
    const g30 = material(await configOf(me), G30);
    const historyUrl = `/api/materials/${g30.id}/prices`;
    const before = (await me.request({ method: 'GET', url: historyUrl })).json();
    expect(before).toHaveLength(1);

    const yesterday = new Date(Date.now() - DAY);
    const posted = await me.request({
      method: 'POST',
      url: `/api/materials/${g30.id}/price`,
      payload: {
        pricePerLbUsd: 0.92,
        effectiveFrom: yesterday.toISOString(),
        note: 'mill increase',
      },
    });
    expect(posted.statusCode).toBe(201);
    expect(posted.json()).toMatchObject({ pricePerLbUsd: 0.92, note: 'mill increase' });

    const after = (await me.request({ method: 'GET', url: historyUrl })).json();
    expect(after).toHaveLength(2);
    expect(after[0]).toEqual(before[0]);

    const dayBefore = new Date(Date.now() - 2 * DAY).toISOString();
    expect(material(await configOf(me, `?asOf=${dayBefore}`), G30).pricePerLbUsd).toBeCloseTo(
      0.8099,
      4,
    );
    const now = await me.request({ method: 'GET', url: `/api/materials/${g30.id}` });
    expect(now.json().pricePerLbUsd).toBe(0.92);

    expect(auditActions(h, posted.json().id)).toEqual(['material.price.create']);
  });

  it('refuses a price on a material edit, and says where prices go', async () => {
    h = await harness();
    const me = await admin(h);
    const g30 = material(await configOf(me), G30);
    const { id: _id, ...fields } = g30;

    const response = await me.request({
      method: 'PUT',
      url: `/api/materials/${g30.id}`,
      payload: { ...fields, pricePerLbUsd: 1 },
    });
    expect(response.statusCode).toBe(422);
    const problem = problemOf(response);
    expect(problem.errors?.[0]?.pointer).toBe('/pricePerLbUsd');
    expect(problem.detail).toMatch(/POST \/api\/materials\/:id\/price/);
  });
});

type Row = Record<string, unknown> & { id: string };

interface Case {
  path: string;
  /** The audit verb prefix `@shopquote/db` writes for this catalog. */
  action: string;
  create: (config: ShopConfig) => Record<string, unknown>;
  change: Record<string, unknown>;
}

const CASES: Case[] = [
  {
    path: 'materials',
    action: 'material',
    create: (config) => ({
      name: 'CRS 18 GA (.0478)',
      familyId: material(config, 'CRS 16 GA (.0598)').familyId,
      thicknessIn: 0.0478,
      lbPerSqFt: 2,
      standardLengthIn: 120,
      price: { pricePerLbUsd: 0.44 },
    }),
    change: { lbPerSqFt: 2.01 },
  },
  {
    path: 'operations',
    action: 'operation',
    create: () => ({
      name: 'PRESS BRAKE 2',
      kind: 'manual',
      standardPerHr: 200,
      standardUnit: 'pieces',
      ratePerHrUsd: 85,
    }),
    change: { ratePerHrUsd: 90 },
  },
  {
    path: 'plating-specs',
    action: 'plating',
    create: () => ({
      name: 'ZINC, ASTM B633 TYPE II',
      aliases: ['QQ-Z-325'],
      lotMinimumUsd: 125,
      pricePerSqInUsd: 0.04,
      partMinimumUsd: 0.5,
    }),
    change: { rohsCompliant: true },
  },
  {
    path: 'coating-models',
    action: 'coating',
    create: () => ({
      name: 'Liquid, 2K urethane',
      legacy: { rateUsd: 0.5, coverage: 100, sConstant: 5 },
    }),
    change: { minimumChargeUsd: 2 },
  },
  {
    path: 'silkscreen-tiers',
    action: 'silkscreen',
    create: () => ({ name: 'Three colour', screenCostUsd: 120, printCostUsd: 0.6 }),
    change: { printCostUsd: 0.55 },
  },
  {
    path: 'assembly-standards',
    action: 'assembly',
    create: () => ({ section: 'HARDWARE', action: 'INSTALL PEM STANDOFF', standardSeconds: 6 }),
    change: { standardSeconds: 5 },
  },
];

describe('every catalog', () => {
  for (const c of CASES) {
    it(`/api/${c.path}: create, read, update, archive — each one logged`, async () => {
      h = await harness();
      const me = await admin(h);
      const url = `/api/${c.path}`;

      const created = await me.request({
        method: 'POST',
        url,
        payload: c.create(await configOf(me)),
      });
      expect(created.statusCode, created.body).toBe(201);
      const row = created.json<Row>();
      expect(created.headers['location']).toBe(`${url}/${row.id}`);
      expect((await me.request({ method: 'GET', url: `${url}/${row.id}` })).json()).toEqual(row);

      // A PUT sends the row back as its form would: no id, no price.
      const { id: _id, pricePerLbUsd: _p, sheetCostUsd: _c, sheetLbs: _l, ...fields } = row;
      const updated = await me.request({
        method: 'PUT',
        url: `${url}/${row.id}`,
        payload: { ...fields, ...c.change },
      });
      expect(updated.statusCode, updated.body).toBe(200);
      expect(updated.json()).toMatchObject(c.change);

      const listed = (await me.request({ method: 'GET', url })).json<Row[]>();
      expect(listed.some((r) => r.id === row.id)).toBe(true);

      expect((await me.request({ method: 'DELETE', url: `${url}/${row.id}` })).statusCode).toBe(
        204,
      );
      expect((await me.request({ method: 'GET', url: `${url}/${row.id}` })).statusCode).toBe(404);

      expect(auditActions(h, row.id)).toEqual([
        `${c.action}.create`,
        `${c.action}.update`,
        `${c.action}.archive`,
      ]);
    });
  }
});

describe('refusals, as problem+json', () => {
  it('a name already in use is a 409 naming the field', async () => {
    h = await harness();
    const me = await admin(h);
    const response = await me.request({
      method: 'POST',
      url: '/api/silkscreen-tiers',
      payload: { name: 'Twice', printCostUsd: 0.5 },
    });
    expect(response.statusCode).toBe(201);
    const again = await me.request({
      method: 'POST',
      url: '/api/silkscreen-tiers',
      payload: { name: 'Twice', printCostUsd: 0.5 },
    });
    expect(again.statusCode).toBe(409);
    expect(problemOf(again).errors?.[0]?.pointer).toBe('/name');
  });

  it('a family from nowhere is a 422 naming the field', async () => {
    h = await harness();
    const me = await admin(h);
    const response = await me.request({
      method: 'POST',
      url: '/api/materials',
      payload: {
        name: 'X',
        familyId: 'nope',
        thicknessIn: 0.06,
        lbPerSqFt: 2.5,
        standardLengthIn: 120,
      },
    });
    expect(response.statusCode).toBe(422);
    const problem = problemOf(response);
    expect(problem.type).toBe('urn:shopquote:problem:invalid-reference');
    expect(problem.errors?.[0]?.pointer).toBe('/familyId');
  });

  it('lists every field that failed, as JSON Pointers', async () => {
    h = await harness();
    const me = await admin(h);
    const response = await me.request({
      method: 'POST',
      url: '/api/operations',
      payload: { name: '', kind: 'sideways', setupHrs: -1 },
    });
    expect(response.statusCode).toBe(422);
    const pointers = problemOf(response).errors?.map((e) => e.pointer);
    expect(pointers).toEqual(expect.arrayContaining(['/name', '/kind', '/setupHrs']));
  });

  it('an id that is not there is a 404', async () => {
    h = await harness();
    const me = await admin(h);
    const response = await me.request({ method: 'GET', url: '/api/materials/nope' });
    expect(response.statusCode).toBe(404);
    expect(problemOf(response).type).toBe('urn:shopquote:problem:not-found');
  });
});
