# GridWatch — Architecture Review: Draft v0.3

**Reviewer:** Deepak  
**Document under review:** `gridwatch-reference-architecture-DRAFT v0.3`  
**Date:** 2026-06-23

---

## Ranking Rule

**Severity = (contractual / financial / data-loss damage) × probability × time-to-impact.**

Flaws that break a signed KPI, produce incorrect invoices, or expose tenant data rank first — they either cost money immediately or terminate the contract. Flaws that degrade reliability or correctness under load rank second. Flaws that create operational friction or technical debt without immediate business consequence rank third. Each tier is ordered within itself by the same product impact logic.

---

## Critical Tier

### C-1 — RPO 0 claimed with async streaming replication (§9)

**Problem.**  
Section 9 states: *"PostgreSQL runs with streaming replication in asynchronous mode … RPO: 0 (no data loss)."* These two sentences contradict each other. Async replication allows the standby to lag behind the primary by the in-flight WAL buffer at the moment of failure. Any committed transaction not yet flushed to the standby is lost permanently on failover. RPO 0 is physically impossible with async replication. The document also states that failover is triggered by paging an on-call engineer who then manually promotes the standby — manual promotion cannot reliably hit a 5-minute RTO under any realistic incident scenario (alert → response → action alone consumes minutes).

**Why / when it hurts.**  
Both flaws manifest simultaneously on primary failure: a non-zero quantity of telemetry, session data, and — critically — `invoices` rows that were committed but not yet replicated are silently dropped. The data loss is invisible until a CPO's settlement reconciliation fails. The manual promotion path means the 5-minute RTO will be breached routinely.

**Concrete fix.**  
Either (a) state the honest RPO — "RPO ≤ replication lag at time of failure, typically 1–5 s" — and let the customer decide whether that is acceptable, or (b) switch to synchronous commit (`synchronous_commit = on`, `synchronous_standby_names = 1`) for the `invoices` and `sessions` tables, accepting the small write-latency penalty in exchange for a true RPO 0 guarantee on financial data. For the 5-minute RTO, replace manual promotion with automated failover via Patroni or pg\_auto\_failover with a pre-validated promotion script. Manual failover should remain available as an override, but cannot be the primary path.

---

### C-2 — Poll-only freshness cannot meet the <5 s / <2 s KPIs (§3, §1)

**Problem.**  
Section 3 claims: *"Because we poll every 30 seconds and also receive webhooks within 60 seconds, dashboard data is always fresh enough to meet the < 5 s and < 2 s KPIs."* This is false on its face. The vendor's documented minimum poll interval is 30 seconds per site (§1 of the CSMS contract — polling faster returns HTTP 429). Webhooks are batched up to 60 seconds. Neither path can deliver data at P99.9 < 5 s for connector status and fault events, or at P99.9 < 2 s for dashboard tile freshness. The document acknowledges both constraints and then ignores their implications.

**Why / when it hurts.**  
These are contractual KPIs (candidate brief, §"Success metrics"). Missing them is a contract violation from day one of production. The dashboard tile <2 s P99.9 target is also impossible if the tile query hits a heavily loaded single Postgres instance cold on every 10-second poll (see H-1).

**Concrete fix.**  
Treat webhooks as the primary delivery channel for all sub-5-second signals (status, faults, session events). The poll at 30-second intervals is the backstop for webhook gaps, not the freshness source. To move webhook data to the dashboard in under 2 s end-to-end: publish events to a Redis pub/sub channel from the Status Consumer; push updates to the browser over WebSocket or Server-Sent Events rather than client-polling every 10 seconds. Separately, re-scope the KPI wording to "measured from the CSMS boundary" — GridWatch cannot control the CSMS-to-webhook delivery time, and any honest SLA must reflect this. For `meter_value` (live power), the signal arrives via poll only (see Q-1 below); the <10 s power KPI may be physically unmeetable and must be flagged explicitly rather than papered over.

---

### C-3 — No deduplication on settlement produces double-billing (§7)

**Problem.**  
Section 7 states: *"Because each session produces exactly one `session.stop` event, no deduplication is needed on the settlement side."* The CSMS stubs contradict this directly. Stub 2b shows the identical `session.stop` for `sess-de-99x` delivered twice with different `delivery_id` values — an explicit at-least-once redelivery example provided in the contract. The Settlement Consumer, as described, will write two rows to `invoices` for the same session, doubling the billed amount.

**Why / when it hurts.**  
Double-billing CPO customers is a financial and contractual error that surfaces at every daily settlement run. It will be noticed quickly and is extremely hard to unwind cleanly once reconciliation reports have been sent.

**Concrete fix.**  
The `invoices` table must carry a `UNIQUE` constraint on `session_id`. The Settlement Consumer must upsert — `INSERT … ON CONFLICT (session_id) DO NOTHING` — rather than a plain insert. The `sessions` table should apply the same idempotency pattern on the Session Consumer's upsert of session rows, keyed on `session_id`.

---

### C-4 — Negative energy on meter reset silently produces a negative invoice (§7)

**Problem.**  
Section 7 computes energy as `stop_meter_wh - start_meter_wh` with no guard. CSMS stub 2d shows `session.stop` for `sess-in-77c` with `stop_meter_wh: 31200` and `start_meter_wh: 12044990` — a meter reset event where the register rolled over or was replaced mid-session. Naive subtraction yields −12,013,790 Wh. Applied against the tariff, this produces a large negative invoice, which either results in a credit being issued or — if the billing system rejects negatives — a silent settlement gap.

**Why / when it hurts.**  
A negative invoice is a billing error and a compliance risk. Silent rejection means the CPO is never paid for that session. Both outcomes are wrong. The stub explicitly labels this case a "correctness hazard."

**Concrete fix.**  
Before computing energy, check `stop_meter_wh < start_meter_wh`. If true: flag the session row with `meter_reset = true`, emit an alert, and do not auto-bill. Hold the session for manual review or apply an agreed-upon fallback (e.g. compute from the per-session cumulative meter values in telemetry if available, or bill the estimated duration-based flat rate if the tariff supports it). Never write a negative energy value to `invoices`.

---

### C-5 — Multi-tenancy via query parameter allows trivial cross-tenant data breach (§6)

**Problem.**  
Section 6 states: *"The Dashboard API scopes queries by the `operator_id` that the frontend sends as a query parameter, e.g. `GET /sites?operator_id=acme`."* Any authenticated user (or unauthenticated caller with network access) can substitute any `operator_id` and receive another CPO's sites, chargers, sessions, and invoices. There is no server-side enforcement of which operator_id a token is authorised to see.

**Why / when it hurts.**  
This is a trivially exploitable multi-tenant data breach. CPO data is commercially sensitive and in scope for GDPR (Germany) and DPDP (India). Exposure of one CPO's operational data to another is a contract breach, a regulatory violation, and reputationally terminal.

**Concrete fix.**  
Remove `operator_id` from query parameters entirely. The API must derive the tenant identity from the verified JWT issued by Keycloak — the `operator_id` claim in the token, not a parameter the caller controls. Enforce this at the ORM/query layer and add Postgres Row-Level Security policies keyed on `operator_id` as a defence-in-depth layer, so even a SQL injection or application bug cannot leak cross-tenant rows.

---

## High Tier

### H-1 — Single Postgres as system-of-record for telemetry, OLTP, invoices, and GIS (§4, §10)

**Problem + fix.**  
All reads and writes — 5,000 telemetry writes/sec, dashboard queries, settlement joins, GIS queries — contend on a single 4 vCPU / 8 GB instance. At production scale this is both a performance ceiling and a single point of failure for the entire platform. **Fix:** Separate concerns — use a time-series store (TimescaleDB or ClickHouse) for the `telemetry` table, keep Postgres for operational entities (sessions, invoices, chargers, sites), and offload GIS queries to PostGIS on a read replica. Dashboard queries should read from replicas or the cache layer, never the primary.

### H-2 — Unpartitioned JSONB telemetry table with only a charger_id btree index (§4.2)

**Problem + fix.**  
Section 4.2 creates `telemetry(charger_id text, ts timestamptz, payload jsonb)` with `CREATE INDEX idx_telemetry_charger ON telemetry (charger_id)`. At 864 GB/day ingestion (the document's own arithmetic), this table will be in the hundreds of terabytes within months. A single btree on `charger_id` cannot serve time-range queries efficiently, autovacuum will fall behind the insert rate, and table bloat will kill query performance. **Fix:** Partition by time (monthly or weekly `RANGE` on `ts`), with a composite index `(charger_id, ts)` per partition. This keeps partition sizes manageable, allows old partitions to be detached and archived without a full-table lock, and keeps vacuum effective.

### H-3 — "Nearest charger" uses Euclidean lat/long arithmetic with no spatial index and no geocoding source (§5.1)

**Problem + fix.**  
The query in §5.1 orders by `(s.latitude - :lat)^2 + (s.longitude - :lng)^2`. This is wrong in three compounding ways: (1) Euclidean distance on lat/long coordinates is geometrically incorrect — at India's latitude, 1° of longitude is ~88 km, not ~111 km; at scale this produces wrong "nearest" results. (2) There is no spatial index, so at 12,000 sites this is a full table scan on every query. (3) The CSMS vendor provides only an address string, not coordinates (confirmed in both the brief and the stubs: *"Nothing here carries coordinates"*). The `sites` table stores `latitude/longitude` but there is no geocoding path described to populate them. **Fix:** Add PostGIS to the Postgres instance; store site geometry as a `GEOGRAPHY(Point, 4326)` column; build a `GIST` index on it. Replace the Euclidean query with `ST_DWithin` / `ST_Distance` (sphere). Add a geocoding step in the site-ingestion path (Google Maps Geocoding API, or a self-hosted Nominatim instance for GDPR compliance in Germany) to convert the vendor address string to coordinates on first insert.

### H-4 — Map serves full GeoJSON of all sites on every 10-second poll (§5.1)

**Problem + fix.**  
`GET /sites` returns the full GeoJSON FeatureCollection for every site the operator owns, on every page load and every 10-second client poll. At 12,000 sites per operator with status embedded, a single response could be several megabytes. At 10-second intervals across many concurrent dashboard users, this will saturate both the Postgres connection pool and the network. **Fix:** Serve a delta update or status-diff endpoint. Cache the full GeoJSON per operator in Redis with a short TTL; clients receive only a lightweight `{charger_id, status}` diff payload after initial load. For large operators, implement viewport-bounded queries: `GET /sites?bbox=...` using a spatial index to return only visible sites.

### H-5 — Out-of-order events resolved last-received-wins, not newest-wins (§3, stubs 2c)

**Problem + fix.**  
Section 3 describes consumers writing events from the Kafka topic to Postgres. No ordering strategy is mentioned. Stub 2c explicitly shows a stale `status: Charging` at 14:31:50 arriving after the correct `status: Available` at 14:33:40 — the stubs note *"newest wins, not last-received."* A plain upsert without timestamp comparison will overwrite the correct later status with the stale earlier one. **Fix:** All upserts to `connectors.status` (and any last-known-value field) must include a `WHERE existing_ts < incoming_ts` guard, or use a `GREATEST(existing_ts, incoming_ts)` selection. Kafka partition-ordering by `charger_id` helps within a single partition but does not protect against webhook-vs-poll races or redeliveries.

### H-6 — Webhook validates shared secret in header but ignores documented HMAC-SHA256 signature (§11)

**Problem + fix.**  
Section 11 states webhook validation checks "a shared secret in the request header." The CSMS stub contract shows: `Header: X-CSMS-Signature: {hmac-sha256 of body, shared secret}`. The correct check is to compute `HMAC-SHA256(body, secret)` and compare it to the header value in constant time. Checking only that the header contains the secret string is both weaker (no body integrity) and likely wrong (the header carries the HMAC output, not the raw secret). A forged webhook could submit fraudulent session.stop events and trigger incorrect invoices. **Fix:** Implement the standard HMAC-SHA256 verification: parse the header as a hex/base64 digest, compute `HMAC-SHA256(raw_body, shared_secret)`, compare with `crypto.timingSafeEqual`. Reject requests where the signature does not match before any processing.

### H-7 — Capacity sizing arithmetic is self-contradictory (§10)

**Problem + fix.**  
Section 10 computes 864 GB/day of telemetry ingestion and then states *"gives us roughly a year of telemetry headroom"* on a 1 TB SSD. 864 GB/day fills 1 TB in approximately 28 hours, not a year. This is an order-of-magnitude arithmetic error that, if used to size a production deployment, would result in disk exhaustion on day two. **Fix:** Either (a) correct the storage estimate — 864 GB/day requires ~300 TB/year, which mandates either aggressive partitioning and archival, or a columnar/compressed time-series store rather than Postgres JSONB, or (b) revisit the per-row size estimate. 2 KB per telemetry row for `{charger_id, ts, jsonb}` is plausible but unverified; compress the JSONB payload (Postgres TOAST) and measure. The sizing section must close with a retention and archival policy that reconciles ingest rate with storage budget.

---

## Medium Tier

- **Single Redis SPOF on freshness path (§8):** Redis holds the live-status cache and user sessions. A Redis restart invalidates all in-flight dashboard views and forces re-authentication. For a 99.9% SLA, Redis must run in Sentinel or Cluster mode with at least one replica.

- **Single Kafka broker with replication factor = 1 (§2, §13):** Section 13 defers Kafka redundancy to "a later phase." A single broker with RF=1 is both a data-loss risk (broker failure = in-flight events lost before consumer commit) and an ingestion-outage risk. At production scale, all telemetry flows through this single point. Fix: minimum 3-broker cluster, RF=3, `min.insync.replicas=2` from day one.

- **Timestamps not normalised to UTC (§7, brief §"Data notes"):** The brief explicitly states timestamps arrive in the charger's local timezone with offset. Section 7 does not normalise before computing daily settlement buckets. Sessions straddling a DST boundary or spanning India/Germany will be bucketed incorrectly. Fix: normalise all `ts` fields to UTC on ingestion in the Ingestion Service before publishing to Kafka.

- **Observability measures host CPU/RAM, not end-to-end freshness (§12):** Section 12 lists host metrics and HTTP error rates. None of these prove or disprove the contractual KPIs. A charger can be emitting stale data silently while CPU is healthy. Fix: instrument the ingestion-to-dashboard latency end-to-end — timestamp each event at CSMS boundary entry, Kafka publish, consumer write, and API response; export a histogram; alert when P99.9 exceeds the KPI threshold. This is the only way to prove the SLA is being met.

- **Non-idempotent consumers corrupt cumulative state (§3):** Kafka's at-least-once delivery means consumers may re-process events on rebalance or restart. For status and session consumers, a non-idempotent write (plain INSERT rather than upsert) will double-count cumulative energy values and corrupt utilisation analytics. Fix: all consumer writes must be idempotent upserts keyed on the natural key of the event type (`charger_id + ts` for meter values, `session_id` for sessions).

- **99.9% SLA incompatible with manual failover and single nodes (§9, §8, §13):** Three single-node components (Postgres primary, Redis, Kafka broker) plus manual failover targeting 5-minute RTO produces an availability budget that cannot support 99.9% monthly (~43 minutes of allowed downtime). A single failover event that takes 10 minutes to resolve already blows the monthly budget. Fix: automated failover for all stateful components, minimum two replicas each, and a quarterly DR drill to validate RTO.

---

## What I Would Verify or Ask Before Sign-Off

1. **True contractual RPO.** The SLA document and the customer contract must be read together. If the contract actually allows RPO of "seconds" rather than zero, sync replication may be unnecessary — but the draft must not claim RPO 0 without it.

2. **Is `meter_value` (live power) delivered via webhook or poll-only?** The CSMS stubs show `meter_value` events in poll responses (stubs 1a) and no `meter_value` events in any webhook batch. If power readings are poll-only with a 30-second floor, the contractual <10 s P99.9 for "active session power & energy" is physically unmeetable. This must be confirmed with the vendor and either the KPI must be renegotiated or a vendor-side push capability identified.

3. **Full tariff model.** Section 7 mentions per-CPO tariff (per-kWh + session fee) and currency conversion but gives no detail. Taxes (GST in India, VAT in Germany), time-of-day pricing, and idle fees all affect the settlement path. The settlement consumer must be re-designed once the full tariff structure is known.

4. **Expected tenant (CPO) count and isolation requirements.** The draft describes a shared-schema multi-tenant model. If the CPO count is large or if any CPO contractually requires logical or physical data isolation (common in enterprise deals), the shared-schema + RLS approach may need to give way to schema-per-tenant or database-per-tenant. The isolation model must be decided before the data layer is built.
