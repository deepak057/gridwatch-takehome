import { pool } from '../db/pool';

export interface StatusCount {
  status: string;
  count: number;
}

// statusRollup: for each connector belonging to the given site, determines the
// EFFECTIVE status. A connector with no status row OR whose updated_at is older
// than stalenessSeconds counts as 'Unknown'. Otherwise uses the stored status.
// Groups by effective status and returns counts.
export async function statusRollup(
  siteId: string,
  stalenessSeconds = 60,
): Promise<StatusCount[]> {
  const { rows } = await pool.query<StatusCount>(
    `SELECT
       CASE
         WHEN cs.status IS NULL
              OR cs.updated_at < now() - ($2 || ' seconds')::interval
         THEN 'Unknown'
         ELSE cs.status
       END AS status,
       count(*)::int AS count
     FROM connectors cn
     JOIN chargers c ON c.charger_id = cn.charger_id
     LEFT JOIN connector_status cs
            ON cs.charger_id = cn.charger_id
           AND cs.connector_id = cn.connector_id
     WHERE c.site_id = $1
     GROUP BY 1`,
    [siteId, stalenessSeconds],
  );

  return rows;
}
