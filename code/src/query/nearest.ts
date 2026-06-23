import { pool } from '../db/pool';

export interface NearestChargerResult {
  charger_id: string;
  site_id: string;
  distance_m: number;
}

// nearestAvailableCharger uses PostGIS KNN operator (<->) on the GiST-indexed
// geography column for index-accelerated nearest-neighbour search.
// The WHERE cs.status = 'Available' filter is applied AFTER the KNN ordering,
// so only chargers with at least one Available connector are returned.
export async function nearestAvailableCharger(
  lat: number,
  lng: number,
): Promise<NearestChargerResult | null> {
  const { rows } = await pool.query<NearestChargerResult>(
    `SELECT c.charger_id, s.site_id,
            ST_Distance(s.geom, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) AS distance_m
     FROM connector_status cs
     JOIN chargers c ON c.charger_id = cs.charger_id
     JOIN sites s   ON s.site_id   = c.site_id
     WHERE cs.status = 'Available'
     ORDER BY s.geom <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
     LIMIT 1`,
    [lng, lat],
  );

  return rows[0] ?? null;
}
