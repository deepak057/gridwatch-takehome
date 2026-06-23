import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { pool as defaultPool } from './pool';

export async function runMigrations(p: Pool = defaultPool): Promise<void> {
  const migrationsDir = path.resolve(__dirname, '..', '..', 'db', 'migrations');
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    await p.query(sql);
  }
}
