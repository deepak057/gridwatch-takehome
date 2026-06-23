import { pool } from './pool';
import { runMigrations } from './migrate';

afterAll(async () => {
  await pool.end();
});

describe('runMigrations', () => {
  it('creates connector_status table', async () => {
    await runMigrations(pool);
    const res = await pool.query(`SELECT to_regclass('public.connector_status') AS cls`);
    expect(res.rows[0].cls).not.toBeNull();
  }, 30_000);

  it('connector_status has composite PK (charger_id, connector_id) both text', async () => {
    const res = await pool.query(`
      SELECT c.column_name, c.data_type
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.columns c
        ON c.table_schema = kcu.table_schema
        AND c.table_name = kcu.table_name
        AND c.column_name = kcu.column_name
      WHERE tc.constraint_type = 'PRIMARY KEY'
        AND tc.table_schema = 'public'
        AND tc.table_name = 'connector_status'
      ORDER BY kcu.ordinal_position
    `);
    const cols = res.rows.map((r: { column_name: string; data_type: string }) => ({
      name: r.column_name,
      type: r.data_type,
    }));
    expect(cols).toHaveLength(2);
    expect(cols[0]).toEqual({ name: 'charger_id', type: 'text' });
    expect(cols[1]).toEqual({ name: 'connector_id', type: 'text' });
  });

  it('runMigrations is idempotent (second run does not throw)', async () => {
    await expect(runMigrations(pool)).resolves.not.toThrow();
  });
});
