import { pool } from '../db/pool';
import { normalise } from './normalise';
import { ingest } from './inbox';

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://gridwatch:gridwatch@localhost:5432/gridwatch';
});

afterAll(async () => {
  await pool.end();
});

describe('inbox - dedup', () => {
  beforeEach(async () => {
    await pool.query('TRUNCATE raw_events CASCADE');
  });

  it('stub 2b: second delivery of same session.stop is counted as duplicate', async () => {
    const raw = {
      type: 'session',
      charger_id: 'C-DE-0099',
      session_id: 'sess-de-99x',
      event: 'session.stop',
      stop_meter_wh: 5000,
      ts: '2026-06-09T10:00:00+00:00',
    };

    const e1 = normalise(raw, 'test');
    const e2 = normalise(raw, 'test');

    const result = await ingest([e1, e2]);

    expect(result.accepted).toBe(1);
    expect(result.duplicate).toBe(1);

    const { rows } = await pool.query(
      'SELECT count(*)::int AS cnt FROM raw_events WHERE dedup_key = $1',
      [e1.dedup_key],
    );
    expect(rows[0].cnt).toBe(1);
  });
});
