import { seedCatalogue } from './geo/geocoder';
import { normalise } from './ingest/normalise';
import { ingest, drain } from './ingest/inbox';

// Build pilot events with CURRENT timestamps (relative to boot time) so every boot —
// including a restart on an existing volume — produces fresh status. Fixed timestamps
// would be de-duplicated on a second boot, leaving connector_status stale ("Unknown").
function buildPilotEvents(): any[] {
  const now = Date.now();
  const at = (minsAgo: number) => new Date(now - minsAgo * 60_000).toISOString();
  return [
    // C-IN-0007-A/1: Charging then Available — newest-wins resolves to Available
    { type: 'status', charger_id: 'C-IN-0007-A', connector_id: '1', status: 'Charging', ts: at(3) },
    { type: 'status', charger_id: 'C-IN-0007-A', connector_id: '1', status: 'Available', ts: at(2) },
    // C-IN-0007-A/2: Faulted
    { type: 'status', charger_id: 'C-IN-0007-A', connector_id: '2', status: 'Faulted', ts: at(2) },
    // C-IN-0012-A/1: Available
    { type: 'status', charger_id: 'C-IN-0012-A', connector_id: '1', status: 'Available', ts: at(2) },
    // C-DE-0003-A/1: Available
    { type: 'status', charger_id: 'C-DE-0003-A', connector_id: '1', status: 'Available', ts: at(2) },
    // Session start+stop for C-IN-0007-A/1 so energy_wh gets populated (15 kWh)
    { type: 'session', charger_id: 'C-IN-0007-A', connector_id: '1', session_id: 'PILOT-SESSION-001', event: 'session.start', start_meter_wh: 10000, ts: at(5) },
    { type: 'session', charger_id: 'C-IN-0007-A', connector_id: '1', session_id: 'PILOT-SESSION-001', event: 'session.stop', stop_meter_wh: 25000, ts: at(1) },
  ];
}

export async function seedAndIngestPilot(): Promise<void> {
  await seedCatalogue();
  const normalised = buildPilotEvents().map((raw) => normalise(raw, 'poll'));
  await ingest(normalised);
  await drain();
}
