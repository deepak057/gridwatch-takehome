# GridWatch — Part A: Architecture & Design

**Author:** Deepak
**Scope:** Production architecture for GridWatch at ~50,000 chargers / ~12,000 sites across India + Germany, telemetry ~every 10 s.
**Company:** cidroy

This document is decisions and the reasoning behind them. Diagrams referenced as "see Diagram N (diagrams.md)"; the production view (Diagram 4) is reproduced inline where it aids reading.

---

## 0. Reading guide / TL;DR of the hard calls

- The ingestion path is the spine, and its risk is **correctness under at-least-once, out-of-order, dual-channel delivery** — not throughput. 5,000 writes/s is not streaming-scale; the write model (keyed upsert + content-derived dedup) solves the hard cases, not a log. We use a **Postgres inbox**, not Kafka, and name the seam so Kafka can be dropped in later (§11a).
- We are **honest about freshness**: poll-sourced signals physically cannot meet the sub-5 s KPIs given the vendor's 30 s floor; only webhooks can, and webhooks are themselves unreliable (batched ≤60 s, at-least-once, out-of-order). Live power appears poll-only in the stubs, so the <10 s power KPI may be unmeetable. We say so and say what we'd renegotiate (§4, §11b).
- We **reject "one Postgres for everything."** Right store per job: OLTP (PostGIS), a time-series store for the telemetry firehose, a hot-state cache, cold object storage for aged telemetry (§2).
- We commit **honest RPO/RTO**: no "RPO 0 with async" contradiction. Synchronous/quorum commit on financial tables for true RPO 0; everything else has an explicit, replication-justified number; failover is automated (§5).

---

## 1. Context & end-to-end data flow

**Boundary.** GridWatch begins at the CSMS boundary. We never speak OCPP and never talk to a charger. Each CPO runs one CSMS (assumption, §12); the CSMS exposes exactly two inputs: a **poll REST API** (30 s/site minimum, paginated, returns 429/500/malformed) and a **webhook** (best-effort, at-least-once, out-of-order, batched ≤60 s). See Diagram 1 (diagrams.md).

**End-to-end flow** (Diagram 4 reproduced inline):

```
        CSMS A (poll+webhook)        CSMS B (poll+webhook)     ... per CPO
              └───────────────┬───────────────┘
   ═══════════════════════════▼═══════════════════════════  INGESTION (HA, load-balanced)
     ┌─────────────────┐                ┌──────────────────┐
     │ Pollers         │                │ Webhook receivers│  verify HMAC,
     │ (per-site 30s,  │                │ (ack 2xx FIRST)  │  reject replay
     │  Retry-After)   │                └────────┬─────────┘
     └────────┬────────┘                         │
              └──────────────┬───────────────────┘
                             ▼
                   ┌────────────────────┐   malformed ─►  Dead-letter (S3)
                   │ raw_events (inbox) │   dedup_key UNIQUE, t0 stamped
                   └─────────┬──────────┘
   ══════════════════════════▼══════════════════════════  PROCESSING
                   ┌────────────────────┐
                   │ Normalisers        │  clocks→UTC, energy register→deltas,
                   │ (newest-wins,      │  reset detection, idempotent upserts
                   │  per connector)    │
                   └─────────┬──────────┘
   ══════════════════════════▼══════════════════════════  STORES (right store per job)
   ┌───────────────┐ ┌───────────────┐ ┌──────────────┐ ┌─────────────────┐
   │ Hot status    │ │ Telemetry     │ │ OLTP         │ │ Spatial         │
   │ (current state│ │ time-series,  │ │ sites/sess/  │ │ PostGIS geom    │
   │  + cache) <2s │ │ tiered hot→   │ │ invoices,    │ │ (geocoded once  │
   │               │ │ cold object   │ │ RLS by tenant│ │  at onboarding) │
   └───────┬───────┘ └───────────────┘ └──────┬───────┘ └────────┬────────┘
           └─────────────────┬─────────────────┴──────────────────┘
   ══════════════════════════▼══════════════════════════  SERVING
                   ┌────────────────────┐
                   │ API + SSE push     │  LISTEN/NOTIFY → stream changes
                   │ (tenant from JWT)  │  (no 10 s client polling)
                   └─────────┬──────────┘
                  ┌──────────┴───────────┐
                  ▼                      ▼
            Live Dashboard          Live GIS Map (vector tiles, viewport queries)
```

**Walking the path.** (1) **Ingest.** Pollers run a per-site 30 s scheduler honouring `Retry-After`; webhook receivers verify HMAC-SHA256 (§7), then **ack 2xx first** and write to the inbox — slow processing must never trigger a full-batch resend. (2) **Inbox.** Every event lands in `raw_events` with a content-derived `dedup_key UNIQUE` and `ON CONFLICT DO NOTHING`; the same event arriving via poll *and* webhook is counted once. We stamp **t0** (event-origin time, parsed from the payload) here for KPI proof (§8). (3) **Normalise.** A processor drains the inbox: parses local-tz offsets → UTC, converts the cumulative Wh register to deltas, detects meter resets, and writes newest-wins per connector. (4) **Stores.** Right store per job (§2). (5) **Serve.** The API derives tenant from the verified JWT (§7) and pushes changes over SSE driven by Postgres `LISTEN/NOTIFY`, so the dashboard does not client-poll every 10 s.

---

## 2. Storage design + schema sketch

**Decision: reject the single-Postgres-for-everything model.** Four workloads with incompatible access patterns share nothing useful by colocating: a 5,000 writes/s append firehose, low-latency current-state reads, relational settlement joins, and spatial KNN. One instance makes each the other's noisy neighbour and a single blast radius (this is exactly review flaw H-1). **Right store per job:**

| Job | Store | Why |
|---|---|---|
| Operators / sites / chargers / connectors / sessions / invoices | **PostgreSQL (OLTP)** + RLS | Relational integrity, FK joins for settlement, transactional inbox |
| Spatial (site geometry, nearest, density) | **PostGIS** (same PG cluster / read replica) | Spatial is the extension we actually use; GiST KNN |
| Telemetry firehose (status/meter history) | **Time-series store** (TimescaleDB hypertable or ClickHouse) | 432M rows/day; partition-by-time, compression, retention drop |
| Current state for the dashboard (<2 s) | **Hot cache** (Redis, HA) fronting `connector_status` | Tile reads must never hit the firehose or a cold join |
| Aged telemetry (cold) | **Object storage** (S3) as **Parquet** | Cheap, queryable via columnar engines, off the hot DB |

The current-state table (`connector_status`) lives in OLTP Postgres for transactional correctness and is mirrored into the cache for read latency; the *history* of those readings goes to the time-series store.

### DDL-level sketch (core entities, OLTP Postgres + PostGIS)

```sql
CREATE TABLE operators (
  operator_id   text PRIMARY KEY,
  name          text NOT NULL,
  country       text NOT NULL CHECK (country IN ('IN','DE')),
  currency      char(3) NOT NULL CHECK (currency IN ('INR','EUR'))
);

CREATE TABLE sites (
  site_id       text PRIMARY KEY,
  operator_id   text NOT NULL REFERENCES operators(operator_id),
  name          text,
  address       text NOT NULL,                       -- vendor gives this, NOT coords
  geom          geography(Point,4326),               -- geocoded ONCE at onboarding
  geocoded_at   timestamptz,
  geocode_source text                                -- 'nominatim' | 'manual' | ...
);
CREATE INDEX idx_sites_geom ON sites USING GIST (geom);
CREATE INDEX idx_sites_operator ON sites (operator_id);

CREATE TABLE chargers (
  charger_id    text PRIMARY KEY,
  site_id       text NOT NULL REFERENCES sites(site_id),
  model         text,
  max_kw        numeric(6,2)
);

CREATE TABLE connectors (
  charger_id    text NOT NULL REFERENCES chargers(charger_id),
  connector_id  int  NOT NULL,
  connector_type text,
  PRIMARY KEY (charger_id, connector_id)
);

-- current state, newest-wins by EVENT time
CREATE TABLE connector_status (
  charger_id    text NOT NULL,
  connector_id  int  NOT NULL,
  status        text NOT NULL,                        -- Available|Charging|Faulted|Unknown|...
  event_ts      timestamptz NOT NULL,                 -- UTC, from event origin
  tz_offset     text,                                 -- original offset preserved
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (charger_id, connector_id),
  FOREIGN KEY (charger_id, connector_id)
    REFERENCES connectors(charger_id, connector_id)
);

CREATE TABLE sessions (
  session_id     text PRIMARY KEY,
  operator_id    text NOT NULL REFERENCES operators(operator_id),
  charger_id     text NOT NULL,
  connector_id   int  NOT NULL,
  start_ts       timestamptz,
  stop_ts        timestamptz,
  start_meter_wh bigint,                              -- cumulative LIFETIME register
  stop_meter_wh  bigint,
  energy_wh      bigint,                              -- delta; NULL if anomalous
  anomaly        text,                                -- 'meter_reset' | NULL
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_sessions_operator ON sessions (operator_id);

CREATE TABLE invoices (
  session_id    text PRIMARY KEY                      -- UNIQUE ⇒ idempotent, no double-bill
                  REFERENCES sessions(session_id),
  operator_id   text NOT NULL REFERENCES operators(operator_id),
  settlement_day date NOT NULL,                       -- site-LOCAL day
  energy_kwh    numeric(12,3) NOT NULL,
  amount        numeric(14,2) NOT NULL,
  currency      char(3) NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- the INBOX
CREATE TABLE raw_events (
  id           bigserial PRIMARY KEY,
  dedup_key    text UNIQUE NOT NULL,                  -- content-derived (no event id exists)
  source       text NOT NULL CHECK (source IN ('poll','webhook')),
  operator_id  text NOT NULL,
  payload      jsonb NOT NULL,
  origin_ts    timestamptz,                           -- t0: event origin from payload
  received_at  timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX idx_raw_unprocessed ON raw_events (id) WHERE processed_at IS NULL;

CREATE TABLE dead_letter (
  id          bigserial PRIMARY KEY,
  payload     jsonb,
  reason      text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
```

### Telemetry store sketch (time-series, not OLTP)

```sql
-- TimescaleDB hypertable (or equivalent ClickHouse MergeTree partitioned by toYYYYMM(ts))
CREATE TABLE telemetry (
  charger_id   text        NOT NULL,
  connector_id int         NOT NULL,
  ts           timestamptz NOT NULL,                  -- UTC
  status       text,
  meter_wh     bigint,                                -- cumulative register snapshot
  power_w      integer,
  PRIMARY KEY (charger_id, connector_id, ts)
);
SELECT create_hypertable('telemetry','ts', chunk_time_interval => INTERVAL '1 day');
ALTER TABLE telemetry SET (timescaledb.compress, timescaledb.compress_segmentby='charger_id');
-- compress chunks > 2 days; drop/archive chunks per retention policy (§6)
```

The composite key `(charger_id, connector_id, ts)` plus time-chunking serves time-range queries (review flaw H-2: never a lone `charger_id` btree on an unpartitioned JSONB table). RLS tenant scoping is enforced on the OLTP entities; telemetry queries are tenant-scoped by joining charger ownership at the API layer.

---

## 3. GIS at scale

The vendor gives **NO coordinates — only an address string** (`"Sector 18 Metro Station, Noida, UP 201301"`). Everything below follows from that fact.

**Geocode at onboarding, never on the hot path.** When a site is first ingested we geocode its address string **once**, persist the result to `sites.geom` (`geography(Point,4326)`) with `geocoded_at` and `geocode_source`, and never geocode again on a query. A wrong pin is corrected by an onboarding correction loop (manual override updating `geom`, `geocode_source='manual'`), not by re-geocoding live. Geocoder choice and licensing are a decision-log entry (§11d) — short version: self-hosted **Nominatim** or a permissively-licensed API, *not* Google, because we render our own OpenStreetMap basemap and Google's licence forbids using its geocoding results off a Google map and caps storage at 30 days.

**Indexing.** PostGIS `geography` column with a **GiST** index on `geom`. `geography` (not `geometry`) so distances are true metres on the sphere — Euclidean lat/long arithmetic is wrong (at India's latitude 1° longitude ≈ 88 km, not 111 km) and review flaw H-3 fails exactly there.

**Nearest available charger** — KNN with the GiST-accelerated `<->` operator, filtered to available connectors:

```sql
SELECT s.site_id, s.name,
       ST_Distance(s.geom, :pt) AS metres
FROM sites s
JOIN chargers c   ON c.site_id = s.site_id
JOIN connector_status cs ON cs.charger_id = c.charger_id
WHERE cs.status = 'Available'
ORDER BY s.geom <-> :pt          -- index-assisted KNN, not a full scan
LIMIT 5;
```

`<->` lets the GiST index drive an index-ordered scan; at 12,000 sites this is sub-millisecond, not the 12k-row scan of the draft.

**Serving the map at 12k sites.** The map is the centre of the product, so it cannot ship a multi-MB GeoJSON on every load (review flaw H-4). Two mechanisms:
- **Vector tiles** (`ST_AsMVT`) for the basemap layer of sites, generated per zoom/tile and CDN-cacheable. Below a zoom threshold, server-side clustering collapses dense pins.
- **Viewport-bounded queries**: `... WHERE ST_Intersects(geom, ST_MakeEnvelope(:minx,:miny,:maxx,:maxy,4326))` returns only what's visible. Live status is delivered as a lightweight `{charger_id,status}` diff over SSE on top of the cached tile, not a full refetch.

**Density / coverage analytics** — spatial aggregation, not per-row math. Chargers per km² by region via `ST_Area(geography)` over administrative or grid polygons; coverage gaps via grid binning (`ST_SnapToGrid` / H3 hex cells) counting nearest-site distance per cell and flagging cells beyond a threshold. These run on a **read replica**, off the write primary.

---

## 4. Freshness KPIs — honest engagement

The platform is sold on freshness; these are contractual. **t0 is defined at event origin / the CSMS boundary** — we cannot control CSMS-internal latency, so any honest SLA is measured from the moment the event reaches us (assumption, §12). The KPI table:

| # | Signal | Target | Pctile | Source channel | Honest verdict |
|---|---|---|---|---|---|
| K1 | Connector / charger status | < 5 s | P99.9 | webhook primary, poll backstop | **Webhook-only feasible; poll path cannot.** |
| K2 | Active session power & energy | < 10 s | P99.9 | **poll-only in stubs** | **May be physically unmeetable — renegotiate.** |
| K3 | Fault / alarm surfaced | < 5 s | P99.9 | webhook primary | Webhook-only feasible; poll cannot. |
| K4 | Dashboard tile end-to-end | < 2 s | P99.9 | our internal path | Feasible **once data is in our store** (cache + SSE). |
| K5 | Map live-status update | < 10 s | P95 | webhook→SSE | Feasible on webhook path. |

**Per-signal latency budget** (webhook path, t0 at CSMS boundary):

```
t0 event origin ─► CSMS internal (NOT ours) ─► webhook receive + HMAC verify  ~50 ms
   ─► ack 2xx + inbox insert (dedup)                                          ~30 ms
   ─► processor drain + normalise + upsert                                   ~150 ms
   ─► LISTEN/NOTIFY → SSE push                                                ~50 ms
   ─► browser render                                                          ~100 ms
   ──────────────────────────────────────────────────────────────────────────────
   ≈ 0.4 s inside GridWatch  → K1/K3 (<5 s) and K4 (<2 s) achievable from our boundary
```

**The unavoidable truths, stated plainly:**

- **Poll cannot meet sub-5 s.** The vendor floor is 30 s/site and faster polling returns 429. A status change occurring just after a poll is not visible until the next poll — worst case ~30 s, an order of magnitude over the 5 s target. **Poll is the backstop for webhook gaps, never the freshness source** for K1/K3.
- **Webhook is the only sub-5 s path — and it is unreliable.** It is batched up to 60 s, at-least-once, and out-of-order. So even the webhook path cannot *guarantee* P99.9 < 5 s **measured from event origin** if the CSMS batches; we can only guarantee the budget **from our boundary inward** (~0.4 s). This is precisely why the SLA wording must be "measured from the CSMS boundary."
- **K2 (live power < 10 s) may be unmeetable.** In the stubs, `meter_value`/power appears in **poll responses only** — no webhook carries it. If power is genuinely poll-only at a 30 s floor, < 10 s P99.9 is physically impossible. **What we'd renegotiate:** ask the vendor for a webhook push of `meter_value`; if unavailable, renegotiate K2 to "≤ one poll interval (≈30 s) P99.9, measured from CSMS boundary," or restrict the <10 s target to energy *at session stop* (event-driven) rather than continuous live power. We flag this rather than paper over it.
- **K4 (<2 s tile)** is about *our* path, not the vendor's; it is achievable because the dashboard reads the hot cache and receives SSE diffs — it never recomputes a cold join per tile.

Net: **K1, K3, K4, K5 are achievable on the webhook→cache→SSE path measured from our boundary; K2 is the one we escalate** to the customer/vendor.

---

## 5. HA / failover / data-on-death

Replication mode dictates RPO; we never claim RPO 0 with async (the contradiction we criticised in review C-1). Failover is **automated** (Patroni or pg_auto_failover with a pre-validated promotion script), never manual paging — manual promotion cannot hit a tight RTO because alert→response→action alone burns minutes.

| Component | Replication / HA mode | RPO | RTO | Justification |
|---|---|---|---|---|
| **OLTP Postgres — financial tables** (`invoices`,`sessions`) | **synchronous / quorum commit** (`synchronous_commit=on`, `synchronous_standby_names`) | **0** | < 30 s | True RPO 0 requires the commit to wait for a standby flush. We pay a small write-latency penalty only on financial writes, which are low-rate. |
| **OLTP Postgres — non-financial** (status, sites, chargers) | streaming **async** replica, automated failover | **≤ replication lag, ~1–5 s** | < 30 s | Honest async RPO. Losing a few seconds of status is recoverable from the next poll/webhook; not worth the latency cost of sync everywhere. |
| **Telemetry time-series store** | replicated; async | **≤ a few seconds** of telemetry | < 1 min | Telemetry is high-volume, low-individual-value and reconstructable from the cumulative register; sync commit at 5,000 w/s is not worth it. |
| **Inbox (`raw_events`)** | lives in OLTP Postgres → inherits financial-cluster durability | tied to PG cluster RPO | < 30 s | The inbox is the at-least-once safety net: if a downstream store is lost, unprocessed/replayable rows reconstruct it. Idempotent dedup makes replay safe. |
| **Ingester / poller** | **stateless**, N replicas behind a scheduler; cursors/high-water-marks persisted in PG | 0 (no local state) | seconds (replica takes over) | A dead poller loses nothing — the cursor is in the DB; another instance resumes from the high-water-mark. |
| **Webhook receiver** | **stateless**, N replicas behind a load balancer; ack-then-process | 0 (no local state) | seconds | At-least-once delivery + inbox dedup means a dropped in-flight request is redelivered by the CSMS; no data lost. |
| **Hot cache (Redis)** | Sentinel/Cluster, ≥1 replica | rebuildable from PG | seconds | Cache is derived state; on loss it is rehydrated from `connector_status`. Never the system of record. |

**Data-on-death summary.** The inbox + idempotent dedup is what makes most components disposable: stateless ingesters and receivers lose nothing on death, and the financial tables carry a true RPO 0 via synchronous commit. We do **not** rely on a single node for any stateful component, and we run a quarterly DR drill to validate the RTO numbers above.

---

## 6. Capacity sizing (arithmetic shown)

**Write rate.**
```
50,000 chargers × (1 reading / 10 s) = 50,000 / 10 = 5,000 writes/s
```
This is **not streaming-scale** — it is a busy single-process write rate, and a key reason we don't reach for Kafka (§11a).

**Row volume per day.**
```
5,000 writes/s × 86,400 s/day = 432,000,000 rows/day  (~432M/day)
```

**Per-row size.** A telemetry row is `(charger_id text, connector_id int, ts timestamptz, status, meter_wh bigint, power_w int)`. Narrow typed columns ≈ **80–120 bytes** raw; with index and per-row overhead budget **~200 bytes/row** in a typed time-series store (an order of magnitude smaller than the draft's 2 KB JSONB row — JSONB key repetition is the trap that produced the draft's 864 GB/day).

**Daily storage (uncompressed, typed).**
```
432M rows/day × 200 bytes = 86,400,000,000 bytes ≈ 86.4 GB/day (uncompressed)
```
With time-series columnar compression (~5–10×), **~9–17 GB/day on disk**.

**Yearly storage.**
```
86.4 GB/day × 365 ≈ 31.5 TB/year uncompressed  →  ~3–6 TB/year compressed
```

**Sanity-check vs the draft's broken claim.** The draft assumed ~2 KB/row JSONB = **864 GB/day**, then claimed a 1 TB disk gave "a year." 864 GB/day fills 1 TB in **~28 hours**, not a year (review flaw H-7). Even our *leaner* 86.4 GB/day fills 1 TB in **~11.6 days** — so retention/tiering is mandatory regardless; you cannot keep the firehose hot forever.

**Tiered retention.**
- **Hot (in the time-series DB): ~7–14 days** of full-resolution telemetry — enough for live dashboards, recent trends, and incident forensics. ~120–240 GB hot (compressed), trivially provisioned.
- **Warm rollups:** continuous aggregates (per-connector 1-min / 1-hour rollups) retained ~90 days for utilisation analytics at a fraction of the size.
- **Cold (object storage as Parquet): everything older,** dropped from the DB via partition/chunk detach and written to S3. Queryable on demand by columnar engines for audits/forecasting; ~3–6 TB/year at object-storage prices.

**Right-sized instances.**
- **Telemetry store:** 8–16 vCPU / 32–64 GB, fast NVMe for hot chunks; comfortably absorbs 5,000 typed writes/s.
- **OLTP/PostGIS primary + sync standby:** 8 vCPU / 32 GB each; transactional load is sessions/invoices/inbox, not the firehose.
- **Read replica(s)** for dashboard/GIS/analytics reads so the primary is never the read path.
- **Redis HA** for the hot cache.

The point the draft missed: separating the firehose into a typed, compressed, tiered store turns a "300 TB/year, disk-exhausted-on-day-two" problem into a few TB/year with bounded hot storage.

---

## 7. Security + multi-tenant isolation

**Tenant identity comes from a verified JWT claim — never a URL or query param.** The draft's `GET /sites?operator_id=acme` is a trivial cross-tenant breach (review C-5): any caller substitutes another `operator_id`. We derive the tenant from the `operator_id` claim in the JWT verified at the API edge; the client cannot assert its own tenant.

**Defence-in-depth: Postgres Row-Level Security with FORCE.** Even if an application bug or SQL injection slips a tenant filter, RLS stops cross-tenant rows at the database:

```sql
ALTER TABLE sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE sites FORCE ROW LEVEL SECURITY;          -- applies even to table owner
CREATE POLICY tenant_isolation ON sites
  USING (operator_id = current_setting('app.operator_id', true));
-- same policy on chargers (via site), sessions, invoices, connector_status
```

The API sets `app.operator_id` from the JWT claim per request/transaction.

**PgBouncer caveat (called out explicitly).** Under transaction pooling, a connection is shared across tenants between transactions, so a session-level `SET` leaks. **Set tenant context per query/transaction** — `SET LOCAL app.operator_id = …` inside the same transaction as the query (or pass it via `set_config(...,true)` in the query) so it is scoped to that transaction and reset on commit. Never `SET` it at session level behind a transaction pooler.

**Transport & webhook integrity.**
- **TLS** everywhere (CSMS↔GridWatch, GridWatch↔clients).
- **HMAC-SHA256 webhook verification:** compute `HMAC-SHA256(raw_body, shared_secret)` and compare against `X-CSMS-Signature` with a **constant-time** comparison (`crypto.timingSafeEqual`) **before any processing**; reject mismatches. Checking that a header merely *contains* the secret (the draft's approach, review H-6) gives no body integrity and is exploitable for forged `session.stop` → fraudulent invoices.

**Compliance note.** CPO data is in scope for GDPR (Germany) and DPDP (India); RLS is the default, with escalation to schema/DB-per-tenant for contractual isolation (§11c).

---

## 8. Observability — proving the KPIs

Host CPU/RAM and HTTP error rates do **not** prove a freshness SLA (review Medium flaw): a charger can emit stale data while CPU is green. We instrument the **freshness path end-to-end**.

- **Stamp t0 at event origin** (the timestamp inside the payload / CSMS boundary arrival), carried through every stage so latency is measured against the contract clock, not our ingest clock.
- **Per-stage end-to-end latency histograms** at **P95 and P99.9** for each transition: `t0 → inbox insert → normalise/upsert → SSE push → (client ack render)`. Each KPI (K1–K5) has its own histogram so we can see *which* signal class is breaching.
- **Distributed tracing ingest→display:** a trace spans receiver → inbox → processor → store → SSE so a slow tile is attributable to a stage, not guessed.
- **Alert on KPI burn, not on hosts:** page when a signal's P99.9 latency exceeds its contractual threshold (e.g. K1 P99.9 > 5 s) or when the SLO error budget burns too fast. We also alert on **staleness** — connectors with no fresh event past their TTL are surfaced as `Unknown`, never silently painted available.

This is the only way to *prove* (or disprove) the SLA, and it is the data we'd bring to a KPI renegotiation for K2.

---

## 9. Energy & settlement design

**Energy is a cumulative LIFETIME Wh register per connector — not kWh, not per-session, not per-interval.** Everything in settlement derives from differencing that register.

- **Delta computation:** `energy_wh = stop_meter_wh − start_meter_wh`, both being snapshots of the lifetime register at session start and stop.
- **Meter-reset detection:** if `stop_meter_wh < start_meter_wh` the register rolled over or the meter was replaced mid-session (stub 2d: stop `31,200` < start `12,044,990`). **Flag `anomaly='meter_reset'`, do NOT bill negative.** Hold for review or apply an agreed fallback (reconstruct from per-interval telemetry snapshots if present, or a duration-based flat rate if the tariff supports it). Never write negative energy to `invoices` (review C-4).
- **Tariff (per CPO):** per-kWh price + fixed session fee. `amount = energy_kwh × price_per_kwh + session_fee`, in the destination currency — **INR** for India, **EUR** for Germany (carried on `operators.currency`). Taxes (GST/VAT), time-of-day, and idle fees are out of scope here (§12) and noted as a settlement-redesign trigger.
- **Settlement bucketing:** by **site-local day**, not UTC day — a session is attributed to the calendar day at the site's timezone, so India/Germany sessions and DST boundaries bucket correctly. (Timestamps are normalised to UTC for comparison but the *bucket* is computed in site-local time.)
- **Idempotent invoicing:** the daily settlement run upserts `INSERT INTO invoices … ON CONFLICT (session_id) DO NOTHING`. The `UNIQUE` on `session_id` means a redelivered `session.stop` (stub 2b, at-least-once) produces **one** invoice — no double-billing (review C-3). The same idempotency applies to the `sessions` upsert.

Full settlement is **described here, built only as the meter-reset guard** in Part C (§12).

---

## 10. Demand forecasting — DESCRIBE ONLY

Per the brief, this is **architectural-understanding-only: described, not built.** No models are designed in depth here.

- **Approach:** a per-site/per-region time-series forecast of charging demand (session count / energy / peak power) at hourly-to-daily horizons — a batch-trained model serving predictions, not an online learner on the hot path.
- **Inputs:** historical utilisation from the **warm rollups and cold Parquet** telemetry (the tiers built in §6), plus calendar features (day-of-week, holidays per country), weather, and site metadata (location, connector mix). Crucially it consumes the *aggregated* history, never the live firehose.
- **Where it lives:** **off the serving path entirely** — a separate analytics/ML lane reading cold/warm storage, writing forecasts to a results table the dashboard reads like any other tile. It shares the data tiers but not the latency-critical ingestion or serving components, so it can never jeopardise the freshness KPIs.

Explicitly: this section describes the architecture's *place* for forecasting; we are **not** building the models.

---

## 11. Decision log

### (a) Postgres inbox instead of Kafka

**Options:** Kafka/Redpanda log vs a Postgres `raw_events` inbox table.
**Chosen: Postgres inbox.** At 5,000 writes/s this is not streaming-scale, and the brief's genuinely hard cases — duplicate delivery, out-of-order, dual-channel, meter-reset — are solved by the **write model** (content-derived `dedup_key UNIQUE` + `ON CONFLICT`, newest-wins upsert), not by an ordered log. A queue adds the single most common `compose up` failure mode and zero correctness payoff, while the inbox is transactional, gives real dedup and a dead-letter story, and is replayable for RPO. **We name the seam:** the `IngestQueue` interface is Kafka-shaped — production swaps a topic in, here it's a table.
**When Kafka earns its place:** when write rate outgrows a single Postgres writer (multi-×10⁴ w/s sustained), when multiple independent consumer groups need the same stream with independent offsets, or when cross-region fan-out/replay at high volume is required. None of those hold at this scale.

### (b) Freshness honesty / which KPIs are unmeetable

**Options:** claim all KPIs are met (draft's posture) vs engage honestly.
**Chosen: honest engagement.** Poll-sourced sub-5 s signals are physically impossible at a 30 s vendor floor; webhook is the only sub-5 s path and is itself batched/at-least-once/out-of-order. **K1/K3/K4/K5 are achievable on the webhook→cache→SSE path measured from the CSMS boundary; K2 (live power <10 s) is likely unmeetable** because power appears poll-only in the stubs. We re-scope SLA wording to "measured from the CSMS boundary" and escalate K2 to the vendor (push `meter_value`) or renegotiate it to ≈one poll interval. Saying this up front is the differentiator; papering over it is the trap.

### (c) RLS vs schema-per-tenant

**Options:** shared schema + Row-Level Security; schema-per-tenant; database-per-tenant.
**Chosen: RLS by default** (with `FORCE` and JWT-claim tenant context). It scales to many CPOs without per-tenant migration/operational sprawl and gives defence-in-depth behind app-layer scoping. **Escalate to schema- or database-per-tenant** when a specific CPO contractually requires physical/logical isolation (common in enterprise/regulated deals) or when tenant count is small enough that the operational cost is negligible. The isolation model is decided before the data layer is built, not retrofitted.

### (d) Geocode-at-onboarding, and why NOT Google geocoding

**Options:** geocode live per query (rejected — hot-path latency, cost, rate limits); Google Geocoding API; self-hosted Nominatim / permissively-licensed API.
**Chosen: geocode once at onboarding, persist to `sites.geom`, with Nominatim (self-hosted) or a permissively-licensed geocoder — not Google.** Geocoding live on the nearest-charger path would be slow, costly, and rate-limited; the address is static, so we resolve it once and store it, with a manual correction loop for bad pins. **Not Google** because Google's licence forbids using its geocoding results with a non-Google basemap and limits storage to ~30 days — and we render our **own OpenStreetMap-based map**. Using Google geocodes on an OSM map is a licence violation, and we cannot legally cache the coordinates we need to persist. Self-hosted Nominatim (or an OSM-licence-compatible API) keeps geocoding and basemap on the same legal footing; we never ship the multi-GB Nominatim import into the take-home slice (a `SeedGeocoder` fixture stands in there).

---

## 12. Assumptions + What we would NOT build, and why

**Assumptions (documented, not emailed):**
- **Starter-kit gap:** the referenced full dataset/vendor service was not provided; per the brief we **build a local mock** from the documented CSMS stubs and synthesise pilot rows. We do not need a running vendor service.
- **KPI clock:** freshness is **measured from the CSMS boundary** (event arrival), since the brief says our job begins there and we cannot control CSMS-internal latency.
- **One CSMS per CPO:** each CPO exposes a single CSMS behind one common interface for this exercise.
- **Tariff model:** per-kWh price + session fee, in local currency (INR/Germany EUR). **Taxes (GST/VAT), time-of-day pricing, and idle fees are out of scope** unless specified — flagged as a settlement-redesign trigger.

**What we would NOT build (and why):**
- **Dashboard / map UI** — the architectural risk is ingestion correctness and the data/GIS path, not pixels; UI is described, not built.
- **Demand-forecasting models** — the brief says architectural-understanding-only; we describe its place (§10) and stop.
- **Full settlement engine** — described in §9; only the **meter-reset guard** (the correctness-critical piece) is built in Part C, because the billing risk lives there, not in tariff arithmetic.
- **Multi-CSMS / multi-vendor adapters** — one common CSMS interface is assumed; per-vendor adapters are a known extension point, not pilot-critical.
- **Production Nominatim import** — multi-GB and off the critical path; a seed fixture stands in for the slice, the hosted/self-hosted impl is documented behind the `Geocoder` interface.

Each "won't-build" has a one-line reason above; all are recorded in the README's "where I stopped / what's next."
