// Applies the checked-in SQL migrations under apps/backend/drizzle/. Railway runs this as the
// backend's pre-deploy command (`npm run migrate`); it is also safe to run by hand.

import { loadConfig } from '../config.js';
import { openDatabase } from './index.js';

const config = loadConfig();
const database = await openDatabase(config.DATABASE_URL);
try {
  await database.applyMigrations();
  console.log(`migrations applied (${database.driver})`);
} finally {
  await database.close();
}
