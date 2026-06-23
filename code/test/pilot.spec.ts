import { pool } from '../src/db/pool';
import { normalise } from '../src/ingest/normalise';
import { ingest, drain } from '../src/ingest/inbox';
import { pollSite } from '../src/ingest/csms-client';
import { seedCatalogue } from '../src/geo/geocoder';
import { nearestAvailableCharger } from '../src/query/nearest';
import { statusRollup } from '../src/query/status-rollup';

beforeAll(async () => {
  process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://gridwatch:gridwatch@localhost:5432/gridwatch';

  // FK-safe truncate order
  await pool.query('TRUNCATE connector_status CASCADE');
  await pool.query('TRUNCATE sessions CASCADE');
  await pool.query('TRUNCATE raw_events CASCADE');
  await pool.query('TRUNCATE dead_letter CASCADE');
  await pool.query('TRUNCATE connectors CASCADE');
  await pool.query('TRUNCATE chargers CASCADE');
  await pool.query('TRUNCATE sites CASCADE');
  await pool.query('TRUNCATE operators CASCADE');

  await seedCatalogue();
});

afterAll(async () => {
  // pool teardown handled by jest.setup.ts
});

describe('Pilot E2E — stub 2b: normal session + duplicate stop', () => {
  it('ingest start+stop+duplicate_stop → exactly 1 raw_events row for stop, energy_wh=41420', async () => {
    const startRaw = {
      type: 'session',
      charger_id: 'C-DE-0003-A',
      session_id: 'sess-de-99x',
      event: 'session.start',
      start_meter_wh: 9930120,
      ts: '2026-06-09T08:00:00+00:00',
    };

    const stopRaw = {
      type: 'session',
      charger_id: 'C-DE-0003-A',
      session_id: 'sess-de-99x',
      event: 'session.stop',
      stop_meter_wh: 9971540,
      ts: '2026-06-09T10:00:00+00:00',
    };

    const startEvent = normalise(startRaw, 'test');
    const stopEvent = normalise(stopRaw, 'test');
    const stopEventDup = normalise(stopRaw, 'test');

    // Ingest start, stop, and duplicate stop
    await ingest([startEvent, stopEvent, stopEventDup]);
    await drain();

    // Exactly one raw_events row for the stop's dedup_key
    const { rows: dedupRows } = await pool.query(
      'SELECT count(*)::int AS cnt FROM raw_events WHERE dedup_key = $1',
      [stopEvent.dedup_key],
    );
    expect(dedupRows[0].cnt).toBe(1);

    // Energy computed correctly
    const { rows: sessRows } = await pool.query(
      'SELECT energy_wh, anomaly FROM sessions WHERE session_id = $1',
      ['sess-de-99x'],
    );
    expect(Number(sessRows[0].energy_wh)).toBe(41420);
    expect(sessRows[0].anomaly).toBeNull();
  });
});

describe('Pilot E2E — stub 2c: out-of-order status', () => {
  it('Available@14:33:40 wins over Charging@14:31:50 regardless of ingest order', async () => {
    // Ingest Available THEN Charging (reverse chronological order)
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

    const available = normalise(availableRaw, 'test');
    const charging = normalise(chargingRaw, 'test');

    // Ingest Available first, then Charging (out of chronological order for the second)
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
});

describe('Pilot E2E — stub 2d: meter reset', () => {
  it('stop_meter_wh(31200) < start_meter_wh(12044990) → anomaly=meter_reset, energy_wh IS NULL', async () => {
    const stopRaw = {
      type: 'session',
      charger_id: 'C-IN-0007-A',
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

describe('Pilot E2E — stub 1e: malformed page from pollSite', () => {
  it('valid event ingested, malformed event in dead_letter, pollSite does not throw', async () => {
    // Clear dead_letter before this assertion
    await pool.query('TRUNCATE dead_letter CASCADE');

    const since = '2026-06-09T00:00:00+00:00';

    // One valid meter_value event + one malformed event (missing connector_id and status, wrong type triggers normalise failure)
    const validEvent = {
      type: 'meter_value',
      charger_id: 'C-IN-0007-B',
      connector_id: '1',
      energy_register_wh: null,
      ts: '2026-06-09T11:00:00+05:30',
    };

    // Malformed: type=status but missing connector_id and status fields
    const malformedEvent = {
      type: 'status',
      charger_id: 'C-IN-0007-B',
      // connector_id intentionally absent
      // status intentionally absent
      ts: '2026-06-09T11:01:00+05:30',
    };

    const fetchPage = async (_siteId: string, _since: string, _cursor?: string) => ({
      status: 200,
      headers: {},
      body: {
        events: [validEvent, malformedEvent],
        // no next_cursor → single page
      },
    });

    let threw = false;
    let result: { ingested: number; deadLettered: number; retries: number } | undefined;
    try {
      result = await pollSite('S-IN-0007', since, { fetchPage, sleep: async () => {} });
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(result?.deadLettered).toBe(1);

    const { rows: dlRows } = await pool.query(
      'SELECT count(*)::int AS cnt FROM dead_letter',
    );
    expect(dlRows[0].cnt).toBe(1);
  });
});

describe('Pilot E2E — status rollup for S-IN-0007', () => {
  it('returns Available count >= 1 after stub 2c set C-IN-0007-A/1 to Available', async () => {
    // C-IN-0007-A connector 1 was set to Available by stub 2c above.
    // statusRollup with a generous staleness window so updated_at doesn't expire.
    const rollup = await statusRollup('S-IN-0007', 3600);

    const availableRow = rollup.find((r) => r.status === 'Available');
    expect(availableRow).toBeDefined();
    expect(availableRow!.count).toBeGreaterThanOrEqual(1);
  });
});

describe('Pilot E2E — nearest available charger', () => {
  it('nearestAvailableCharger(28.57, 77.33) returns S-IN-0007', async () => {
    // C-IN-0007-A/1 is Available (set in stub 2c). The Noida site is at ~28.57, 77.33.
    const result = await nearestAvailableCharger(28.57, 77.33);
    expect(result).not.toBeNull();
    expect(result!.site_id).toBe('S-IN-0007');
  });
});
