import { pool } from '../db/pool';

export async function deadLetter(payload: any, reason: string): Promise<void> {
  await pool.query(
    `INSERT INTO dead_letter (payload, reason) VALUES ($1, $2)`,
    [JSON.stringify(payload), reason],
  );
}
