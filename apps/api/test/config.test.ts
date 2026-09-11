import { afterEach, describe, expect, it } from 'vitest';

import { computeQuote, type PartInput, type QuoteInput, type ShopConfig } from '@shopquote/calc';

import { canonicalise } from '../../../packages/db/test/helpers/canonical.js';
import golden from '../../../packages/calc/test/fixtures/golden-workbook.json' with { type: 'json' };
import { admin, harness, problemOf, userWith, type Harness } from './helpers.js';

/**
 * `/api/config` — BUILD-PLAN 3.1's acceptance check is "`curl` login +
 * `GET /api/config` returns the seeded config". This goes one better: the
 * config that comes back over HTTP still prices REQUIREMENTS §9 to the cent,
 * so nothing was lost to JSON on the way — no null turned into a zero, no rate
 * dropped. Then the shop page, and the config file both ways.
 */

let h: Harness;
afterEach(async () => {
  await h.close();
});

function idOf(rows: { id: string; name: string }[], name: string): string {
  const row = rows.find((r) => r.name === name);
  if (row === undefined) throw new Error(`no "${name}" in the config`);
  return row.id;
}

/** The §9 part, entered against a config fetched from the API. */
function goldenQuote(config: ShopConfig): QuoteInput {
  const coating = config.coatingModels.find((c) => c.name.startsWith('Powder'));
  if (coating === undefined) throw new Error('no powder coating model');
  const part: PartInput = {
    id: 'part-g30',
    partNumber: 'G30-GOLDEN',
    materialId: idOf(config.materials, golden.material.name),
    flatLengthIn: golden.part.flat_length_in,
    flatWidthIn: golden.part.flat_width_in,
    nesting: {
      machineId: idOf(config.machines, golden.nesting.process),
      stockWidthIn: golden.nesting.stock_width_in,
      blankLengthIn: golden.nesting.blank_length_in,
    },
    cutting: {
      model: 'featureBased',
      features: [],
      perimeterCutIn: golden.laser.perimeter_cut_in,
      intersections: golden.laser.intersections,
    },
    operations: [{ operationId: idOf(config.operations, 'LASER'), countPerPart: 1 }],
    finish: { coating: { coatingModelId: coating.id, sidesCoated: 2, maskedFeatures: 0 } },
    hardware: [],
    nre: [],
  };
  return { parts: [part], quantityBreaks: [...golden.quantity_breaks] };
}

describe('GET /api/config', () => {
  it('returns the seeded config, and over the wire it still prices §9 to the cent', async () => {
    h = await harness();
    const me = await admin(h);
    const response = await me.request({ method: 'GET', url: '/api/config' });
    expect(response.statusCode).toBe(200);

    const config = response.json<ShopConfig>();
    expect(config.shopId).toBe(h.shopId);
    expect(config.materials.length).toBeGreaterThanOrEqual(80);

    const [part] = computeQuote(goldenQuote(config), config).parts;
    expect(part?.breaks).toHaveLength(6);
    part?.breaks.forEach((stack, i) => {
      const expected = golden.expected.selling_price[i] ?? Number.NaN;
      expect(
        Math.abs(stack.sellingPriceUsd - expected),
        `qty ${stack.quantity}: ${stack.sellingPriceUsd} against ${expected}`,
      ).toBeLessThanOrEqual(golden.tolerance.selling_price);
    });
  });

  it('refuses an asOf that is not a date, naming it', async () => {
    h = await harness();
    const me = await admin(h);
    const response = await me.request({ method: 'GET', url: '/api/config?asOf=yesterday' });
    expect(response.statusCode).toBe(422);
    expect(problemOf(response).errors?.[0]?.pointer).toBe('/asOf');
  });
});

describe('PUT /api/config — the shop page', () => {
  async function settings(me: Awaited<ReturnType<typeof admin>>) {
    const { defaults, parity, enabledModules } = (
      await me.request({ method: 'GET', url: '/api/config' })
    ).json<ShopConfig>();
    return { defaults, parity, enabledModules };
  }

  it('saves, answers with the new config, and logs what moved', async () => {
    h = await harness();
    const me = await admin(h);
    const current = await settings(me);
    const response = await me.request({
      method: 'PUT',
      url: '/api/config',
      payload: { ...current, defaults: { ...current.defaults, laborMarkup: 1.25 } },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<ShopConfig>().defaults.laborMarkup).toBe(1.25);

    const logged = h.handle.sqlite
      .prepare("SELECT summary FROM audit_log WHERE action = 'config.update'")
      .get() as { summary: string };
    expect(logged.summary).toBe('Changed defaults.laborMarkup 1.2 → 1.25');
  });

  it('names the field when the workbook’s ×60 is typed in as the Q2 factor', async () => {
    h = await harness();
    const me = await admin(h);
    const current = await settings(me);
    const response = await me.request({
      method: 'PUT',
      url: '/api/config',
      payload: { ...current, parity: { ...current.parity, machineTimeFactor: 60 } },
    });
    expect(response.statusCode).toBe(422);
    expect(problemOf(response).errors?.map((e) => e.pointer)).toEqual([
      '/parity/machineTimeFactor',
    ]);
  });

  it('will not take the catalogs — replacing those is an import', async () => {
    h = await harness();
    const me = await admin(h);
    const response = await me.request({
      method: 'PUT',
      url: '/api/config',
      payload: { ...(await settings(me)), materials: [] },
    });
    expect(response.statusCode).toBe(422);
    expect(problemOf(response).errors?.[0]?.detail).toMatch(/materials/);
  });
});

describe('the config file (§4 FR-1, §8)', () => {
  it('exports a file that imports back into the same shop changing nothing', async () => {
    h = await harness();
    const me = await admin(h);
    const exported = await me.request({ method: 'GET', url: '/api/config/export' });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers['content-disposition']).toMatch(
      /^attachment; filename="shopquote-config-shopquote-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    expect(exported.json()).toMatchObject({ format: 'shopquote.config', schemaVersion: 1 });

    const imported = await me.request({
      method: 'POST',
      url: '/api/config/import',
      payload: exported.json(),
    });
    expect(imported.statusCode).toBe(200);
    expect(imported.json().totals).toEqual({ inserted: 0, updated: 0, archived: 0 });
  });

  it('moves a whole configuration into a blank shop — dry run first', async () => {
    h = await harness();
    const source = await admin(h);
    const file = (await source.request({ method: 'GET', url: '/api/config/export' })).json();

    const blank = await harness('blank');
    try {
      const target = await admin(blank);

      const preview = await target.request({
        method: 'POST',
        url: '/api/config/import?dryRun=true',
        payload: file,
      });
      expect(preview.statusCode).toBe(200);
      expect(preview.json().dryRun).toBe(true);
      expect(preview.json().totals.inserted).toBeGreaterThan(0);
      const untouched = await target.request({ method: 'GET', url: '/api/config' });
      expect(untouched.json<ShopConfig>().materials).toEqual([]);

      const imported = await target.request({
        method: 'POST',
        url: '/api/config/import',
        payload: file,
      });
      expect(imported.statusCode).toBe(200);
      const after = (
        await target.request({ method: 'GET', url: '/api/config' })
      ).json<ShopConfig>();
      expect(canonicalise(after)).toEqual(canonicalise(file.config));
    } finally {
      await blank.close();
    }
  });

  it('refuses a file with a reference to nothing, pointing at the row', async () => {
    h = await harness();
    const me = await admin(h);
    const file = (await me.request({ method: 'GET', url: '/api/config/export' })).json();
    file.config.materials[3].familyId = 'nope';

    const response = await me.request({ method: 'POST', url: '/api/config/import', payload: file });
    expect(response.statusCode).toBe(422);
    expect(problemOf(response).errors).toContainEqual({
      pointer: '/config/materials/3/familyId',
      detail: 'No material family "nope" in this config.',
    });
  });

  it('is for owners and admins', async () => {
    h = await harness();
    const estimator = await userWith(h, 'estimator');
    const response = await estimator.request({ method: 'GET', url: '/api/config/export' });
    expect(response.statusCode).toBe(403);
  });
});
