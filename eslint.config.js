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
    files: ['**/*.config.{js,ts}', 'scripts/**'],
    rules: { 'no-console': 'off' },
  },
  prettier,
);
