import { defineConfig } from 'vitest/config';

/**
 * Calc's own Vitest project.
 *
 * The root config lists `projects: ['packages/*', 'apps/*']`, and those globs
 * resolve against whatever directory Vitest is rooted at. Run from the repo
 * root that finds every workspace; run as `npm test -w packages/calc` — which
 * BUILD-PLAN's per-task acceptance checks use — the root becomes this package
 * and the globs match nothing. A config here gives the workspace a root of its
 * own, so both commands work.
 *
 * No `resolve.alias` for `@shopquote/*`: calc depends on nothing, and a path
 * back to a sibling package is exactly what must never resolve from here.
 */
export default defineConfig({
  test: {
    name: '@shopquote/calc',
    include: ['test/**/*.test.ts'],
  },
});
