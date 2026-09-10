import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  /* Mirrors the `paths` in tsconfig.base.json so tests and the type checker
     resolve workspace packages the same way — from source, no build step. */
  resolve: {
    alias: {
      '@shopquote/calc': here('./packages/calc/src/index.ts'),
      '@shopquote/db': here('./packages/db/src/index.ts'),
    },
  },
  test: {
    projects: ['packages/*', 'apps/*'],
    /* The scaffold has almost no tests yet; workspaces fill in from Task 1.2
       onward. Without this, `npm test` fails on a workspace that has none. */
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['packages/*/src/**', 'apps/*/src/**'],
      /* Type-only modules. They compile to nothing, so every interface body
         and JSDoc line counts as an uncovered line and drags the threshold
         below — `types/config.ts` alone is ~400 lines with no runtime code in
         it. `types/result.ts` and `types/index.ts` are NOT here: they carry
         `ok()` and `err()`, and are covered. Anything that gains runtime code
         should leave this list. */
      exclude: [
        'packages/calc/src/types/config.ts',
        'packages/calc/src/types/part.ts',
        'packages/calc/src/types/contributor.ts',
      ],
      /* REQUIREMENTS §9 / BUILD-PLAN 1.4: calc carries the parity burden and
         is held to a higher bar than the plumbing around it. */
      thresholds: {
        'packages/calc/src/**': {
          statements: 95,
          branches: 95,
          functions: 95,
          lines: 95,
        },
      },
    },
  },
});
