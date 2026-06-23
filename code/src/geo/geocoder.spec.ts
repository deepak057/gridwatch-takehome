import { pool } from '../db/pool';
import { seedCatalogue } from './geocoder';

beforeAll(async () => {
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ||
    'postgres://gridwatch:gridwatch@localhost:5432/gridwatch';
});

afterAll(async () => {
  // pool is shared; do not end it here
});

describe('geocoder - seedCatalogue', () => {
  beforeEach(async () => {
    await pool.query('TRUNCATE connector_status CASCADE');
    await pool.query('TRUNCATE connectors CASCADE');
    await pool.query('TRUNCATE chargers CASCADE');
    await pool.query('TRUNCATE sites CASCADE');
    await pool.query('TRUNCATE operators CASCADE');
  });

  it('inserts S-IN-0007 with correct PostGIS geometry within 0.001 degrees', async () => {
    await seedCatalogue();

    const { rows } = await pool.query<{ lat: number; lng: number }>(
      `SELECT ST_Y(geom::geometry) AS lat, ST_X(geom::geometry) AS lng
       FROM sites WHERE site_id = 'S-IN-0007'`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].lat).toBeCloseTo(28.5709, 3);
    expect(rows[0].lng).toBeCloseTo(77.3260, 3);
  });

  it('inserts all 3 sites, 4 chargers, and 6 connectors', async () => {
    await seedCatalogue();

    const { rows: sites } = await pool.query('SELECT count(*)::int AS c FROM sites');
    const { rows: chargers } = await pool.query('SELECT count(*)::int AS c FROM chargers');
    const { rows: connectors } = await pool.query('SELECT count(*)::int AS c FROM connectors');

    expect(sites[0].c).toBe(3);
    chargers && expect(chargers[0].c).toBe(4);
    connectors && expect(connectors[0].c).toBe(6);
  });

  it('geocoded_at is set and geocode_source is "seed"', async () => {
    await seedCatalogue();

    const { rows } = await pool.query(
      `SELECT geocoded_at, geocode_source FROM sites WHERE site_id = 'S-DE-0003'`,
    );
    expect(rows[0].geocode_source).toBe('seed');
    expect(rows[0].geocoded_at).not.toBeNull();
  });
});
