import { pool } from '../db/pool';
import { seedCatalogue } from '../geo/geocoder';
import { nearestAvailableCharger } from './nearest';

beforeAll(async () => {
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ||
    'postgres://gridwatch:gridwatch@localhost:5432/gridwatch';
});

afterAll(async () => {
  // pool is shared; do not end it here
});

describe('nearestAvailableCharger', () => {
  beforeEach(async () => {
    await pool.query('TRUNCATE connector_status CASCADE');
    await pool.query('TRUNCATE connectors CASCADE');
    await pool.query('TRUNCATE chargers CASCADE');
    await pool.query('TRUNCATE sites CASCADE');
    await pool.query('TRUNCATE operators CASCADE');
    await seedCatalogue();
  });

  it('returns S-IN-0007 (Noida) for a point near Noida when it is closest and Available', async () => {
    // Set C-IN-0007-A/1 = Available (Noida), C-IN-0012-A/1 = Available (Bengaluru), C-DE-0003-A/1 = Charging
    await pool.query(
      `INSERT INTO connector_status (charger_id, connector_id, status, event_ts)
       VALUES ('C-IN-0007-A', '1', 'Available', now()),
              ('C-IN-0012-A', '1', 'Available', now()),
              ('C-DE-0003-A', '1', 'Charging', now())
       ON CONFLICT (charger_id, connector_id) DO UPDATE
         SET status = EXCLUDED.status, event_ts = EXCLUDED.event_ts, updated_at = now()`,
    );

    // Query from near Noida (lat 28.57, lng 77.33)
    const result = await nearestAvailableCharger(28.57, 77.33);

    expect(result).not.toBeNull();
    expect(result!.site_id).toBe('S-IN-0007');
    expect(result!.charger_id).toBe('C-IN-0007-A');
    expect(result!.distance_m).toBeGreaterThan(0);
    // Noida site is ~3 km away; Bengaluru is ~1700 km away
    expect(result!.distance_m).toBeLessThan(10_000);
  });

  it('returns Stuttgart charger when only Stuttgart is Available (filters by availability not just distance)', async () => {
    // Only C-DE-0003-A/1 is Available; Noida and Bengaluru are Charging
    await pool.query(
      `INSERT INTO connector_status (charger_id, connector_id, status, event_ts)
       VALUES ('C-IN-0007-A', '1', 'Charging', now()),
              ('C-IN-0012-A', '1', 'Charging', now()),
              ('C-DE-0003-A', '1', 'Available', now())
       ON CONFLICT (charger_id, connector_id) DO UPDATE
         SET status = EXCLUDED.status, event_ts = EXCLUDED.event_ts, updated_at = now()`,
    );

    // Query from near Noida — Stuttgart is far but the only Available charger
    const result = await nearestAvailableCharger(28.57, 77.33);

    expect(result).not.toBeNull();
    expect(result!.site_id).toBe('S-DE-0003');
    expect(result!.charger_id).toBe('C-DE-0003-A');
  });

  it('returns null when no chargers are Available', async () => {
    await pool.query(
      `INSERT INTO connector_status (charger_id, connector_id, status, event_ts)
       VALUES ('C-IN-0007-A', '1', 'Charging', now())
       ON CONFLICT (charger_id, connector_id) DO UPDATE
         SET status = EXCLUDED.status, event_ts = EXCLUDED.event_ts, updated_at = now()`,
    );

    const result = await nearestAvailableCharger(28.57, 77.33);
    expect(result).toBeNull();
  });
});
