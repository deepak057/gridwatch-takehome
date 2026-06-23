import { pool } from '../db/pool';
import { NormalEvent } from './normalise';
import { reconcile } from './reconcile';

export async function ingest(
  events: NormalEvent[],
): Promise<{ accepted: number; duplicate: number }> {
  let accepted = 0;
  let duplicate = 0;

  for (const event of events) {
    const { rows } = await pool.query(
      `INSERT INTO raw_events (dedup_key, source, payload, origin_ts)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (dedup_key) DO NOTHING
       RETURNING id`,
      [event.dedup_key, 'ingest', JSON.stringify(event), event.ts_utc],
    );
    if (rows.length > 0) {
      accepted++;
    } else {
      duplicate++;
    }
  }

  return { accepted, duplicate };
}

export async function drain(): Promise<number> {
  const client = await pool.connect();
  let count = 0;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, payload FROM raw_events
       WHERE processed_at IS NULL
       ORDER BY id
       FOR UPDATE SKIP LOCKED`,
    );

    for (const row of rows) {
      const event = row.payload as NormalEvent;
      await reconcile(event);
      await client.query(
        `UPDATE raw_events SET processed_at = now() WHERE id = $1`,
        [row.id],
      );
      count++;
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return count;
}
