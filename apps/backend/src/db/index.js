// Database handle. Production talks to Railway Postgres through `pg`; local runs and tests
// use PGlite (Postgres compiled to WASM) so nobody needs Docker. Both go through Drizzle
// with the same schema, and `applyMigrations` runs the checked-in SQL either way.
//
//   DATABASE_URL=postgres://...          real Postgres
//   DATABASE_URL=pglite://memory         throwaway in-memory database (tests)
//   DATABASE_URL=pglite://./data/dev     on-disk PGlite under apps/backend/data/dev

import { fileURLToPath } from 'node:url';
import path from 'node:path';

import * as schema from './schema.js';

const migrationsFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');

/**
 * @typedef {object} Database
 * @property {import('drizzle-orm').BaseSQLiteDatabase | any} db  Drizzle instance bound to the schema
 * @property {'pg' | 'pglite'} driver
 * @property {() => Promise<void>} applyMigrations
 * @property {() => Promise<void>} close
 */

/** @returns {Promise<Database>} */
export async function openDatabase(url) {
  if (url.startsWith('pglite://')) {
    const target = url.slice('pglite://'.length);
    const { PGlite } = await import('@electric-sql/pglite');
    const { drizzle } = await import('drizzle-orm/pglite');
    const { migrate } = await import('drizzle-orm/pglite/migrator');
    let client;
    if (target === 'memory' || target === '') {
      client = new PGlite();
    } else {
      // PGlite creates its own directory but not missing parents.
      const { mkdirSync } = await import('node:fs');
      mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
      client = new PGlite(target);
    }
    const db = drizzle(client, { schema });
    return {
      db,
      driver: 'pglite',
      applyMigrations: () => migrate(db, { migrationsFolder }),
      close: () => client.close(),
    };
  }

  const pg = await import('pg');
  const { drizzle } = await import('drizzle-orm/node-postgres');
  const { migrate } = await import('drizzle-orm/node-postgres/migrator');
  const pool = new pg.default.Pool({
    connectionString: url,
    // Railway's public proxy needs TLS; the private network does not offer it.
    ssl: /railway\.internal|localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false },
  });
  const db = drizzle(pool, { schema });
  return {
    db,
    driver: 'pg',
    applyMigrations: () => migrate(db, { migrationsFolder }),
    close: () => pool.end(),
  };
}

export { schema };
