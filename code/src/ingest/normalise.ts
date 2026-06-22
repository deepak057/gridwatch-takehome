import { createHash } from 'crypto';

export interface NormalEvent {
  type: 'status' | 'meter_value' | 'session' | 'fault';
  charger_id: string;
  connector_id?: string;
  status?: string;
  energy_register_wh?: number | null;
  power_w?: number;
  code?: string;
  severity?: string;
  session_id?: string;
  event?: string;
  start_meter_wh?: number;
  stop_meter_wh?: number;
  ts_utc: string;
  tz_offset: string;
  dedup_key: string;
}

export class MalformedEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedEventError';
  }
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function extractTzOffset(ts: string): string {
  // Match +HH:MM or -HH:MM at the end, or Z
  const match = ts.match(/([+-]\d{2}:\d{2})$/);
  if (match) return match[1];
  if (ts.endsWith('Z')) return '+00:00';
  throw new MalformedEventError(`Cannot extract timezone offset from ts: ${ts}`);
}

function requireField(raw: any, field: string, type: string): void {
  if (raw[field] === undefined || raw[field] === null) {
    throw new MalformedEventError(
      `Missing required field '${field}' for ${type} event`,
    );
  }
}

export function normalise(raw: any, source: string): NormalEvent {
  if (!raw || typeof raw !== 'object') {
    throw new MalformedEventError('Event must be a non-null object');
  }

  const eventType = raw.type as NormalEvent['type'];
  if (!['status', 'meter_value', 'session', 'fault'].includes(eventType)) {
    throw new MalformedEventError(`Unknown event type: ${raw.type}`);
  }

  if (!raw.charger_id) {
    throw new MalformedEventError('Missing required field charger_id');
  }

  if (!raw.ts) {
    throw new MalformedEventError('Missing required field ts');
  }

  const tsUtc = new Date(raw.ts).toISOString();
  const tzOffset = extractTzOffset(raw.ts as string);

  let dedup_key: string;
  const base: Omit<NormalEvent, 'dedup_key'> = {
    type: eventType,
    charger_id: raw.charger_id,
    ts_utc: tsUtc,
    tz_offset: tzOffset,
  } as any;

  switch (eventType) {
    case 'status': {
      if (!raw.connector_id) {
        throw new MalformedEventError(
          "Missing required field 'connector_id' for status event",
        );
      }
      if (!raw.status) {
        throw new MalformedEventError(
          "Missing required field 'status' for status event",
        );
      }
      base.connector_id = raw.connector_id;
      base.status = raw.status;
      dedup_key = sha256(
        `status|${raw.charger_id}|${raw.connector_id}|${tsUtc}|${raw.status}`,
      );
      break;
    }

    case 'meter_value': {
      if (!raw.connector_id) {
        throw new MalformedEventError(
          "Missing required field 'connector_id' for meter_value event",
        );
      }
      // energy_register_wh: null is valid; only throw if key is entirely absent
      if (!('energy_register_wh' in raw)) {
        throw new MalformedEventError(
          "Missing required field 'energy_register_wh' for meter_value event",
        );
      }
      base.connector_id = raw.connector_id;
      base.energy_register_wh = raw.energy_register_wh;
      if (raw.power_w !== undefined) base.power_w = raw.power_w;
      dedup_key = sha256(
        `meter|${raw.charger_id}|${raw.connector_id}|${tsUtc}|${raw.energy_register_wh}`,
      );
      break;
    }

    case 'session': {
      if (!raw.session_id) {
        throw new MalformedEventError(
          "Missing required field 'session_id' for session event",
        );
      }
      if (!raw.event) {
        throw new MalformedEventError(
          "Missing required field 'event' for session event",
        );
      }
      base.session_id = raw.session_id;
      base.event = raw.event;
      if (raw.start_meter_wh !== undefined) base.start_meter_wh = raw.start_meter_wh;
      if (raw.stop_meter_wh !== undefined) base.stop_meter_wh = raw.stop_meter_wh;
      dedup_key = sha256(`session|${raw.session_id}|${raw.event}`);
      break;
    }

    case 'fault': {
      if (!raw.connector_id) {
        throw new MalformedEventError(
          "Missing required field 'connector_id' for fault event",
        );
      }
      if (!raw.code) {
        throw new MalformedEventError(
          "Missing required field 'code' for fault event",
        );
      }
      base.connector_id = raw.connector_id;
      base.code = raw.code;
      if (raw.severity !== undefined) base.severity = raw.severity;
      dedup_key = sha256(
        `fault|${raw.charger_id}|${raw.connector_id}|${tsUtc}|${raw.code}`,
      );
      break;
    }
  }

  return { ...base, dedup_key } as NormalEvent;
}
