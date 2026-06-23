import { pollSite, FetchPage, PollDeps } from './csms-client';
import { pool } from '../db/pool';

const GOOD_EVENT = {
  type: 'meter_value',
  charger_id: 'C-DE-0003-A',
  connector_id: '1',
  energy_register_wh: 1000,
  power_w: 500,
  ts: '2026-06-09T23:14:58+02:00',
};

const PAGE_WITH_ONE_EVENT = {
  status: 200,
  headers: {},
  body: { events: [GOOD_EVENT] },
};

beforeEach(async () => {
  await pool.query('TRUNCATE raw_events, dead_letter RESTART IDENTITY CASCADE');
});

afterAll(async () => {
  // pool is shared; do not end it here
});

describe('pollSite()', () => {
  it('handles 429: sleeps Retry-After seconds then retries', async () => {
    const sleep = jest.fn().mockResolvedValue(undefined);
    let call = 0;
    const fetchPage: FetchPage = async () => {
      call++;
      if (call === 1) return { status: 429, headers: { 'retry-after': '30' }, body: {} };
      return PAGE_WITH_ONE_EVENT;
    };

    const result = await pollSite('site-1', '2026-06-01T00:00:00Z', {
      fetchPage,
      sleep,
    });

    expect(sleep).toHaveBeenCalledWith(30000);
    expect(result.retries).toBe(1);
    expect(result.ingested).toBe(1);

    const { rows } = await pool.query('SELECT id FROM raw_events');
    expect(rows.length).toBe(1);
  });

  it('handles 500: retries once then succeeds', async () => {
    let call = 0;
    const fetchPage: FetchPage = async () => {
      call++;
      if (call === 1) return { status: 500, headers: {}, body: {} };
      return PAGE_WITH_ONE_EVENT;
    };

    const result = await pollSite('site-1', '2026-06-01T00:00:00Z', {
      fetchPage,
    });

    expect(result.ingested).toBe(1);
    const { rows } = await pool.query('SELECT id FROM raw_events');
    expect(rows.length).toBe(1);
  });

  it('handles malformed page (1e): ingests valid event, dead-letters malformed', async () => {
    const fetchPage: FetchPage = async () => ({
      status: 200,
      headers: {},
      body: {
        events: [
          {
            type: 'meter_value',
            charger_id: 'C-DE-0003-A',
            connector_id: '1',
            energy_register_wh: null,
            power_w: 0,
            ts: '2026-06-09T23:14:58+02:00',
          },
          {
            type: 'status',
            charger_id: 'C-DE-0003-A',
            ts: '2026-06-09T23:14:58+02:00',
          },
        ],
      },
    });

    const result = await pollSite('site-1', '2026-06-01T00:00:00Z', {
      fetchPage,
    });

    expect(result.deadLettered).toBe(1);

    const rawRows = await pool.query('SELECT id FROM raw_events');
    expect(rawRows.rows.length).toBe(1);

    const dlRows = await pool.query('SELECT id FROM dead_letter');
    expect(dlRows.rows.length).toBe(1);
  });

  it('follows pagination: ingests events from both pages', async () => {
    const event2 = {
      type: 'meter_value',
      charger_id: 'C-DE-0003-B',
      connector_id: '1',
      energy_register_wh: 2000,
      power_w: 600,
      ts: '2026-06-09T23:15:58+02:00',
    };

    let call = 0;
    const fetchPage: FetchPage = async () => {
      call++;
      if (call === 1) {
        return {
          status: 200,
          headers: {},
          body: { events: [GOOD_EVENT], next_cursor: 'abc' },
        };
      }
      return {
        status: 200,
        headers: {},
        body: { events: [event2] },
      };
    };

    const result = await pollSite('site-1', '2026-06-01T00:00:00Z', {
      fetchPage,
    });

    expect(result.ingested).toBe(2);
    const { rows } = await pool.query('SELECT id FROM raw_events');
    expect(rows.length).toBe(2);
  });
});
