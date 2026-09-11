import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * The API's own Vitest project, for the reason calc and db have one: run as
 * `npm test -w apps/api`, the root config's project globs resolve against this
 * directory. Both workspace dependencies resolve to source, matching
 * `tsconfig.base.json`, so the tests need no build.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@shopquote/calc': fileURLToPath(
        new URL('../../packages/calc/src/index.ts', import.meta.url),
      ),
      '@shopquote/db': fileURLToPath(new URL('../../packages/db/src/index.ts', import.meta.url)),
    },
  },
  test: {
    name: '@shopquote/api',
    include: ['test/**/*.test.ts'],
  },
});
