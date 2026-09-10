import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * The db package's own Vitest project, for the same reason calc has one: the
 * root config's `projects: ['packages/*']` globs resolve against Vitest's
 * root, which becomes this directory when run as `npm test -w packages/db`.
 *
 * Unlike calc's, this one *does* alias `@shopquote/calc` — to source, matching
 * `tsconfig.base.json`, so tests run on a clean checkout without a build. The
 * dependency only points this way; calc never resolves back.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@shopquote/calc': fileURLToPath(new URL('../calc/src/index.ts', import.meta.url)),
    },
  },
  test: {
    name: '@shopquote/db',
    include: ['test/**/*.test.ts'],
  },
});
