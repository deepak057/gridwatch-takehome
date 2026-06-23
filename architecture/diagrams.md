# GridWatch — Architecture Diagrams

## Diagram 1 — Context (what GridWatch is)

```
   CPO "Acme" (India)              CPO "Stadtwerke" (Germany)
   mixed-brand chargers            mixed-brand chargers
          │                                │
          ▼                                ▼
     ┌──────────┐                    ┌──────────┐
     │  CSMS A  │  (vendor s/w)      │  CSMS B  │   ← GridWatch starts HERE,
     └────┬─────┘                    └────┬─────┘     at the CSMS boundary;
          │  poll API + webhook           │          it never talks to chargers
          └───────────────┬───────────────┘
                          ▼
              ╔═════════════════════════╗
              ║        GRIDWATCH        ║   ingest → normalise → store →
              ║  (our platform)         ║   one live picture
              ╚════════════╤════════════╝
                           ▼
            ┌──────────────┴───────────────┐
            ▼                              ▼
     Live Dashboard                  Live GIS Map
   (status, faults,             (sites as pins, coloured
    sessions, revenue)           by status, nearest charger)
```

## Diagram 2 — Part C build slice

```
  CSMS stubs (429 / 500 / malformed / duplicate / out-of-order / meter-reset)
        │  poll                                   │  webhook (push)
        ▼                                         ▼
  ┌─────────────────┐                    ┌──────────────────┐
  │  CSMS Client    │  retry, respect    │ Webhook Receiver │  ack 2xx FIRST,
  │  (poll, paged)  │  30s / Retry-After │ (HMAC verified)  │  then process
  └────────┬────────┘  skip bad → DLQ    └────────┬─────────┘
           └──────────────────┬──────────────────-┘
                              ▼
                  ┌────────────────────────┐
                  │  raw_events  (INBOX)   │  ← Postgres table, NOT Kafka
                  │  dedup_key UNIQUE      │     (same job, simpler, defensible)
                  └───────────┬────────────┘
                              ▼
                     ┌──────────────┐         malformed ─►  S3 dead-letter
                     │  Processor   │  normalise clocks→UTC   (LocalStack/Terraform)
                     └──────┬───────┘
            ┌──────────────┼────────────────┬──────────────────┐
            ▼              ▼                ▼                  ▼
   connector_status   sessions        sites.geom          dead_letter
   (newest-wins,      (correlate by   (geocoded ONCE      (quarantine)
    per connector)     session_id)     at onboarding)
            │
            ▼
   ┌──────────────────── API (NestJS) ────────────────────┐
   │  GET /sites/:id/status-rollup   (counts, staleness)  │
   │  GET /chargers/nearest?lat&lng  (PostGIS nearest)    │
   └──────────────────────────────────────────────────────┘
            │
        docker compose up  →  app + PostGIS only on critical path (healthchecks)
```

## Diagram 3 — Event correctness flow

```
  event arrives (maybe twice, maybe out of order, maybe via both channels)
        │
        ▼
  build dedup_key  =  hash(type, charger, connector, timestamp, …)   ← no event-id exists
        │
        ▼
  INSERT INTO raw_events ... ON CONFLICT (dedup_key) DO NOTHING
        │
        ├─ already seen?  ─► ignore  (defeats DUPLICATES → no double-count / no double-bill)
        │
        ▼ new
  normalise timestamp to UTC  (so +05:30 vs +02:00 compare correctly)
        │
        ▼
  UPSERT connector_status
     WHERE incoming.event_ts  >  stored.event_ts        ← NEWEST-WINS by event time
        │
        ├─ older?  ─► ignore  (defeats OUT-OF-ORDER → stale never overwrites fresh)
        │
        ▼
  if session.stop & stop_meter < start_meter  ─► flag "meter_reset", DON'T bill negative
```

## Diagram 4 — Production architecture (Part A)

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
                   │ raw_events (inbox) │   dedup_key UNIQUE
                   └─────────┬──────────┘
   ══════════════════════════▼══════════════════════════  PROCESSING
                   ┌────────────────────┐
                   │ Normalisers        │  clocks→UTC, energy register→deltas,
                   │ (newest-wins,      │  reset detection, idempotent
                   │  per connector)    │
                   └─────────┬──────────┘
   ══════════════════════════▼══════════════════════════  STORES (right store per job)
   ┌───────────────┐ ┌───────────────┐ ┌──────────────┐ ┌─────────────────┐
   │ Hot status    │ │ Telemetry     │ │ OLTP         │ │ Spatial         │
   │ (current state│ │ time-series,  │ │ sites/sess/  │ │ PostGIS geom    │
   │  + cache) <2s │ │ tiered: hot DB│ │ invoices,    │ │ (geocoded once  │
   │               │ │ → cold object │ │ RLS by tenant│ │  at onboarding) │
   └───────┬───────┘ └───────────────┘ └──────┬───────┘ └────────┬────────┘
           └─────────────────┬─────────────────┴──────────────────┘
   ══════════════════════════▼══════════════════════════  SERVING
                   ┌────────────────────┐
                   │ API + SSE push     │  LISTEN/NOTIFY → stream changes
                   │ (tenant from JWT)  │  (no 10s client polling)
                   └─────────┬──────────┘
                  ┌──────────┴───────────┐
                  ▼                      ▼
            Live Dashboard          Live GIS Map (vector tiles, viewport queries)

   ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ CROSS-CUTTING ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
   • Freshness proof: stamp t0 at event origin → per-stage latency histograms @ P99.9
   • Multi-tenant isolation: JWT claim → Postgres RLS (FORCE) everywhere
   • HA/DR: replicated stores, automated failover, explicit RPO/RTO per component
```
