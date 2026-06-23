CREATE EXTENSION IF NOT EXISTS postgis;
CREATE TABLE IF NOT EXISTS operators (
  operator_id text PRIMARY KEY, name text NOT NULL,
  country text NOT NULL, currency char(3) NOT NULL);
CREATE TABLE IF NOT EXISTS sites (
  site_id text PRIMARY KEY,
  operator_id text NOT NULL REFERENCES operators(operator_id),
  name text, address text NOT NULL,
  geom geography(Point,4326), geocoded_at timestamptz, geocode_source text);
CREATE INDEX IF NOT EXISTS idx_sites_geom ON sites USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_sites_operator ON sites (operator_id);
CREATE TABLE IF NOT EXISTS chargers (
  charger_id text PRIMARY KEY,
  site_id text NOT NULL REFERENCES sites(site_id),
  model text, max_kw numeric(6,2));
CREATE TABLE IF NOT EXISTS connectors (
  charger_id text NOT NULL REFERENCES chargers(charger_id),
  connector_id text NOT NULL,
  connector_type text,
  PRIMARY KEY (charger_id, connector_id));
