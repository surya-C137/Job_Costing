import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/node_modules/**',
      'packages/db/seed/**',
      'packages/calc/test/fixtures/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    /* packages/calc is a pure library: config in, result out (CLAUDE.md).
       No I/O, no clock, no logging - these rules make that mechanical rather
       than a matter of reviewer memory. */
    files: ['packages/calc/src/**/*.ts'],
    rules: {
      'no-console': 'error',
      'no-restricted-globals': [
        'error',
        { name: 'Date', message: 'calc must be deterministic - pass dates in via config.' },
        { name: 'process', message: 'calc has no environment access.' },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'fs', 'path', 'crypto', 'os', 'http', 'https'],
              message: 'calc has zero runtime dependencies and does no I/O.',
            },
          ],
        },
      ],
    },
  },
  {
    /* The db package's command-line entry points. `db:migrate` and `db:seed`
       report what they did to whoever ran them - a seed that prints nothing is
       a seed you cannot tell from a no-op. */
    files: ['packages/db/src/cli.ts', 'packages/db/src/{migrate,seed,seed-blank}.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    /* Build and tooling scripts run in Node and are meant to print. Declaring
       the globals here rather than pulling in `globals` keeps the dependency
       list short; extend the list if a script needs more. */
    files: ['**/*.config.{js,ts}', 'scripts/**'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        __dirname: 'readonly',
        URL: 'readonly',
      },
    },
    rules: { 'no-console': 'off' },
  },
  prettier,
);
