/**
 * `npm run db:seed-blank` — a shop that arrives without a workbook.
 *
 * This is Phase 6's starting point (BUILD-PLAN: "they get an empty shop or
 * their workbook loaded"), and it is the honest test of whether anything about
 * this shop leaked into code: a blank shop has no machines, no materials, no
 * operations and no finishes, and the app has to say so rather than invent
 * them (§12 rule 3 — missing data warns visibly, it never silently defaults).
 *
 * What it does seed is the two things that are not shop opinions:
 *
 *   - **Gauge tables.** MSG, galvanised, stainless and Brown & Sharpe are the
 *     trade's, not this shop's, and a drawing that says "16 ga" means the same
 *     thing in every shop. See `reference/gauges.ts`.
 *   - **Unit defaults.** Imperial, USD, 30-day validity, the six quantity
 *     breaks §3 names.
 *
 * Everything with a price on it is left empty on purpose, and the parity flags
 * come up *off*: they exist to reproduce one 1998 workbook, and a shop that
 * never had it should not inherit its quirks.
 */

import { parseArgs } from 'node:util';
import { ulid } from 'ulid';

import { ALL_SHEET_METAL_MODULES, type ShopConfig, type UnitSystem } from '@shopquote/calc';

import { fail, isEntryPoint, printCounts } from './cli.js';
import { openDatabase, runMigrations, type DatabaseHandle } from './db.js';
import { generatePassword, hashPassword } from './password.js';
import { referenceFamilies, referenceGauges } from './reference/gauges.js';
import { shops, users } from './schema.js';
import { writeShopConfig } from './write-config.js';

export interface BlankShopOptions {
  shopName?: string;
  unitSystem?: UnitSystem;
  currency?: string;
  adminUsername?: string;
  adminPassword?: string;
  adminEmail?: string;
  force?: boolean;
}

export interface BlankShopResult {
  shopId: string;
  shopName: string;
  counts: Record<string, number>;
  adminUsername: string;
  generatedPassword?: string;
}

/**
 * The config a new shop starts from: gauge tables, units, and nothing that
 * costs money.
 *
 * Markups are 1.0 and the minimum-charge strip is 0 — "not set yet" expressed
 * as arithmetic that changes nothing, rather than as this shop's 1.2 and 12 in
 * wearing another shop's name. The Settings screens (Task 4.2) are where they
 * get real values, and a quote priced at markup 1.0 is visibly priced at cost.
 */
export function blankShopConfig(shopId: string, options: BlankShopOptions = {}): ShopConfig {
  return {
    schemaVersion: 1,
    shopId,
    defaults: {
      shopName: options.shopName ?? 'New Shop',
      unitSystem: options.unitSystem ?? 'imperial',
      currency: options.currency ?? 'USD',
      validityDays: 30,
      quoteTerms: '',
      defaultQuantityBreaks: [1, 5, 10, 30, 50, 100],
      shopFixedCostPerJobUsd: 0,
      laborMarkup: 1,
      materialMarkup: 1,
      nreRatePerHrUsd: 0,
      nreMarkup: 1,
      minChargeStripIn: 0,
    },
    families: referenceFamilies(),
    gauges: referenceGauges(),
    materials: [],
    stockSizes: [],
    machines: [],
    machineMaterialRates: [],
    operations: [],
    platingSpecs: [],
    coatingModels: [],
    silkscreenTiers: [],
    assemblyStandards: [],
    // Off, all four. A shop without the workbook has no workbook to match.
    parity: {
      markupInsideMinChargeMax: false,
      machineTimeFactor: 1,
      legacyCoatingModel: false,
      finishesUnmarked: false,
    },
    enabledModules: [...ALL_SHEET_METAL_MODULES],
  };
}

export function seedBlankShop(
  handle: DatabaseHandle,
  options: BlankShopOptions = {},
): BlankShopResult {
  const existing = handle.db.select({ id: shops.id }).from(shops).all();
  if (existing.length > 0 && options.force !== true) {
    throw new Error(
      `This database already holds ${existing.length} shop(s). Delete the database file to ` +
        `start over, or pass --force to add another shop alongside it.`,
    );
  }

  const shopId = ulid();
  const config = blankShopConfig(shopId, options);
  const written = writeShopConfig(handle, config, {
    shopId,
    // Nothing is priced yet, so the date only ever applies to rows that do not
    // exist. Kept explicit rather than optional so the writer has one path.
    pricesEffectiveFrom: new Date(),
  });

  const username = options.adminUsername ?? 'admin';
  const generated = options.adminPassword === undefined ? generatePassword() : undefined;

  handle.db
    .insert(users)
    .values({
      id: ulid(),
      shopId,
      username,
      email: options.adminEmail ?? null,
      displayName: 'Administrator',
      role: 'admin',
      passwordHash: hashPassword(options.adminPassword ?? generated ?? ''),
      mustChangePassword: true,
    })
    .run();

  return {
    shopId,
    shopName: config.defaults.shopName,
    counts: { ...written.counts, users: 1 },
    adminUsername: username,
    ...(generated === undefined ? {} : { generatedPassword: generated }),
  };
}

export function seedBlankCommand(argv: string[] = process.argv.slice(2)): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      db: { type: 'string' },
      'shop-name': { type: 'string' },
      'unit-system': { type: 'string' },
      currency: { type: 'string' },
      force: { type: 'boolean' },
    },
    allowPositionals: false,
  });

  const unitSystem = values['unit-system'];
  if (unitSystem !== undefined && unitSystem !== 'imperial' && unitSystem !== 'metric') {
    throw new Error(`--unit-system must be "imperial" or "metric", not "${unitSystem}".`);
  }

  const handle = openDatabase(values.db === undefined ? {} : { path: values.db });
  try {
    runMigrations(handle);
    const env = process.env;
    // `SHOPQUOTE_SHOP_NAME`, not just `--shop-name`: npm on Windows mangles a
    // `-- --flag "value with spaces"` into caret-escaped nonsense, and shops
    // run Windows Server (§2). The flag stays for POSIX and for one-word names.
    const shopName = values['shop-name'] ?? env['SHOPQUOTE_SHOP_NAME'];
    const result = seedBlankShop(handle, {
      ...(shopName === undefined ? {} : { shopName }),
      ...(unitSystem === undefined ? {} : { unitSystem }),
      ...(values.currency === undefined ? {} : { currency: values.currency }),
      ...(env['SHOPQUOTE_ADMIN_USERNAME'] === undefined
        ? {}
        : { adminUsername: env['SHOPQUOTE_ADMIN_USERNAME'] }),
      ...(env['SHOPQUOTE_ADMIN_PASSWORD'] === undefined
        ? {}
        : { adminPassword: env['SHOPQUOTE_ADMIN_PASSWORD'] }),
      ...(env['SHOPQUOTE_ADMIN_EMAIL'] === undefined
        ? {}
        : { adminEmail: env['SHOPQUOTE_ADMIN_EMAIL'] }),
      ...(values.force === true ? { force: true } : {}),
    });

    console.log(`Created "${result.shopName}" in ${handle.path}\n`);
    printCounts(result.counts);
    console.log(
      `\nEmpty on purpose: no machines, materials, operations or finishes.\n` +
        `Add them in Settings, or import a config JSON. Parity flags are off.`,
    );
    console.log(`\nAdmin user: ${result.adminUsername}`);
    if (result.generatedPassword !== undefined) {
      console.log(`Password:   ${result.generatedPassword}`);
      console.log(`\nShown once. Change it at first login.`);
    }
    return 0;
  } finally {
    handle.close();
  }
}

if (isEntryPoint(import.meta.url)) {
  let code = 0;
  try {
    code = seedBlankCommand();
  } catch (error) {
    code = fail(error);
  }
  process.exit(code);
}
