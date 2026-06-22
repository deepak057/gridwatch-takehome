import { normalise, MalformedEventError, NormalEvent } from './normalise';

describe('normalise()', () => {
  // Test 1: UTC conversion and tz_offset preservation for a status event
  it('converts a +05:30 timestamp to UTC and preserves tz_offset', () => {
    const raw = {
      type: 'status',
      charger_id: 'C-IN-0007-A',
      connector_id: '1',
      status: 'Charging',
      ts: '2026-06-09T14:32:11+05:30',
    };
    const result = normalise(raw, 'poll');
    expect(result.ts_utc).toBe('2026-06-09T09:02:11.000Z');
    expect(result.tz_offset).toBe('+05:30');
  });

  // Test 2: Same charger/connector/ts but different type → different dedup_key
  it('produces different dedup_key for status vs meter_value at same ts', () => {
    const statusRaw = {
      type: 'status',
      charger_id: 'C-IN-0007-A',
      connector_id: '1',
      status: 'Charging',
      ts: '2026-06-09T14:32:11+05:30',
    };
    const meterRaw = {
      type: 'meter_value',
      charger_id: 'C-IN-0007-A',
      connector_id: '1',
      energy_register_wh: 5000,
      ts: '2026-06-09T14:32:11+05:30',
    };
    const statusResult = normalise(statusRaw, 'poll');
    const meterResult = normalise(meterRaw, 'poll');
    expect(statusResult.dedup_key).not.toBe(meterResult.dedup_key);
  });

  // Test 3a: Same raw event twice → same dedup_key
  // Test 3b: Same event from 'poll' vs 'webhook' → same dedup_key (source excluded)
  it('produces the same dedup_key for identical events regardless of source', () => {
    const raw = {
      type: 'status',
      charger_id: 'C-IN-0007-A',
      connector_id: '1',
      status: 'Charging',
      ts: '2026-06-09T14:32:11+05:30',
    };
    const result1 = normalise(raw, 'poll');
    const result2 = normalise(raw, 'poll');
    const result3 = normalise(raw, 'webhook');
    expect(result1.dedup_key).toBe(result2.dedup_key);
    expect(result1.dedup_key).toBe(result3.dedup_key);
  });

  // Test 4a: Missing connector_id AND status on a status event → MalformedEventError
  it('throws MalformedEventError for status event missing connector_id and status', () => {
    const raw = {
      type: 'status',
      charger_id: 'C-IN-0007-A',
      ts: '2026-06-09T14:32:11+05:30',
    };
    expect(() => normalise(raw, 'poll')).toThrow(MalformedEventError);
  });

  // Test 4b: meter_value with energy_register_wh: null is valid, null is preserved
  it('accepts meter_value with energy_register_wh: null and preserves it as null', () => {
    const raw = {
      type: 'meter_value',
      charger_id: 'C-IN-0007-A',
      connector_id: '1',
      energy_register_wh: null,
      ts: '2026-06-09T14:32:11+05:30',
    };
    const result = normalise(raw, 'poll');
    expect(result.energy_register_wh).toBeNull();
    expect(() => normalise(raw, 'poll')).not.toThrow();
  });
});
