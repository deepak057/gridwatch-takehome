import * as path from 'path';
import * as fs from 'fs';
import { pool } from '../db/pool';

// Geocoder interface — production would swap in a NominatimGeocoder
// that calls a real geocoding service at onboarding time (never on the hot path).
export interface Geocoder {
  geocode(address: string): Promise<{ lat: number; lng: number } | null>;
}

// SeedGeocoder resolves coordinates from the pilot fixture (address → coords map).
// Used only during seeding — never during live query hot path.
export class SeedGeocoder implements Geocoder {
  private readonly lookup: Map<string, { lat: number; lng: number }>;

  constructor(sites: Array<{ address: string; lat: number; lng: number }>) {
    this.lookup = new Map(sites.map((s) => [s.address, { lat: s.lat, lng: s.lng }]));
  }

  async geocode(address: string): Promise<{ lat: number; lng: number } | null> {
    return this.lookup.get(address) ?? null;
  }
}

interface SitesJson {
  operators: Array<{ operator_id: string; name: string; country: string; currency: string }>;
  sites: Array<{ site_id: string; operator_id: string; name: string; address: string; lat: number; lng: number }>;
  chargers: Array<{ charger_id: string; site_id: string }>;
  connectors: Array<{ charger_id: string; connector_id: string }>;
}

// seedCatalogue: reads the pilot fixture and inserts all operators, sites (with PostGIS geom),
// chargers, and connectors. Idempotent via ON CONFLICT DO NOTHING.
// Production swaps SeedGeocoder for a NominatimGeocoder with the same Geocoder interface.
export async function seedCatalogue(): Promise<void> {
  const cataloguePath = path.resolve(__dirname, '..', '..', 'db', 'seed', 'sites.json');
  const raw = fs.readFileSync(cataloguePath, 'utf8');
  const catalogue: SitesJson = JSON.parse(raw);

  for (const op of catalogue.operators) {
    await pool.query(
      `INSERT INTO operators (operator_id, name, country, currency)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (operator_id) DO NOTHING`,
      [op.operator_id, op.name, op.country, op.currency],
    );
  }

  for (const site of catalogue.sites) {
    await pool.query(
      `INSERT INTO sites (site_id, operator_id, name, address, geom, geocoded_at, geocode_source)
       VALUES ($1, $2, $3, $4,
               ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography,
               now(), 'seed')
       ON CONFLICT (site_id) DO NOTHING`,
      [site.site_id, site.operator_id, site.name, site.address, site.lng, site.lat],
    );
  }

  for (const charger of catalogue.chargers) {
    await pool.query(
      `INSERT INTO chargers (charger_id, site_id)
       VALUES ($1, $2)
       ON CONFLICT (charger_id) DO NOTHING`,
      [charger.charger_id, charger.site_id],
    );
  }

  for (const connector of catalogue.connectors) {
    await pool.query(
      `INSERT INTO connectors (charger_id, connector_id)
       VALUES ($1, $2)
       ON CONFLICT (charger_id, connector_id) DO NOTHING`,
      [connector.charger_id, connector.connector_id],
    );
  }
}
