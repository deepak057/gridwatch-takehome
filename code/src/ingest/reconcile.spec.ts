import { pool } from '../db/pool';
import { normalise } from './normalise';
import { ingest, drain } from './inbox';

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://gridwatch:gridwatch@localhost:5432/gridwatch';
});

afterAll(async () => {
  await pool.end();
});

describe('reconcile - out-of-order status (stub 2c)', () => {
  beforeEach(async () => {
    await pool.query('TRUNCATE raw_events CASCADE');
    await pool.query('TRUNCATE connector_status CASCADE');
  });

  const availableRaw = {
    type: 'status',
    charger_id: 'C-IN-0007-A',
    connector_id: '1',
    status: 'Available',
    ts: '2026-06-09T14:33:40+05:30',
  };

  const chargingRaw = {
    type: 'status',
    charger_id: 'C-IN-0007-A',
    connector_id: '1',
    status: 'Charging',
    ts: '2026-06-09T14:31:50+05:30',
  };

  it('available-first, charging-second → Available wins (newest event_ts)', async () => {
    const available = normalise(availableRaw, 'test');
    const charging = normalise(chargingRaw, 'test');

    await ingest([available]);
    await drain();
    await ingest([charging]);
    await drain();

    const { rows } = await pool.query(
      'SELECT status FROM connector_status WHERE charger_id=$1 AND connector_id=$2',
      ['C-IN-0007-A', '1'],
    );
    expect(rows[0].status).toBe('Available');
  });

  it('charging-first, available-second → Available wins (newest event_ts)', async () => {
    const available = normalise(availableRaw, 'test');
    const charging = normalise(chargingRaw, 'test');

    await ingest([charging]);
    await drain();
    await ingest([available]);
    await drain();

    const { rows } = await pool.query(
      'SELECT status FROM connector_status WHERE charger_id=$1 AND connector_id=$2',
      ['C-IN-0007-A', '1'],
    );
    expect(rows[0].status).toBe('Available');
  });
});

describe('reconcile - meter reset (stub 2d)', () => {
  beforeEach(async () => {
    await pool.query('TRUNCATE raw_events CASCADE');
    await pool.query('TRUNCATE sessions CASCADE');
  });

  it('stop_meter_wh < start_meter_wh → anomaly=meter_reset, energy_wh IS NULL', async () => {
    const stopRaw = {
      type: 'session',
      charger_id: 'C-IN-0077',
      session_id: 'sess-in-77c',
      event: 'session.stop',
      start_meter_wh: 12044990,
      stop_meter_wh: 31200,
      ts: '2026-06-09T12:00:00+05:30',
    };

    const stopEvent = normalise(stopRaw, 'test');
    await ingest([stopEvent]);
    await drain();

    const { rows } = await pool.query(
      'SELECT anomaly, energy_wh FROM sessions WHERE session_id=$1',
      ['sess-in-77c'],
    );
    expect(rows[0].anomaly).toBe('meter_reset');
    expect(rows[0].energy_wh).toBeNull();
  });
});

describe('reconcile - normal session energy computation', () => {
  beforeEach(async () => {
    await pool.query('TRUNCATE raw_events CASCADE');
    await pool.query('TRUNCATE sessions CASCADE');
  });

  it('start then stop → energy_wh = stop - start, anomaly IS NULL', async () => {
    const startRaw = {
      type: 'session',
      charger_id: 'C-NORMAL-01',
      session_id: 'sess-normal-test',
      event: 'session.start',
      start_meter_wh: 9930120,
      ts: '2026-06-09T08:00:00+00:00',
    };

    const stopRaw = {
      type: 'session',
      charger_id: 'C-NORMAL-01',
      session_id: 'sess-normal-test',
      event: 'session.stop',
      stop_meter_wh: 9971540,
      ts: '2026-06-09T10:00:00+00:00',
    };

    const startEvent = normalise(startRaw, 'test');
    const stopEvent = normalise(stopRaw, 'test');

    await ingest([startEvent, stopEvent]);
    await drain();

    const { rows } = await pool.query(
      'SELECT energy_wh, anomaly FROM sessions WHERE session_id=$1',
      ['sess-normal-test'],
    );
    expect(Number(rows[0].energy_wh)).toBe(41420);
    expect(rows[0].anomaly).toBeNull();
  });
});
