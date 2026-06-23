import { seedCatalogue } from './geo/geocoder';
import { normalise } from './ingest/normalise';
import { ingest, drain } from './ingest/inbox';

const PILOT_EVENTS = [
  // C-IN-0007-A connector 1: Charging at t=0, then Available at t=1 (newest-wins)
  {
    type: 'status',
    charger_id: 'C-IN-0007-A',
    connector_id: '1',
    status: 'Charging',
    ts: '2026-06-23T06:00:00+05:30',
  },
  {
    type: 'status',
    charger_id: 'C-IN-0007-A',
    connector_id: '1',
    status: 'Available',
    ts: '2026-06-23T07:00:00+05:30',
  },
  // C-IN-0007-A connector 2: Faulted
  {
    type: 'status',
    charger_id: 'C-IN-0007-A',
    connector_id: '2',
    status: 'Faulted',
    ts: '2026-06-23T06:00:00+05:30',
  },
  // C-IN-0012-A connector 1: Available
  {
    type: 'status',
    charger_id: 'C-IN-0012-A',
    connector_id: '1',
    status: 'Available',
    ts: '2026-06-23T06:00:00+05:30',
  },
  // C-DE-0003-A connector 1: Available
  {
    type: 'status',
    charger_id: 'C-DE-0003-A',
    connector_id: '1',
    status: 'Available',
    ts: '2026-06-23T06:00:00+02:00',
  },
  // Session: start + stop for C-IN-0007-A/1 so energy_wh gets populated
  {
    type: 'session',
    charger_id: 'C-IN-0007-A',
    connector_id: '1',
    session_id: 'PILOT-SESSION-001',
    event: 'session.start',
    start_meter_wh: 10000,
    ts: '2026-06-23T06:00:00+05:30',
  },
  {
    type: 'session',
    charger_id: 'C-IN-0007-A',
    connector_id: '1',
    session_id: 'PILOT-SESSION-001',
    event: 'session.stop',
    stop_meter_wh: 25000,
    ts: '2026-06-23T06:55:00+05:30',
  },
];

export async function seedAndIngestPilot(): Promise<void> {
  await seedCatalogue();

  const normalised = PILOT_EVENTS.map((raw) => normalise(raw, 'poll'));
  await ingest(normalised);
  await drain();
}
