// drizzle-kit config: `npm run generate` diffs src/db/schema.js against the migrations in
// ./drizzle and writes a new SQL file. Commit those files; they are applied at deploy time.
export default {
  dialect: 'postgresql',
  schema: './src/db/schema.js',
  out: './drizzle',
};
