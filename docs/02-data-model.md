# Data Model

Everything lives in the `kh` schema. Migrations are in [`db/migrations/`](../db/migrations),
applied in order by [`db/migrate.mjs`](../db/migrate.mjs).

```
                                     ┌──────────────────┐
                    ┌───────────────▶│    customers     │
                    │                └────────┬─────────┘
                    │                         │ 1
              ┌─────┴──────┐                  │ n
              │ geofences  │         ┌────────▼─────────┐        ┌──────────────┐
              └────────────┘         │      orders      │◀──n────│ order_items  │
                                     └────────┬─────────┘        └──────────────┘
                                              │ 1
                                              │ n
   ┌───────────────────┐              ┌───────▼───────────┐
   │ shipping_companies│──────1:n────▶│ tracking_sessions │◀───1:1──┐
   └────────┬──────────┘              └───┬───────────┬───┘         │
            │ 1:n                         │ 1:n       │ 1:n   ┌─────┴──────────┐
     ┌──────▼──────┐  ┌─────────┐         │           │       │ session_devices│
     │  vehicles   │  │ drivers │         │           │       └────────────────┘
     └─────────────┘  └─────────┘         │           │
                                 ┌────────▼──────┐  ┌─▼───────────────┐
                                 │session_events │  │ ingest_batches  │
                                 └───────────────┘  └─────────────────┘
                                              │
                                     ┌────────▼────────────────────┐
                                     │  location_points            │
                                     │  (TimescaleDB hypertable)   │
                                     └────────┬────────────────────┘
                                              │ continuous aggregate
                                     ┌────────▼────────────────────┐
                                     │  location_points_1min       │
                                     └─────────────────────────────┘
```

## Why `tracking_sessions` carries three responsibilities

It is simultaneously:

1. **The join** between an order and a carrier.
2. **The security principal** — `claim_code`, `token_version`, one bound device
   (ADR-009). Drivers work for third parties and rotate constantly; we will not
   run an identity system for people who are not our employees.
3. **The denormalised live state** — `last_lat/lon/speed/bearing/battery`,
   `points_total`, `distance_m`.

(3) is the load-bearing one. The fleet map must answer *"where is everything
right now"* with a single index scan on a table of thousands of rows, never a
`DISTINCT ON` over a hypertable of hundreds of millions. Those columns are
advanced only by `kh.ingest_points`, and only when the incoming batch is
**newer** than what is already stored — which is what stops a late offline
upload from dragging the live marker backwards.

## `location_points`: the design decisions that matter

```sql
CONSTRAINT pk_location_points PRIMARY KEY (session_id, client_point_id, recorded_at)
```

Three properties fall out of this one line:

| Property | Mechanism |
|---|---|
| **Idempotency** | `client_point_id` is a device-generated ULID. A retried batch is `ON CONFLICT DO NOTHING`. The device can therefore retry forever, free of charge. |
| **Timescale compatibility** | The partitioning column (`recorded_at`) must appear in every unique index on a hypertable, so it is the trailing member. |
| **Insert locality** | ULIDs are time-ordered, so a 8,600-row offline flush appends at the right edge of the B-tree instead of scattering random UUIDs across it. |

Additional choices:

- **Column order** is fixed-width-first to minimise per-row alignment padding.
  At 450 M rows a wasted 8 bytes is 3.6 GB.
- **`is_backfill`** is stamped at insert time by comparing against the session's
  previous `last_point_at`. It is what lets the dashboard render late-arriving
  geometry in a different colour.
- **`is_mock`** is recorded, never filtered. A spoofed route is evidence in a
  carrier dispute; silently dropping those points would destroy it.
- **`elapsed_realtime_ns`** is the monotonic clock. If a driver changes the
  phone's time mid-shift, `recorded_at` still comes from GPS satellites (ADR-011),
  but this is the tiebreaker of last resort.
- **Never UPDATEd.** The table is strictly append-only, which is what makes
  columnar compression viable.

### Storage maths

| | Raw | Compressed |
|---|---|---|
| Row size (incl. index overhead) | ~150 B | ~10 B |
| 450 M rows/year @ 250 trucks | ~65 GB | **~4 GB** |
| 10 trucks (realistic year one) | ~2.6 GB | ~200 MB |

`segmentby = session_id` means a route query decompresses only that truck's
data. `orderby = recorded_at DESC` matches the read index, so ordered scans stay
ordered after compression.

## `kh.ingest_points` — the write path in one call

Full source: [`db/migrations/0004_ingest_function.sql`](../db/migrations/0004_ingest_function.sql).

```
API  ──  SELECT kh.ingest_points($1,$2,$3,$4,$5,$6,$7,$8)  ──▶  Postgres
                                                                   │
   ┌───────────────────────────────────────────────────────────────┘
   │ 1  SELECT … FOR UPDATE on the session   (serialises per-session)
   │ 2  jsonb_to_recordset → set-based validation
   │ 3  INSERT … ON CONFLICT DO NOTHING      (idempotency)
   │ 4  window function → distance chain, GPS-teleport rejection
   │ 5  monotonic session-state advance
   │ 6  batch receipt + anomaly events
   └─▶ jsonb envelope: accepted / duplicates / rejected / live / policy
```

**Distance accuracy.** The in-flight calculation chains the newly accepted points
to the session's previous last position, skipping segments where either endpoint
has accuracy worse than 150 m or the implied speed exceeds 60 m/s. That is exact
for the normal case and for sequential offline flushes; out-of-order chunk
delivery can undercount slightly, so `kh.finalize_session` calls
`kh.recompute_session_distance` for the authoritative figure at close.

## Query patterns and the indexes that serve them

| Question | Query | Index |
|---|---|---|
| Where is everything now? | `SELECT * FROM kh.v_live_fleet WHERE status IN (…)` | `ix_sessions_live` |
| Draw session X's route | `kh.session_route(id, 8)` | `ix_lp_session_time` + chunk pruning |
| Replay with a scrubber | `/playback` — even decimation via `row_number() % stride` | same |
| Where did we lose signal? | window `lag(recorded_at)` over the session | same |
| Speed profile over 14 h | `location_points_1min` | `ix_lp1min_session` |
| Did anyone spoof GPS? | `WHERE is_mock` | `ix_lp_mock` (partial) |
| What was in batch B? | `WHERE batch_id = …` | `ix_lp_batch` (partial) |
| Which carriers are reliable? | `kh.v_carrier_performance` | sequential over sessions (small) |

Note the **even decimation** in `/playback`: `WHERE rn % stride = 0` preserves
the temporal shape of a route — a two-hour stop still looks like a two-hour stop.
A naive `LIMIT 4000` would return only the first fraction of the journey.

## Uniqueness rules worth knowing

```sql
-- Only one live session per order. Two dispatchers racing get a 409, not a mess.
CREATE UNIQUE INDEX uq_sessions_one_live_per_order
  ON kh.tracking_sessions (order_id)
  WHERE status IN ('ASSIGNED','CLAIMED','ACTIVE','PAUSED');

-- Claim codes are unique only while live, so codes are safely reusable later
-- and the index stays tiny.
CREATE UNIQUE INDEX uq_sessions_claim_code
  ON kh.tracking_sessions (claim_code) WHERE claim_code IS NOT NULL;

-- Exactly one active device per session.
CREATE UNIQUE INDEX uq_session_active_device
  ON kh.session_devices (session_id) WHERE revoked_at IS NULL;
```

## Retention

| Data | Retention | Rationale |
|---|---|---|
| `location_points` raw | 2 years, compressed after 14 days | Operational; disputes surface within weeks |
| `location_points_1min` | Indefinite | ~1/60th the volume; permanent route history |
| `session_events` | Indefinite | The audit trail. Tiny and legally useful |
| `ingest_batches` | Indefinite | Answers "did we receive anything at 14:00?" |
| `refresh_tokens` | Pruned 30 days after expiry | Nightly job |
