import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from './helpers.js';

test('health answers on a migrated PGlite database', async () => {
  const app = await testApp();
  try {
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true, driver: 'pglite' });
    const tables = await app.database.db.execute(
      "select tablename from pg_tables where schemaname = 'public' order by 1",
    );
    const names = tables.rows.map((r) => r.tablename);
    for (const t of ['users', 'devices', 'device_logins', 'clips', 'posts', 'reactions', 'events']) {
      assert.ok(names.includes(t), `missing table ${t}`);
    }
  } finally {
    await app.close();
  }
});
