/**
 * The seed files, as a `SeedBundle`.
 *
 * Reading them is the *caller's* job — calc does no I/O — so the test does it
 * with a JSON import and hands over parsed objects. Task 2.1's `seed.ts` will
 * do the same from disk and get the same `ShopConfig`, which is what makes the
 * golden test say something about the database as well as the engine.
 */

import type { SeedBundle } from '../../src/seed.js';
import assemblyStandards from '../../../db/seed/assembly_standards.json' with { type: 'json' };
import blanks from '../../../db/seed/blank_multiples.json' with { type: 'json' };
import coating from '../../../db/seed/coating.json' with { type: 'json' };
import defaults from '../../../db/seed/shop_defaults.json' with { type: 'json' };
import machines from '../../../db/seed/process_presets.json' with { type: 'json' };
import materials from '../../../db/seed/materials.json' with { type: 'json' };
import operations from '../../../db/seed/operations.json' with { type: 'json' };
import plating from '../../../db/seed/plating.json' with { type: 'json' };
import punchTools from '../../../db/seed/punch_rates.json' with { type: 'json' };
import silkscreen from '../../../db/seed/silkscreen.json' with { type: 'json' };

export function seedBundle(): SeedBundle {
  return {
    materials,
    operations,
    machines,
    punchTools,
    plating,
    coating,
    silkscreen,
    assemblyStandards,
    blanks,
    defaults,
  } as unknown as SeedBundle;
}
