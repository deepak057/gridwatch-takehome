# GridWatch — Take-Home Submission

A centralised monitoring platform for EV charging networks: it ingests vendor CSMS feeds, normalises a messy at-least-once / out-of-order / wrong-units stream into a clean internal model, and serves a live operational picture (status rollup + GIS "nearest available charger").

This repo contains all three parts of the assignment.

## Repository layout

| Path | What |
|---|---|
| `architecture/part-a-design.md` | **Part A** — production architecture & design (the main document) |
| `architecture/diagrams.md` | System diagrams referenced by Part A |
| `review/part-b-architecture-review.md` | **Part B** — ranked review of the provided flawed draft |
| `code/` | **Part C** — the runnable "hardest slice": NestJS + PostgreSQL/PostGIS, Docker Compose, Terraform (IaC), tests |

---

## Part C — How to run the slice

**Prerequisite:** Docker Desktop (with Compose).

### 1. Bring it up (one command)

```bash
cd code
docker compose up --build
```

This starts **PostGIS** and the **NestJS service**; the service waits for the database (healthcheck + connect-retry) and runs schema migrations on boot. Health check:

```bash
curl http://localhost:3000/health           # {"status":"ok","db":true}
```

### 2. The two aggregates (the useful, correct outputs)

```bash
# Live status rollup for a site (counts by status; stale/missing → "Unknown")
curl "http://localhost:3000/sites/S-IN-0007/status-rollup"

# Nearest AVAILABLE charger to a point (PostGIS KNN, availability-filtered)
curl "http://localhost:3000/chargers/nearest?lat=28.57&lng=77.33"
```

Plus `POST /webhook` — accepts HMAC-signed CSMS event batches (ack-first, then processed).

### 3. Run the tests (the point of the slice)

With the stack up (so the database is available on `localhost:5432`):

```bash
cd code
npm install
DATABASE_URL=postgres://gridwatch:gridwatch@localhost:5432/gridwatch \
CSMS_WEBHOOK_SECRET=test-secret \
npm test
```

**36 tests**, all against a live PostGIS database, aimed at the failure modes — not coverage. They prove: duplicate delivery is billed once, out-of-order status converges to newest-wins, a meter reset never produces a negative invoice, 429 honours `Retry-After`, a malformed event is quarantined without crashing the batch, and the GIS queries are correct. `test/pilot.spec.ts` runs the whole thing end-to-end.

### 4. Infrastructure-as-Code (optional, separate step)

Kept **off** the one-command path so it can never break the demo:

```bash
cd code
make iac        # starts LocalStack, terraform apply → creates the S3 dead-letter bucket
make iac-down   # tear down
```

This provisions an **S3 "dead-letter" bucket** (where malformed events are quarantined) on LocalStack via Terraform — no AWS account, no keys. The app writes rejects to S3 when configured and **falls back to a Postgres `dead_letter` table** otherwise (the fallback path is test-verified).

> **Note:** LocalStack's `:latest` image began requiring a paid auth token on 2026-03-23, so the Compose file pins the last free release (`4.4.0`). The live `terraform apply` downloads the AWS provider (~hundreds of MB), so allow a couple of minutes the first time.

---

## Design summary & decision log

Full reasoning is in **`architecture/part-a-design.md`**. The hardest calls:

1. **Postgres "inbox" table, not Kafka.** At ~5,000 events/s this isn't streaming-scale, and the genuinely hard cases (duplicate / out-of-order / dual-channel / meter-reset) are solved by the *write model* (content-derived dedup key + newest-wins upsert), not by a log. The inbox is transactional, gives a real dead-letter story, and is replayable. The `IngestQueue` seam is "Kafka-shaped" so it can be swapped at scale.
2. **Honest about freshness.** The contractual `<5 s` KPIs are physically impossible on the vendor's 30 s poll floor; only the webhook path can hit them, and it is itself batched/at-least-once/out-of-order. We state which KPIs are achievable (from the CSMS boundary inward) and which (live power, poll-only in the stubs) need renegotiation — rather than papering over it.
3. **Correctness mechanisms.** De-dup via a content-derived key shared across poll *and* webhook (no event id exists); **newest-wins by event timestamp**, per *connector* (not per charger); **meter-reset guard** (`stop < start` → flag, never bill negative); timestamps normalised to UTC before comparison.
4. **GIS.** Geocode-at-onboarding (persist coordinates once; never on the hot path) using self-hosted Nominatim / an OSM-compatible geocoder — **not Google**, whose licence forbids using its geocoding with a non-Google basemap. PostGIS `geography` + GiST index + `<->` KNN for nearest; vector tiles + viewport queries at scale.
5. **Multi-tenant isolation** via verified JWT claim + Postgres Row-Level Security — never an `operator_id` URL parameter.

---

## What was built vs. described vs. skipped

**Built & verified (Part C):** resilient CSMS poll client (429/500/malformed), ack-first HMAC-verified webhook, the inbox + de-dup + newest-wins + meter-reset core, dead-letter (Terraform/LocalStack S3 + table fallback), geocode-at-onboarding + PostGIS nearest-charger + live status rollup, 36 failure-mode tests, one-command Docker boot.

**Described in Part A, not built:** full settlement engine & multi-currency, demand forecasting (the brief says architectural-understanding-only), the dashboard/map UI (the brief says backend & correctness matter more), full HA/DR topology, observability stack.

**Consciously skipped:** see "what's next" below.

---

## Assumptions

- **Starter-kit gap:** the sample data references a "starter kit" mock CSMS that wasn't provided; per the brief ("we are not shipping a vendor service") we built a local mock from the documented stub payloads and seed the pilot catalogue from a fixture.
- **KPI clock** is measured from the **CSMS boundary** (event arrival to GridWatch), since the brief says our job begins there and we can't control CSMS-internal latency.
- **One CSMS per CPO**, behind one common interface, for this exercise.
- **Tariff** = per-kWh price + session fee in local currency (INR/EUR); taxes (GST/VAT), time-of-day, and idle fees are out of scope unless specified.
- **`connector_id` is stored as text** (the feed sends `"1"`).

---

## Where I stopped / what's next

In priority order, the next things I'd build:

1. **Live push to the dashboard** — Postgres `LISTEN/NOTIFY` → SSE, replacing client polling (the path to the `<2 s` tile KPI).
2. **Full settlement engine** — tariff application, multi-currency, site-local-day bucketing, idempotent invoicing keyed on `session_id` (the guard is built; the engine is described).
3. **Fault handling in reconcile** — map fault events to connector state (currently accepted/de-duped but not applied) and surface severity.
4. **Telemetry at scale** — TimescaleDB hypertable + tiered retention (hot DB → cold Parquet) for the 432M-rows/day firehose; the current slice keeps current-state only.
5. **Clock-skew hardening** — sanity-check event timestamps against the CSMS `server_time`.
6. **Multi-CSMS adapters**, **RLS + Keycloak/JWT auth**, and **KPI-proving observability** (per-stage P99.9 latency histograms).

---

## Notes for the reviewer

- Tests run serially against a live PostGIS (`jest.config.js` `maxWorkers: 1`; `jest.setup.ts` closes the pool after each file). The suite was hardened from an earlier flaky state — root cause was an unclean test teardown leaking pooled DB connections, fixed by a clean connection lifecycle (not by adding retries).
- Everything in this README has been run and verified locally; the IaC bucket creation was proven live (Terraform created the bucket and the app wrote an object to it).
