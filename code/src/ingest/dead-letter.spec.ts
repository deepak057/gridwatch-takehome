import { pool } from '../db/pool';
import { deadLetter } from './dead-letter';

describe('deadLetter()', () => {
  beforeEach(async () => {
    await pool.query('DELETE FROM dead_letter');
    // Ensure S3 env vars are NOT set for default-path tests
    delete process.env.S3_DEAD_LETTER_BUCKET;
    delete process.env.S3_ENDPOINT;
  });

  it('writes to dead_letter table when S3 env vars are unset', async () => {
    await deadLetter({ foo: 1 }, 'malformed');

    const { rows } = await pool.query(
      `SELECT payload, reason FROM dead_letter`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe('malformed');
    expect(rows[0].payload).toMatchObject({ foo: 1 });
  });

  it('falls back to table when S3_ENDPOINT is unreachable', async () => {
    process.env.S3_DEAD_LETTER_BUCKET = 'gridwatch-dead-letter';
    process.env.S3_ENDPOINT = 'http://127.0.0.1:19999'; // nothing listening here

    await expect(deadLetter({ bar: 2 }, 'test-fallback')).resolves.not.toThrow();

    const { rows } = await pool.query(
      `SELECT reason FROM dead_letter WHERE reason = 'test-fallback'`,
    );
    expect(rows).toHaveLength(1);
  });
});
