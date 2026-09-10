/**
 * Reading `packages/db/seed/*.json` — the workbook extract — into the
 * `SeedBundle` that `shopConfigFromSeed()` takes.
 *
 * This is a boundary: files on disk, written by a Python script, becoming
 * typed objects. CLAUDE.md says Zod at every boundary, and the reason shows up
 * here specifically — a bad extractor run should fail at `db:seed` with the
 * file and field named, not three tasks later as a catalog that prices wrong.
 *
 * The schemas below deliberately mirror `@shopquote/calc`'s `Seed*` interfaces
 * rather than replacing them: calc owns the shape because calc owns the
 * mapping (`shopConfigFromSeed`), and `readSeedBundle()`'s return type is
 * annotated `SeedBundle`, so the type checker fails the build if the two ever
 * drift.
 *
 * Reading the files is *this* package's job, never calc's — calc does no I/O.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import type { SeedBundle } from '@shopquote/calc';

import { seedDir } from './paths.js';

/** A number the extractor may legitimately have been unable to read (§0.2:
 *  "do not guess a value — if a cell is ambiguous, write null"). */
const num = z.number().finite();
const nullableNum = num.nullable();

const materialSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  family: z.string().min(1),
  thickness_in: nullableNum,
  lb_per_sq_ft: num,
  // Nullable: fourteen brushed-stainless rows carry no price in the workbook.
  // A missing price stays missing all the way to the estimator's screen.
  price_per_lb: nullableNum,
  std_length_in: nullableNum,
  speed_in_min: nullableNum,
  pierce_s: nullableNum,
  punch_rate_factor: nullableNum,
  sheet_cost: nullableNum,
  sheet_lbs: nullableNum,
  active: z.boolean(),
});

const operationSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(['machine', 'manual']),
  machine_key: z.string().nullable(),
  setup_hrs: nullableNum,
  standard_per_hr: nullableNum,
  standard_unit: z.enum(['pieces', 'inches', 'sqIn']).nullable(),
  rate_per_hr: nullableNum,
  active: z.boolean(),
});

/** `process_presets.json` is machine rows in all but name — §3 replaced
 *  "process presets" with work centres, and clamp and kerf moved onto the
 *  machine that has them. There is deliberately no `process_presets` table. */
const machineSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  kind: z.string().min(1),
  time_model: z.enum(['featureBased', 'hitBased', 'none']),
  rate_per_hr: nullableNum,
  clamp_in: nullableNum,
  kerf_in: nullableNum,
  load_unload_s_per_blank: nullableNum,
  pallet_change_s: nullableNum,
  pallet_batch_parts: nullableNum,
  intersection_s: nullableNum,
  rapid_s_per_pierce: nullableNum,
  loss_factor: nullableNum,
});

const punchRatesSchema = z.object({
  tools: z.array(
    z.object({
      key: z.string().min(1),
      name: z.string().min(1),
      multiplier: nullableNum,
      hit_rate_per_hr: nullableNum,
    }),
  ),
  load_unload_s_per_blank: num,
});

const platingSchema = z.object({
  key: z.string().min(1),
  spec: z.string().min(1),
  lot_min_charge: nullableNum,
  price_per_sq_in: nullableNum,
  part_min: nullableNum,
  active: z.boolean(),
});

const coatingSchema = z.object({
  models: z.array(
    z.object({
      key: z.string().min(1),
      name: z.string().min(1),
      legacy: z
        .object({ s_constant: nullableNum, coverage: nullableNum, rate: nullableNum })
        .nullable(),
      modern: z.null(),
    }),
  ),
  adders: z.record(z.object({ label: z.string(), rate: nullableNum })),
  liquid_texture_adder_pct: num,
});

const silkscreenSchema = z.object({
  key: z.string().min(1),
  spec: z.string().min(1),
  screen_cost: nullableNum,
  print_cost: nullableNum,
  active: z.boolean(),
});

const assemblySchema = z.object({
  key: z.string().min(1),
  section: z.string().nullable(),
  action: z.string().min(1),
  std_seconds: num,
});

const defaultsSchema = z.object({
  shop_fixed_cost_per_job: num,
  labor_markup: num,
  material_markup: num,
  nre_rate_per_hr: num,
  nre_markup: num,
  min_charge_strip_in: num,
  default_qty_breaks: z.array(num).min(1),
  sheet_widths_in: z.array(num).min(1),
});

const blanksSchema = z.object({
  standard_blank_lengths_in: z.array(num),
  sheet_widths_in: z.array(num).min(1),
});

/** Every seed file, by the property of `SeedBundle` it fills. */
const FILES = {
  materials: 'materials.json',
  operations: 'operations.json',
  machines: 'process_presets.json',
  punchTools: 'punch_rates.json',
  plating: 'plating.json',
  coating: 'coating.json',
  silkscreen: 'silkscreen.json',
  assemblyStandards: 'assembly_standards.json',
  blanks: 'blank_multiples.json',
  defaults: 'shop_defaults.json',
} as const;

function read<T>(dir: string, file: string, schema: z.ZodType<T>): T {
  const path = join(dir, file);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (cause) {
    throw new Error(`Could not read seed file ${path}: ${(cause as Error).message}`, { cause });
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 10)
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `${file} does not match the shape the seed loader expects.\n${issues}\n` +
        `Re-run \`npm run extract-workbook\`; do not hand-edit the seed files.`,
    );
  }
  return parsed.data;
}

/**
 * Read and validate the workbook extract.
 *
 * The return type is calc's `SeedBundle`, which is what makes the schemas
 * above provably in step with the mapping that consumes them.
 */
export function readSeedBundle(dir: string = seedDir): SeedBundle {
  return {
    materials: read(dir, FILES.materials, z.array(materialSchema)),
    operations: read(dir, FILES.operations, z.array(operationSchema)),
    machines: read(dir, FILES.machines, z.array(machineSchema)),
    punchTools: read(dir, FILES.punchTools, punchRatesSchema),
    plating: read(dir, FILES.plating, z.array(platingSchema)),
    coating: read(dir, FILES.coating, coatingSchema),
    silkscreen: read(dir, FILES.silkscreen, z.array(silkscreenSchema)),
    assemblyStandards: read(dir, FILES.assemblyStandards, z.array(assemblySchema)),
    blanks: read(dir, FILES.blanks, blanksSchema),
    defaults: read(dir, FILES.defaults, defaultsSchema),
  };
}
