#!/usr/bin/env node
/**
 * Generate `docs/parity-report.md` — BUILD-PLAN Task 1.5.
 *
 * Prices the REQUIREMENTS §9 part with every parity flag on (the workbook),
 * then with each one switched off on its own, and tabulates the difference.
 * This is the document to put in front of the owner when asking §10 questions
 * 1–3: it turns "what does the ×60 mean?" into "here is what the quote costs
 * either way".
 *
 * Regenerate after any change to the engine or the seed:
 *
 *     npm run build && npm run parity-report
 *
 * It imports the built package rather than the source, so what it reports is
 * what the app would actually quote.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  computeQuote,
  machineId,
  materialId,
  operationId,
  shopConfigFromSeed,
} from '@shopquote/calc';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const seedFile = (name) => readJson(`packages/db/seed/${name}.json`);

const golden = readJson('packages/calc/test/fixtures/golden-workbook.json');

const seed = {
  materials: seedFile('materials'),
  operations: seedFile('operations'),
  machines: seedFile('process_presets'),
  punchTools: seedFile('punch_rates'),
  plating: seedFile('plating'),
  coating: seedFile('coating'),
  silkscreen: seedFile('silkscreen'),
  assemblyStandards: seedFile('assembly_standards'),
  blanks: seedFile('blank_multiples'),
  defaults: seedFile('shop_defaults'),
};

const base = shopConfigFromSeed(seed);

/**
 * Powder parameters for the Q3 "off" path.
 *
 * The workbook has no source for any of these — that is the whole of §10
 * question 2 — so they are trade-typical placeholders, and the Q3 row moves
 * the moment the owner gives real ones. Recorded in the report itself so
 * nobody mistakes the number for a measurement.
 */
const ASSUMED_POWDER = {
  specificGravity: 1.5,
  filmThicknessMils: 2,
  transferEfficiency: 0.6,
  powderPricePerLbUsd: 5,
  rackLaborUsdPerPart: 0.1,
  maskingUsdPerFeature: 0.05,
};

const COATING_ID = 'coating:powder-smooth-or-textured';

function goldenPart() {
  return {
    id: 'part-g30',
    partNumber: 'G30-GOLDEN',
    materialId: materialId('g30-16-ga-0598'),
    flatLengthIn: golden.part.flat_length_in,
    flatWidthIn: golden.part.flat_width_in,
    nesting: {
      machineId: machineId('laser'),
      stockWidthIn: golden.nesting.stock_width_in,
      blankLengthIn: golden.nesting.blank_length_in,
    },
    cutting: {
      model: 'featureBased',
      features: [],
      perimeterCutIn: golden.laser.perimeter_cut_in,
      intersections: golden.laser.intersections,
    },
    operations: [{ operationId: operationId('laser'), countPerPart: 1 }],
    finish: { coating: { coatingModelId: COATING_ID, sidesCoated: 2, maskedFeatures: 0 } },
    hardware: [],
    nre: [],
  };
}

const withModernPowder = (config) => ({
  ...config,
  coatingModels: config.coatingModels.map((c) =>
    c.id === COATING_ID ? { ...c, modern: ASSUMED_POWDER } : c,
  ),
});

function pricesFor(config) {
  const result = computeQuote(
    { parts: [goldenPart()], quantityBreaks: [...golden.quantity_breaks] },
    config,
  );
  return result.parts[0].breaks.map((b) => b.sellingPriceUsd);
}

/** Each flag, switched off on its own. */
const SCENARIOS = [
  {
    flag: 'Q1',
    field: 'markupInsideMinChargeMax',
    title: 'Material markup inside the minimum-charge MAX',
    config: () => ({ ...base, parity: { ...base.parity, markupInsideMinChargeMax: false } }),
    question: '§10 q1',
    sentence:
      'Only the quantity-1 price moves, and it moves down by $2.07. The minimum charge ' +
      'is compared against a 1.2 markup that the material block then applies a second ' +
      'time, so at a quantity of one the shop bills the 12-inch strip at 1.44× rather ' +
      'than 1.2×. Above a quantity of one the nest beats the minimum and the flag has ' +
      'no effect at all.',
  },
  {
    flag: 'Q2',
    field: 'machineTimeFactor',
    title: 'Machine time billed at 0.6×',
    config: () => ({ ...base, parity: { ...base.parity, machineTimeFactor: 1 } }),
    question: '§10 q1',
    sentence:
      'Every price rises by $0.25, the same at every break, because laser time goes ' +
      'from 0.6× to 1.0× of the machine hours: $0.3135 of direct labour becomes ' +
      '$0.5225, and the labour markup turns the $0.209 difference into $0.251. If the ' +
      '×60 was ever meant as "the laser runs unattended, bill 60% of the time", it is ' +
      'a 6% discount on this part.',
  },
  {
    flag: 'Q3',
    field: 'legacyCoatingModel',
    title: 'Powder coat priced off the perimeter',
    config: () => ({
      ...withModernPowder(base),
      parity: { ...base.parity, legacyCoatingModel: false },
    }),
    question: '§10 q2',
    sentence:
      'Every price falls by $0.77, because the workbook charges $1.06 to coat a part ' +
      'whose two faces are 1.46 sq ft — where powder at the assumed price and coverage ' +
      'costs $0.19 plus $0.10 of racking. The workbook is either carrying a lot of ' +
      'overhead in that number or the constants mean something nobody has written down. ' +
      'This row is the least certain in the table: it moves with the assumed powder ' +
      'parameters below.',
  },
  {
    flag: 'Q4',
    field: 'finishesUnmarked',
    title: 'Coating and silkscreen added after markups',
    config: () => ({ ...base, parity: { ...base.parity, finishesUnmarked: false } }),
    question: '—',
    sentence:
      'Every price rises by $0.21, the coating markup the workbook never charges. ' +
      'Turning this off moves coating into the material block beside plating, which is ' +
      'the other bought finishing service already marked up — so the shop makes margin ' +
      'on coating the way it does on plating and steel.',
  },
];

const money = (v) => v.toFixed(4);
const signed = (v) => (Math.abs(v) < 5e-5 ? '—' : `${v > 0 ? '+' : '−'}$${Math.abs(v).toFixed(4)}`);

const baseline = pricesFor(base);
const breaks = golden.quantity_breaks;

const rows = SCENARIOS.map((scenario) => {
  const prices = pricesFor(scenario.config());
  return { ...scenario, prices, deltas: prices.map((p, i) => p - baseline[i]) };
});

const lines = [];
lines.push('# Parity report');
lines.push('');
lines.push(
  '_Generated by `scripts/parity-report.mjs`. Regenerate with `npm run build && npm run parity-report`._',
);
lines.push('');
lines.push(
  'What the REQUIREMENTS §9 part costs with the workbook’s quirks reproduced, and what ' +
    'it would cost with each one switched off. Every flag defaults to the workbook and the ' +
    'golden test runs with all of them on; this is the evidence for asking the owner ' +
    'whether any of them should change (§10 questions 1–3).',
);
lines.push('');
lines.push(
  `The part: \`${golden.material.name}\`, ${golden.part.flat_length_in} × ` +
    `${golden.part.flat_width_in} in, laser cut, ${golden.nesting.stock_width_in} in stock ` +
    `at a ${golden.nesting.blank_length_in} in blank, powder coated both faces.`,
);
lines.push('');

lines.push('## Selling price, all quantities');
lines.push('');
lines.push(`| Scenario | ${breaks.map((q) => `qty ${q}`).join(' | ')} |`);
lines.push(`|---|${breaks.map(() => '---:').join('|')}|`);
lines.push(`| **Workbook (all flags on)** | ${baseline.map((p) => `$${money(p)}`).join(' | ')} |`);
for (const row of rows) {
  lines.push(`| ${row.flag} off | ${row.prices.map((p) => `$${money(p)}`).join(' | ')} |`);
}
lines.push('');

lines.push('## Difference from the workbook');
lines.push('');
lines.push(`| Flag | What it does | ${breaks.map((q) => `qty ${q}`).join(' | ')} | Owner |`);
lines.push(`|---|---|${breaks.map(() => '---:').join('|')}|---|`);
for (const row of rows) {
  lines.push(
    `| **${row.flag}** | ${row.title} | ${row.deltas.map(signed).join(' | ')} | ${row.question} |`,
  );
}
lines.push('');

lines.push('## One sentence each');
lines.push('');
for (const row of rows) {
  lines.push(`**${row.flag} — ${row.title}** (\`parity.${row.field}\`)`);
  lines.push('');
  lines.push(row.sentence);
  lines.push('');
}

lines.push('## What Q3’s "off" number assumes');
lines.push('');
lines.push(
  'The workbook has no source for a single powder parameter — that is §10 question 2 — so ' +
    'the Q3 row is priced with trade-typical placeholders and will move once the owner ' +
    'gives real ones. Coverage follows the powder industry’s formula, ' +
    '`192.3 ÷ specific gravity ÷ film mils × transfer efficiency`:',
);
lines.push('');
lines.push('| Input | Assumed | Where a real number comes from |');
lines.push('|---|---:|---|');
lines.push(
  `| Specific gravity | ${ASSUMED_POWDER.specificGravity} | the powder’s data sheet |`,
);
lines.push(`| Film build | ${ASSUMED_POWDER.filmThicknessMils} mils | the finish spec |`);
lines.push(
  `| Transfer efficiency | ${(ASSUMED_POWDER.transferEfficiency * 100).toFixed(0)}% | the booth; 50–80% first-pass, higher with reclaim |`,
);
lines.push(`| Powder price | $${ASSUMED_POWDER.powderPricePerLbUsd.toFixed(2)}/lb | the supplier |`);
lines.push(
  `| Rack / hang labour | $${ASSUMED_POWDER.rackLaborUsdPerPart.toFixed(2)}/part | the shop |`,
);
lines.push(
  `| Masking | $${ASSUMED_POWDER.maskingUsdPerFeature.toFixed(2)}/feature | the shop (this part masks nothing) |`,
);
lines.push('');
lines.push(
  `That gives ${(
    192.3 /
    ASSUMED_POWDER.specificGravity /
    ASSUMED_POWDER.filmThicknessMils *
    ASSUMED_POWDER.transferEfficiency
  ).toFixed(2)} sq ft per pound.`,
);
lines.push('');

lines.push('## Notes');
lines.push('');
lines.push(
  '- **Q5 is not in this table.** Kerf became a machine-row field rather than a parity ' +
    'flag (§5.7): it is a number that differs between two shops in the same trade, so it ' +
    'is Settings data. A fibre shop types 0.375 and re-quotes.',
);
lines.push(
  '- **Every flag is off on its own here**, never in combination. Q1 and Q2 both touch the ' +
    'quantity-1 price and would not simply add.',
);
lines.push(
  '- **Nothing in this table is a recommendation.** The workbook is the shop’s pricing ' +
    'until the owner says otherwise; §11 is explicit that parity comes first and changes ' +
    'arrive as data or as flags, never as a silent edit.',
);
lines.push('');

const out = join(ROOT, 'docs/parity-report.md');
writeFileSync(out, lines.join('\n') + '\n', 'utf8');

console.log('Wrote docs/parity-report.md\n');
console.log(['flag'.padEnd(8), ...breaks.map((q) => String(q).padStart(10))].join(''));
console.log(['on'.padEnd(8), ...baseline.map((p) => money(p).padStart(10))].join(''));
for (const row of rows) {
  console.log([`${row.flag} off`.padEnd(8), ...row.prices.map((p) => money(p).padStart(10))].join(''));
}
