import { pool } from '../db/pool';
import { seedCatalogue } from '../geo/geocoder';
import { statusRollup } from './status-rollup';

beforeAll(async () => {
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ||
    'postgres://gridwatch:gridwatch@localhost:5432/gridwatch';
});

afterAll(async () => {
  // pool is shared; do not end it here
});

describe('statusRollup', () => {
  beforeEach(async () => {
    await pool.query('TRUNCATE connector_status CASCADE');
    await pool.query('TRUNCATE connectors CASCADE');
    await pool.query('TRUNCATE chargers CASCADE');
    await pool.query('TRUNCATE sites CASCADE');
    await pool.query('TRUNCATE operators CASCADE');
    await seedCatalogue();
  });

  it('counts Available, Charging, and Unknown (no status) correctly for S-IN-0007', async () => {
    // S-IN-0007 has: C-IN-0007-A (connectors 1,2), C-IN-0007-B (connector 1)
    // Set C-IN-0007-A/1=Available, C-IN-0007-A/2=Charging; C-IN-0007-B/1 has NO status row → Unknown
    await pool.query(
      `INSERT INTO connector_status (charger_id, connector_id, status, event_ts)
       VALUES ('C-IN-0007-A', '1', 'Available', now()),
              ('C-IN-0007-A', '2', 'Charging', now())
       ON CONFLICT (charger_id, connector_id) DO UPDATE
         SET status = EXCLUDED.status, event_ts = EXCLUDED.event_ts, updated_at = now()`,
    );

    const result = await statusRollup('S-IN-0007');

    const byStatus = Object.fromEntries(result.map((r) => [r.status, r.count]));
    expect(byStatus['Available']).toBe(1);
    expect(byStatus['Charging']).toBe(1);
    expect(byStatus['Unknown']).toBe(1); // C-IN-0007-B/1 has no status row
  });

  it('counts a stale connector_status row as Unknown', async () => {
    // Set C-IN-0007-A/1 with updated_at older than staleness window (5 minutes ago)
    await pool.query(
      `INSERT INTO connector_status (charger_id, connector_id, status, event_ts, updated_at)
       VALUES ('C-IN-0007-A', '1', 'Available', now() - interval '5 minutes', now() - interval '5 minutes')
       ON CONFLICT (charger_id, connector_id) DO UPDATE
         SET status = EXCLUDED.status, event_ts = EXCLUDED.event_ts,
             updated_at = now() - interval '5 minutes'`,
    );

    // Use staleness window of 60 seconds (default); the row is 5 minutes old → Unknown
    const result = await statusRollup('S-IN-0007', 60);

    const byStatus = Object.fromEntries(result.map((r) => [r.status, r.count]));
    // All 3 connectors should be Unknown (stale or no row)
    expect(byStatus['Unknown']).toBe(3);
    expect(byStatus['Available']).toBeUndefined();
  });

  it('returns empty array for a site with no connectors', async () => {
    // Insert a bare site with no chargers/connectors
    await pool.query(
      `INSERT INTO operators (operator_id, name, country, currency)
       VALUES ('test-op', 'Test Op', 'US', 'USD')
       ON CONFLICT (operator_id) DO NOTHING`,
    );
    await pool.query(
      `INSERT INTO sites (site_id, operator_id, name, address)
       VALUES ('S-EMPTY', 'test-op', 'Empty Site', '1 Test St')
       ON CONFLICT (site_id) DO NOTHING`,
    );

    const result = await statusRollup('S-EMPTY');
    expect(result).toHaveLength(0);
  });
});
