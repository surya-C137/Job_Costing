import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit, for `npm run db:generate` only.
 *
 * Migrations are generated from `src/schema.ts`, committed, and applied at
 * runtime by `src/migrate.ts`. `drizzle-kit push` is deliberately not part of
 * any script: a shop's database is the shop's quote history, and the way it
 * changes shape is a reviewed SQL file, not a diff computed on the night.
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: 'file:../../data/shopquote.db',
  },
});
