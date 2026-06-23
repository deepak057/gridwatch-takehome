import { pool } from '../db/pool';
import { NormalEvent } from './normalise';

export async function reconcile(e: NormalEvent): Promise<void> {
  if (e.type === 'status') {
    await pool.query(
      `INSERT INTO connector_status (charger_id, connector_id, status, event_ts, tz_offset)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (charger_id, connector_id) DO UPDATE
         SET status = EXCLUDED.status,
             event_ts = EXCLUDED.event_ts,
             tz_offset = EXCLUDED.tz_offset,
             updated_at = now()
         WHERE EXCLUDED.event_ts > connector_status.event_ts`,
      [e.charger_id, e.connector_id, e.status, e.ts_utc, e.tz_offset],
    );
    return;
  }

  if (e.type === 'session') {
    if (e.event === 'session.start') {
      // Upsert start fields; fetch stop state to compute energy if stop already arrived
      await pool.query(
        `INSERT INTO sessions (session_id, charger_id, connector_id, start_ts, start_meter_wh, updated_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (session_id) DO UPDATE
           SET charger_id = COALESCE(sessions.charger_id, EXCLUDED.charger_id),
               connector_id = COALESCE(sessions.connector_id, EXCLUDED.connector_id),
               start_ts = EXCLUDED.start_ts,
               start_meter_wh = EXCLUDED.start_meter_wh,
               updated_at = now()`,
        [e.session_id, e.charger_id, e.connector_id ?? null, e.ts_utc, e.start_meter_wh ?? null],
      );

      // If stop already arrived and we now have both meters, compute energy
      const { rows } = await pool.query(
        'SELECT stop_meter_wh FROM sessions WHERE session_id = $1',
        [e.session_id],
      );
      const row = rows[0];
      if (row && row.stop_meter_wh != null && e.start_meter_wh != null) {
        const startWh = e.start_meter_wh;
        const stopWh = Number(row.stop_meter_wh);
        if (stopWh < startWh) {
          await pool.query(
            `UPDATE sessions SET anomaly = 'meter_reset', energy_wh = NULL, updated_at = now()
             WHERE session_id = $1`,
            [e.session_id],
          );
        } else {
          await pool.query(
            `UPDATE sessions SET energy_wh = $1, anomaly = NULL, updated_at = now()
             WHERE session_id = $2`,
            [stopWh - startWh, e.session_id],
          );
        }
      }
      return;
    }

    if (e.event === 'session.stop') {
      // Upsert stop fields
      await pool.query(
        `INSERT INTO sessions (session_id, charger_id, connector_id, stop_ts, stop_meter_wh, updated_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (session_id) DO UPDATE
           SET stop_ts = EXCLUDED.stop_ts,
               stop_meter_wh = EXCLUDED.stop_meter_wh,
               updated_at = now()`,
        [e.session_id, e.charger_id, e.connector_id ?? null, e.ts_utc, e.stop_meter_wh ?? null],
      );

      // Compute energy if we have both meters
      const { rows } = await pool.query(
        'SELECT start_meter_wh, stop_meter_wh FROM sessions WHERE session_id = $1',
        [e.session_id],
      );
      const row = rows[0];
      if (row && row.start_meter_wh != null && row.stop_meter_wh != null) {
        const startWh = Number(row.start_meter_wh);
        const stopWh = Number(row.stop_meter_wh);
        if (stopWh < startWh) {
          await pool.query(
            `UPDATE sessions SET anomaly = 'meter_reset', energy_wh = NULL, updated_at = now()
             WHERE session_id = $1`,
            [e.session_id],
          );
        } else {
          await pool.query(
            `UPDATE sessions SET energy_wh = $1, anomaly = NULL, updated_at = now()
             WHERE session_id = $2`,
            [stopWh - startWh, e.session_id],
          );
        }
      } else if (row && row.start_meter_wh == null && e.start_meter_wh != null && row.stop_meter_wh != null) {
        // start_meter_wh provided inline in the stop event (stub 2d provides start_meter_wh on stop)
        const startWh = e.start_meter_wh;
        const stopWh = Number(row.stop_meter_wh);
        await pool.query(
          `UPDATE sessions SET start_meter_wh = $1, updated_at = now() WHERE session_id = $2`,
          [startWh, e.session_id],
        );
        if (stopWh < startWh) {
          await pool.query(
            `UPDATE sessions SET anomaly = 'meter_reset', energy_wh = NULL, updated_at = now()
             WHERE session_id = $1`,
            [e.session_id],
          );
        } else {
          await pool.query(
            `UPDATE sessions SET energy_wh = $1, anomaly = NULL, updated_at = now()
             WHERE session_id = $2`,
            [stopWh - startWh, e.session_id],
          );
        }
      }
      return;
    }
  }

  // meter_value and fault: no state change in this slice
}
