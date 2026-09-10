/**
 * `npm run db:seed` — the shop's workbook, as a database.
 *
 * The path is deliberately short:
 *
 * ```
 *   seed/*.json  --readSeedBundle-->  SeedBundle
 *                --shopConfigFromSeed (calc)-->  ShopConfig
 *                --writeShopConfig-->  rows
 * ```
 *
 * The middle step is calc's, and it is the *same call the golden test makes*
 * with no database in sight. That is the point: there is one mapping from the
 * workbook's shape to the app's, so the catalog in SQLite cannot drift away
 * from the one REQUIREMENTS §9 is proved against. Writing a second
 * seed-JSON-to-SQL mapping here would have been the obvious thing to do and
 * would have quietly broken that guarantee.
 *
 * What this file owns beyond the plumbing: the admin user (§4 FR-6), and the
 * fact that the workbook's prices are dated rather than current.
 */

import { eq } from 'drizzle-orm';
import { parseArgs } from 'node:util';
import { ulid } from 'ulid';

import { ALL_SHEET_METAL_MODULES, shopConfigFromSeed } from '@shopquote/calc';

import { fail, isEntryPoint, printCounts } from './cli.js';
import { openDatabase, runMigrations, type DatabaseHandle } from './db.js';
import { generatePassword, hashPassword } from './password.js';
import { seedDir } from './paths.js';
import { shops, users } from './schema.js';
import { readSeedBundle } from './seed-files.js';
import { writeShopConfig } from './write-config.js';

/**
 * When the workbook's prices were true. REQUIREMENTS §6: "Prices are 2023-era;
 * the owner will update on day one."
 *
 * Stamping them "now" would be a lie the app then reasons from — §7's versioned
 * prices exist so `loadShopConfig(asOf)` can answer what a material cost on the
 * day a quote was priced, and a seed row claiming today's date makes every
 * historical answer wrong. Dating them 2023 also makes the first real price
 * entry look like what it is: an update, with history behind it.
 */
export const WORKBOOK_PRICE_VINTAGE = new Date('2023-01-01T00:00:00.000Z');

export interface SeedOptions {
  /** Where the extracted JSON lives. Defaults to `packages/db/seed`. */
  seedDir?: string;
  /** Shop name on the quote header. */
  shopName?: string;
  adminUsername?: string;
  /** Generated and returned when absent. */
  adminPassword?: string;
  adminEmail?: string;
  /** Add a shop even though the database already holds one. */
  force?: boolean;
}

export interface SeedResult {
  shopId: string;
  shopName: string;
  counts: Record<string, number>;
  adminUsername: string;
  /** Set only when no password was supplied, so the caller can print it once. */
  generatedPassword?: string;
}

/**
 * Load the workbook seed into a migrated database.
 *
 * Refuses a database that already holds a shop unless `force` is set. The
 * schema is multi-shop by design (§12 rule 4), so a second shop is a real
 * thing to want — but on a v1 deployment it is almost always a re-run of the
 * command, and silently building a second catalog would be very hard to spot.
 */
export function seedWorkbookShop(handle: DatabaseHandle, options: SeedOptions = {}): SeedResult {
  const existing = handle.db.select({ id: shops.id }).from(shops).all();
  if (existing.length > 0 && options.force !== true) {
    throw new Error(
      `This database already holds ${existing.length} shop(s). Delete the database file to ` +
        `start over, or pass --force to add another shop alongside it.`,
    );
  }

  const bundle = readSeedBundle(options.seedDir ?? seedDir);
  const shopId = ulid();
  const config = shopConfigFromSeed(bundle, {
    shopId,
    shopName: options.shopName ?? 'ShopQuote',
    enabledModules: [...ALL_SHEET_METAL_MODULES],
  });

  const written = writeShopConfig(handle, config, {
    shopId,
    pricesEffectiveFrom: WORKBOOK_PRICE_VINTAGE,
    priceNote: 'Seeded from Quote_Metal_Cost.xls (2023-era prices, REQUIREMENTS §6)',
  });

  const username = options.adminUsername ?? 'admin';
  const generated = options.adminPassword === undefined ? generatePassword() : undefined;
  const password = options.adminPassword ?? generated ?? '';

  handle.db
    .insert(users)
    .values({
      id: ulid(),
      shopId,
      username,
      email: options.adminEmail ?? null,
      displayName: 'Administrator',
      role: 'admin',
      passwordHash: hashPassword(password),
      // Whether the operator chose it or we generated it, a bootstrap password
      // that has been printed to a terminal is not a password any more.
      mustChangePassword: true,
    })
    .run();

  const counts = { ...written.counts, users: 1 };
  return {
    shopId,
    shopName: config.defaults.shopName,
    counts,
    adminUsername: username,
    ...(generated === undefined ? {} : { generatedPassword: generated }),
  };
}

export function seedCommand(argv: string[] = process.argv.slice(2)): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      db: { type: 'string' },
      'shop-name': { type: 'string' },
      force: { type: 'boolean' },
    },
    allowPositionals: false,
  });

  const handle = openDatabase(values.db === undefined ? {} : { path: values.db });
  try {
    // Idempotent, so `db:seed` works on a fresh checkout without `db:migrate`
    // having been run first.
    runMigrations(handle);

    const env = process.env;
    // `SHOPQUOTE_SHOP_NAME`, not just `--shop-name`: npm on Windows mangles a
    // `-- --flag "value with spaces"` into caret-escaped nonsense, and shops
    // run Windows Server (§2). The flag stays for POSIX and for one-word names.
    const shopName = values['shop-name'] ?? env['SHOPQUOTE_SHOP_NAME'];
    const result = seedWorkbookShop(handle, {
      ...(shopName === undefined ? {} : { shopName }),
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

    console.log(`Seeded "${result.shopName}" into ${handle.path}\n`);
    printCounts(result.counts);

    const materialCount = result.counts['materials'] ?? 0;
    const pricedCount = result.counts['material_prices'] ?? 0;
    console.log(
      `\n${pricedCount} of ${materialCount} materials carry a price, dated ` +
        `${WORKBOOK_PRICE_VINTAGE.toISOString().slice(0, 10)} — the workbook's vintage, not ` +
        `today's. Updating them is the owner's day-one task (REQUIREMENTS §6, FR-1).`,
    );
    if (pricedCount < materialCount) {
      console.log(
        `${materialCount - pricedCount} have no price at all. Those are stocked but never ` +
          `priced in the workbook;\nquoting a part on one warns instead of costing it (§12 rule 3).`,
      );
    }

    console.log(`\nAdmin user: ${result.adminUsername}`);
    if (result.generatedPassword !== undefined) {
      console.log(`Password:   ${result.generatedPassword}`);
      console.log(
        `\nThis is shown once. Change it at first login, or set SHOPQUOTE_ADMIN_PASSWORD\n` +
          `before seeding to choose your own.`,
      );
    }
    return 0;
  } finally {
    handle.close();
  }
}

/** Convenience for tests and for `apps/api`: the seeded shop, or null. */
export function findShopByName(handle: DatabaseHandle, name: string): { id: string } | undefined {
  return handle.db.select({ id: shops.id }).from(shops).where(eq(shops.name, name)).get();
}

if (isEntryPoint(import.meta.url)) {
  let code = 0;
  try {
    code = seedCommand();
  } catch (error) {
    code = fail(error);
  }
  process.exit(code);
}
