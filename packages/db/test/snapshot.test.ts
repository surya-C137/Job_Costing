import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  computeQuote,
  type PartInput,
  type QuoteInput,
  type QuoteResult,
  type ShopConfig,
} from '@shopquote/calc';

import { loadShopConfig, loadSnapshot, saveSnapshot } from '../src/config.js';
import { openMigratedMemoryDatabase, type DatabaseHandle } from '../src/db.js';
import { configSnapshots, customers, parts, quotes, quoteVersions } from '../src/schema.js';
import { seedWorkbookShop, WORKBOOK_PRICE_VINTAGE } from '../src/seed.js';

/**
 * `saveSnapshot()` / `loadSnapshot()` — REQUIREMENTS §7: "a quote stores the
 * full `ShopConfig` used; re-pricing is explicit."
 *
 * Two things are being tested. That a version really is frozen — reopen a
 * quote from March and you get March's rates, whatever Settings says today.
 * And that freezing it is affordable: §4 FR-2 makes every autosave a version,
 * so the config is content-addressed and a day of editing shares one row.
 */

const AFTER_SEED = new Date(WORKBOOK_PRICE_VINTAGE.getTime() + 86_400_000);

interface Fixture {
  handle: DatabaseHandle;
  shopId: string;
  quoteId: string;
  config: ShopConfig;
  input: QuoteInput;
  result: QuoteResult;
}

async function fixture(): Promise<Fixture> {
  const handle = openMigratedMemoryDatabase();
  const { shopId } = await seedWorkbookShop(handle, { adminPassword: 'test' });
  const config = loadShopConfig(handle.db, shopId, AFTER_SEED);

  const customer = handle.db
    .insert(customers)
    .values({ shopId, name: 'Northfield Controls' })
    .returning()
    .get();

  const material = config.materials.find((m) => m.name === 'G30 16 GA (.0598)');
  const machine = config.machines.find((m) => m.timeModel === 'featureBased');
  const laser = config.operations.find((o) => o.name === 'LASER');
  if (material === undefined || machine === undefined || laser === undefined) {
    throw new Error('seeded catalog is missing the golden case rows');
  }

  const part = handle.db
    .insert(parts)
    .values({
      shopId,
      customerId: customer.id,
      partNumber: 'NC-1042',
      rev: 'B',
      materialId: material.id,
      flatLengthIn: 13.38,
      flatWidthIn: 7.858,
      source: 'manual',
    })
    .returning()
    .get();

  const quote = handle.db
    .insert(quotes)
    .values({
      shopId,
      quoteNumber: 'Q-2026-0001',
      customerId: customer.id,
      quoteDate: new Date('2026-03-02T00:00:00Z'),
    })
    .returning()
    .get();

  const partInput: PartInput = {
    id: part.id,
    partNumber: part.partNumber,
    materialId: material.id,
    flatLengthIn: 13.38,
    flatWidthIn: 7.858,
    nesting: { machineId: machine.id, stockWidthIn: 48, blankLengthIn: 96 },
    cutting: { model: 'featureBased', features: [], perimeterCutIn: 58, intersections: 1 },
    operations: [{ operationId: laser.id, countPerPart: 1 }],
    finish: {},
    hardware: [],
    nre: [],
  };
  const input: QuoteInput = {
    quoteNumber: quote.quoteNumber,
    parts: [partInput],
    quantityBreaks: [...config.defaults.defaultQuantityBreaks],
  };

  return {
    handle,
    shopId,
    quoteId: quote.id,
    config,
    input,
    result: computeQuote(input, config),
  };
}

/** The three fields a save actually takes, without the fixture's plumbing. */
function argsFor(f: Fixture): {
  quoteId: string;
  config: ShopConfig;
  input: QuoteInput;
  result: QuoteResult;
} {
  return { quoteId: f.quoteId, config: f.config, input: f.input, result: f.result };
}

describe('saveSnapshot', () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await fixture();
  });

  it('numbers versions from one and moves the quote pointer with them', async () => {
    const first = saveSnapshot(f.handle, argsFor(f));
    const second = saveSnapshot(f.handle, argsFor(f));

    expect(first.versionNo).toBe(1);
    expect(second.versionNo).toBe(2);
    const quote = f.handle.db.select().from(quotes).where(eq(quotes.id, f.quoteId)).get();
    expect(quote?.currentVersionNo).toBe(2);
    f.handle.close();
  });

  it('stores one config row for many saves of the same config', async () => {
    // The point of content-addressing. Twenty autosaves on an untouched
    // Settings must not be twenty copies of a 100 KB catalog.
    for (let i = 0; i < 20; i += 1) saveSnapshot(f.handle, argsFor(f));

    expect(f.handle.db.select().from(quoteVersions).all()).toHaveLength(20);
    expect(f.handle.db.select().from(configSnapshots).all()).toHaveLength(1);
    f.handle.close();
  });

  it('writes a second config row once a rate actually changes', async () => {
    const before = saveSnapshot(f.handle, argsFor(f));
    expect(before.reusedSnapshot).toBe(false);

    const repriced: ShopConfig = {
      ...f.config,
      defaults: { ...f.config.defaults, laborMarkup: 1.35 },
    };
    const after = saveSnapshot(f.handle, {
      quoteId: f.quoteId,
      config: repriced,
      input: f.input,
      result: computeQuote(f.input, repriced),
      reason: 'reprice',
    });

    expect(after.reusedSnapshot).toBe(false);
    expect(after.configHash).not.toBe(before.configHash);
    expect(f.handle.db.select().from(configSnapshots).all()).toHaveLength(2);
    f.handle.close();
  });

  it('reports a reused snapshot as reused', async () => {
    saveSnapshot(f.handle, argsFor(f));
    const again = saveSnapshot(f.handle, argsFor(f));
    expect(again.reusedSnapshot).toBe(true);
    f.handle.close();
  });

  it('refuses a snapshot that belongs to no quote', async () => {
    expect(() => saveSnapshot(f.handle, { ...argsFor(f), quoteId: 'nope' })).toThrow(
      /No quote nope/,
    );
    // …and leaves nothing behind: the whole save is one transaction.
    expect(f.handle.db.select().from(configSnapshots).all()).toHaveLength(0);
    f.handle.close();
  });
});

describe('loadSnapshot', () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await fixture();
  });

  it('gives back the newest version, config and all', async () => {
    saveSnapshot(f.handle, argsFor(f));
    const loaded = loadSnapshot(f.handle.db, f.quoteId);

    expect(loaded?.versionNo).toBe(1);
    expect(loaded?.reason).toBe('save');
    expect(loaded?.config.defaults.laborMarkup).toBe(f.config.defaults.laborMarkup);
    expect(loaded?.config.materials).toHaveLength(f.config.materials.length);
    expect(loaded?.input.parts[0]?.partNumber).toBe('NC-1042');
    expect(loaded?.result.parts[0]?.breaks).toHaveLength(6);
    f.handle.close();
  });

  /**
   * The §7 promise in one test: a quote priced in March still prices at
   * March's rates when it is reopened, whatever Settings says now. Without
   * this, "re-pricing is explicit" is just a sentence.
   */
  it('keeps the old version answering with the old rates', async () => {
    const march = saveSnapshot(f.handle, argsFor(f));
    const marchPrice = f.result.parts[0]?.breaks[5]?.sellingPriceUsd;

    const dearer: ShopConfig = {
      ...f.config,
      defaults: { ...f.config.defaults, materialMarkup: 1.6 },
    };
    saveSnapshot(f.handle, {
      quoteId: f.quoteId,
      config: dearer,
      input: f.input,
      result: computeQuote(f.input, dearer),
      reason: 'reprice',
    });

    const then = loadSnapshot(f.handle.db, f.quoteId, march.versionNo);
    const now = loadSnapshot(f.handle.db, f.quoteId);

    expect(then?.config.defaults.materialMarkup).toBe(1.2);
    expect(then?.result.parts[0]?.breaks[5]?.sellingPriceUsd).toBe(marchPrice);
    expect(now?.config.defaults.materialMarkup).toBe(1.6);
    expect(now?.result.parts[0]?.breaks[5]?.sellingPriceUsd).not.toBe(marchPrice);
    // Re-pricing something that was already priced re-runs the engine against
    // a new config; it never edits the version that was sent to the customer.
    expect(now?.reason).toBe('reprice');
    f.handle.close();
  });

  it('returns nothing for a quote that has never been saved', async () => {
    expect(loadSnapshot(f.handle.db, f.quoteId)).toBeUndefined();
    expect(loadSnapshot(f.handle.db, 'no-such-quote')).toBeUndefined();
    f.handle.close();
  });

  it('returns nothing for a version number that does not exist', async () => {
    saveSnapshot(f.handle, argsFor(f));
    expect(loadSnapshot(f.handle.db, f.quoteId, 7)).toBeUndefined();
    f.handle.close();
  });
});
