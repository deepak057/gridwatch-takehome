// Runs in every test file. Closes that file's DB pool after its tests finish so the
// process exits cleanly without `forceExit` — no orphaned/locked backends left on the
// server to block the next run. Jest gives each test file its own module registry, so
// each file owns and ends its own pool.
import { pool } from './src/db/pool';

afterAll(async () => {
  await pool.end();
});
