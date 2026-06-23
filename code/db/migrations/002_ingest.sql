CREATE TABLE IF NOT EXISTS raw_events (
  id bigserial PRIMARY KEY, dedup_key text UNIQUE NOT NULL,
  source text NOT NULL, operator_id text,
  payload jsonb NOT NULL, origin_ts timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz);
CREATE INDEX IF NOT EXISTS idx_raw_unprocessed ON raw_events (id) WHERE processed_at IS NULL;
-- current state; NO foreign key, so status can be recorded before the connector catalogue is seeded
CREATE TABLE IF NOT EXISTS connector_status (
  charger_id text NOT NULL, connector_id text NOT NULL,
  status text NOT NULL, event_ts timestamptz NOT NULL,
  tz_offset text, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (charger_id, connector_id));
CREATE TABLE IF NOT EXISTS sessions (
  session_id text PRIMARY KEY, operator_id text,
  charger_id text, connector_id text,
  start_ts timestamptz, stop_ts timestamptz,
  start_meter_wh bigint, stop_meter_wh bigint,
  energy_wh bigint, anomaly text,
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS dead_letter (
  id bigserial PRIMARY KEY, payload jsonb, reason text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now());
