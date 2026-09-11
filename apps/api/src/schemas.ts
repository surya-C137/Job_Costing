/**
 * Request bodies, parameters and query strings — Zod at the boundary
 * (CLAUDE.md).
 *
 * Catalog bodies are derived from `@shopquote/db`'s entity schemas, which in
 * turn `satisfy` calc's types: one definition of what a material is, from the
 * engine out to the wire. What this file adds is only what belongs to HTTP —
 * no `id` in a body (the path has it), no price on a material edit (prices are
 * versions, §7), and defaults for the fields a "new …" form would leave alone.
 * A PUT is a full replacement, so an omitted field takes its default there too.
 */

import { z } from 'zod';

import {
  assemblyStandardSchema,
  coatingModelSchema,
  enabledModulesSchema,
  materialRowSchema,
  MAX_PASSWORD_LENGTH,
  operationSchema,
  parityFlagsSchema,
  platingSpecSchema,
  ROLES,
  shopDefaultsSchema,
  silkscreenTierSchema,
} from '@shopquote/db';

const amount = z.number().finite().nonnegative();
const instant = z
  .string()
  .datetime({ offset: true, message: 'An ISO-8601 date and time, e.g. 2026-09-01T00:00:00Z.' })
  .transform((value) => new Date(value));

export const idParams = z.object({ id: z.string().min(1).max(64) }).strict();

/* ---- auth and accounts --------------------------------------------------- */

export const loginBody = z
  .object({
    username: z.string().min(1).max(64),
    password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
  })
  .strict();

export const passwordChangeBody = z
  .object({
    currentPassword: z.string().min(1).max(MAX_PASSWORD_LENGTH),
    // Length and the rest are `passwordProblem()`'s to judge, so the message
    // is the same one the Settings screen shows.
    newPassword: z.string(),
  })
  .strict();

export const passwordResetBody = z.object({ newPassword: z.string() }).strict();

export const userCreateBody = z
  .object({
    username: z.string().min(1).max(64),
    password: z.string(),
    role: z.enum(ROLES),
    displayName: z.string().max(200).nullable().default(null),
    email: z.string().email().max(320).nullable().default(null),
  })
  .strict();

export const userUpdateBody = z
  .object({
    displayName: z.string().max(200).nullable(),
    email: z.string().email().max(320).nullable(),
    role: z.enum(ROLES),
  })
  .strict();

/* ---- config -------------------------------------------------------------- */

export const asOfQuery = z.object({ asOf: instant.optional() }).strict();

export const importQuery = z
  .object({
    dryRun: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
  })
  .strict();

/** The Settings "Shop" page. The catalogs are not in it on purpose — see
 *  `updateShopSettings()`; a whole-catalog replace is an import. */
export const shopSettingsBody = z
  .object({
    defaults: shopDefaultsSchema,
    parity: parityFlagsSchema,
    enabledModules: enabledModulesSchema,
  })
  .strict();

/* ---- catalogs ------------------------------------------------------------ */

/** A new price version (§7). `effectiveFrom` defaults to now; it may be in the
 *  future, for an increase a supplier has announced. */
export const priceBody = z
  .object({
    pricePerLbUsd: amount,
    sheetCostUsd: amount.nullable().default(null),
    sheetLbs: amount.nullable().default(null),
    effectiveFrom: instant.optional(),
    note: z.string().max(500).nullable().default(null),
  })
  .strict();

/** Fields a material edit may not carry: they belong to a price version. */
export const PRICE_FIELDS = ['pricePerLbUsd', 'sheetCostUsd', 'sheetLbs'] as const;

export const materialBody = materialRowSchema
  .omit({ id: true, pricePerLbUsd: true, sheetCostUsd: true, sheetLbs: true })
  .extend({
    form: materialRowSchema.shape.form.default('sheet'),
    surchargePct: amount.default(0),
    scrapPricePerLbUsd: amount.default(0),
    aliases: materialRowSchema.shape.aliases.default([]),
    active: z.boolean().default(true),
  });

/** A new material may arrive with its first price. */
export const materialCreateBody = materialBody.extend({ price: priceBody.optional() });

export const operationBody = operationSchema.omit({ id: true }).extend({
  machineId: operationSchema.shape.machineId.default(null),
  setupHrs: amount.default(0),
  standardPerHr: operationSchema.shape.standardPerHr.default(null),
  standardUnit: operationSchema.shape.standardUnit.default(null),
  ratePerHrUsd: operationSchema.shape.ratePerHrUsd.default(null),
  active: z.boolean().default(true),
});

export const platingBody = platingSpecSchema.omit({ id: true }).extend({
  aliases: platingSpecSchema.shape.aliases.default([]),
  lotMinimumUsd: amount.default(0),
  partMinimumUsd: amount.default(0),
  rohsCompliant: platingSpecSchema.shape.rohsCompliant.default(null),
  active: z.boolean().default(true),
});

export const coatingBody = coatingModelSchema.omit({ id: true }).extend({
  minimumChargeUsd: amount.default(0),
  legacy: coatingModelSchema.shape.legacy.default(null),
  modern: coatingModelSchema.shape.modern.default(null),
});

export const silkscreenBody = silkscreenTierSchema.omit({ id: true }).extend({
  screenCostUsd: silkscreenTierSchema.shape.screenCostUsd.default(null),
  active: z.boolean().default(true),
});

export const assemblyBody = assemblyStandardSchema.omit({ id: true }).extend({
  section: assemblyStandardSchema.shape.section.default(null),
});
