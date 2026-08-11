# Architecture Decision Records — KaraHoca Shipping

Status legend: **Accepted** = build it this way.

---

## ADR-001 — Load profile drives every other decision

**Accepted.**

Before choosing anything, size the problem honestly:

| Quantity | Realistic value | Peak assumption used for design |
|---|---|---|
| Concurrent trucks | 5–40 | 250 |
| Ping interval (moving) | 8 s | 5 s |
| Sustained write rate | ~5 pts/s | **50 pts/s** |
| Points per truck-day (10 h shift) | ~4,500 | 7,200 |
| Points per year @ 250 trucks | — | ~450 M rows |
| Offline backlog burst | 2 h tunnel = 900 pts | 12 h = 8,600 pts in one request |

**Consequence:** this is a *small* write workload with a *large* retention footprint and
*bursty* batch arrivals. It does **not** need Kafka, Cassandra, a stream processor, or a
Go rewrite. It **does** need time-series storage discipline (compression, retention) and
an ingest path that survives a single request carrying 10,000 points.

Every ADR below is justified against this table, not against imagined web scale.

---

## ADR-002 — Backend: NestJS 11 on Fastify (TypeScript)

**Accepted.** Alternatives considered: Go + Chi, Python + FastAPI, Elixir + Phoenix.

**Why:**

- **One language across the whole stack** (API, web, shared DTO/validation contracts).
  For a factory IT team of 1–3 people, the ability of any engineer to move between the
  dashboard and the API without a context switch is worth more than raw throughput.
- **Fastify adapter** gives ~30–45k req/s on a 2-vCPU Hetzner box — three orders of
  magnitude above ADR-001's peak.
- NestJS's module/DI structure keeps the *boring* parts (guards, interceptors,
  validation pipes, lifecycle hooks) uniform, which is exactly what stops a
  self-maintained internal system from rotting.
- First-class WebSocket gateway + BullMQ integration, both of which we need.

**Why not Go:** we would gain throughput we demonstrably do not need, and lose the shared
type contract with the Next.js dashboard. Revisit only if sustained ingest exceeds
~2,000 pts/s.

**Why not Elixir/Phoenix:** technically the *best* fit for soft-realtime fan-out, but it
puts the system on a language your team cannot hire for or debug at 2 a.m.

**Consequence:** heavy per-batch work is pushed into a single PL/pgSQL function
(ADR-005) so Node never loops over 10,000 points in JS.

---

## ADR-003 — Database: one PostgreSQL 16 with TimescaleDB + PostGIS

**Accepted.** Alternatives: Postgres alone, Postgres + InfluxDB, Postgres + ClickHouse,
MongoDB time-series collections.

**Why a single database:**

Self-hosting means every additional stateful service is another thing to back up,
monitor, upgrade, and restore under pressure. One Postgres gives us:

- **TimescaleDB hypertable** for `location_points` — transparent time partitioning,
  native columnar compression (**~10–20× on GPS telemetry**, which is highly repetitive),
  automatic retention, and continuous aggregates for route rollups.
  450 M rows/year becomes ~25–40 GB compressed instead of ~450 GB.
- **PostGIS** for `geography(Point,4326)` — correct spheroidal distance, geofence
  containment for automatic arrival detection, and `ST_SimplifyPreserveTopology` so the
  dashboard can render a 7,000-point route as 400 points without a JS simplifier.
- **Relational integrity** between orders, carriers, and sessions in the same
  transaction as the telemetry. A tracking session is a business record, not a metric.

**Licensing note:** compression and continuous aggregates are TimescaleDB **Community
(TSL)**. TSL permits unrestricted internal self-hosted use; it only forbids offering
TimescaleDB *as a managed service to third parties*. KaraHoca is a detergent
manufacturer — this is fine. The `timescale/timescaledb-ha` image bundles PostGIS.

**Why not InfluxDB/ClickHouse:** a second stateful system, a second backup story, and
cross-store joins in application code for what is fundamentally one query pattern.

---

## ADR-004 — Redis (Valkey) for pub/sub, hot state, replay defence, and jobs

**Accepted.**

Four distinct jobs, one process:

1. **Socket.IO Redis adapter** — lets the API scale past one container while dispatchers
   stay in the right rooms.
2. **Hot session cache** — `session:{id}:auth` holds status + token version, so the
   ingest hot path validates a driver token with an O(1) Redis GET instead of a
   Postgres round trip on every ping.
3. **Nonce store** for HMAC replay protection (TTL = clock-skew window).
4. **Leader locks** (`SET NX EX`) so scheduled maintenance — stale-session
   expiry, arrival detection, silence alerts, token pruning — runs on exactly
   one API replica. The jobs themselves are `@nestjs/schedule` cron methods
   rather than a queue: they are idempotent, cheap, and have nothing to retry,
   so a queue would be ceremony. Introduce BullMQ when work appears that
   genuinely needs durable retries (customer-facing webhooks, PDF reports).

Redis holds **no** durable truth. A full Redis flush costs a cache miss storm, nothing
more.

---

## ADR-005 — Ingest is a single PL/pgSQL function call per batch

**Accepted.** This is the most important performance decision in the system.

A naive implementation does, per batch of 8,600 points: 8,600 INSERTs, 8,600
duplicate checks, a JS loop computing Haversine distance, and an UPDATE. That is
~30 s of round trips and a blocked event loop.

Instead the API sends **one** call:

```sql
SELECT * FROM kh.ingest_points($1::uuid, $2::uuid, $3::jsonb);
```

Inside the function, in one transaction:

1. `SELECT ... FOR UPDATE` on the session row (serialises per-session, never globally).
2. `jsonb_to_recordset` → set-based validation (lat/lon bounds, timestamp window,
   accuracy sanity, mock-location flag).
3. One `INSERT ... ON CONFLICT DO NOTHING` — idempotency comes from the primary key
   `(session_id, client_point_id, recorded_at)`, so a retried batch is a no-op.
4. A window function chains consecutive accepted points, discards GPS teleports
   (implied speed > 60 m/s or accuracy > 150 m), and accumulates `ST_Distance` on the
   geography type.
5. Denormalised session state (`last_point_at`, `last_lat/lon`, `distance_m`,
   `points_total`) is advanced **only if the batch is newer** — so a late offline
   backfill never drags the live marker backwards.
6. Returns accepted / duplicate / rejected counts.

**Consequence:** a 10,000-point offline dump lands in ~150–400 ms, atomically, with zero
duplicates, and Node's event loop is free the entire time.

---

## ADR-006 — Realtime: Socket.IO with Redis adapter, and *two distinct* event classes

**Accepted.** Alternatives: raw `ws`, SSE, MQTT.

Socket.IO buys automatic reconnection with backoff, rooms, acknowledgements, and
transparent transport fallback for dispatchers on flaky factory Wi-Fi. The Redis adapter
makes the API horizontally scalable.

The non-obvious decision is the **event taxonomy**, which exists because of offline
backfill:

| Event | Meaning | Dashboard behaviour |
|---|---|---|
| `position:update` | A point that is *newer* than everything seen for this session | Move the truck marker, extend the polyline head |
| `route:backfill` | Points recorded in the past, uploaded late | Splice into the polyline **without** moving the marker |
| `session:state` | Lifecycle / connectivity / battery change | Update the badge, not the geometry |

Without this split, a truck emerging from a dead zone would make its marker rewind
across the map for several seconds. This is the single most common bug in home-grown
tracking systems.

**Fan-out shape:** the ingest transaction publishes to Redis; every API instance's
gateway relays to `session:{id}` (detail view) and `fleet:live` (overview map). The
overview room receives a **throttled, coalesced** payload (max 1 msg/sec/session,
last-value-wins) so a 40-truck fleet map is ~40 msg/s, not 400.

---

## ADR-007 — Web: Next.js 15 + MapLibre GL JS (no Google Maps)

**Accepted.**

- **MapLibre GL JS** over Google Maps / Mapbox GL: BSD-licensed, no per-map-load
  billing, and — decisive given the self-hosting constraint — the tile source is
  swappable. Start on a hosted free style, move to a self-hosted
  `protomaps`/`tileserver-gl` container later **without touching application code**.
  Vector tiles also render 40 animated markers at 60 fps, which raster+DOM markers do not.
- **Next.js App Router** for the shell, but the live map is a hard client component:
  no SSR of realtime state, no hydration mismatch games.
- **TanStack Query** for REST reads with the socket acting as a cache-invalidation and
  patch channel — not as the primary data source. On reconnect the dashboard refetches a
  snapshot rather than trying to replay missed socket frames.

---

## ADR-008 — Android: native Kotlin. Not Flutter, not React Native, not a PWA

**Accepted.** This is non-negotiable and worth stating loudly.

The entire value of the driver app is **surviving hostile OS power management**. That
means direct, unmediated access to:

- `FusedLocationProviderClient` with precise `Priority`/interval control
- `ForegroundServiceType.LOCATION` and the Android 14/15 FGS lifecycle rules
- `PowerManager.WakeLock` and `isIgnoringBatteryOptimizations`
- `AlarmManager.setExactAndAllowWhileIdle` for the resurrection watchdog
- `onTaskRemoved` for swipe-away recovery
- `BOOT_COMPLETED` / `MY_PACKAGE_REPLACED` receivers
- OEM-specific autostart settings intents (Xiaomi, Huawei, Oppo, Vivo, Samsung)
- `WorkManager` with expedited jobs and network constraints
- Room + SQLite WAL for a crash-safe local buffer

Every cross-platform framework abstracts at least three of these behind a plugin you
would end up forking. A **PWA is disqualified outright** — the Geolocation API is
suspended when the browser is backgrounded and there is no foreground-service equivalent.

Stack: **Kotlin 2.1, Jetpack Compose, Hilt, Room, WorkManager, Retrofit/OkHttp, Coroutines +
Flow**, `minSdk 26`, `targetSdk 35`.

**Distribution:** sideloaded signed APK, not Play Store. This is a deliberate advantage —
it frees us from the Play policy restrictions on `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`
and background location justification, both of which we legitimately need for a
company-owned logistics tool running on a consenting employee's device during a shift.
In-app updates are handled by a version-check endpoint + `PackageInstaller`.

---

## ADR-009 — Security: per-session capability tokens, not driver accounts

**Accepted.**

Drivers work for *third-party* companies. We will not run an identity system for people
who are not our employees and who rotate constantly. Instead the **tracking session
itself is the security principal**.

Flow:

1. Dispatcher creates a session → server mints a short, human-typeable **claim code**
   (Crockford Base32, e.g. `K7H2-9QX4`) with a TTL and a single-use guarantee, plus a
   deep link `karahoca://track?c=…` and a QR code.
2. Driver enters the code → `POST /driver/claim` binds the session to **one device**
   (hardware fingerprint) and returns:
   - `access_token` — JWT, `aud: "driver-ingest"`, `sid` claim, 24 h TTL
   - `refresh_token` — opaque, hashed at rest, lives as long as the session
   - `ingest_key` — 32 random bytes, used for per-request HMAC
3. Every ingest request carries `Authorization: Bearer`, `X-KH-Timestamp`, `X-KH-Nonce`,
   and `X-KH-Signature = HMAC-SHA256(ingest_key, ts.nonce.sha256(body))`.

This gives us, without any driver PII beyond a name and phone:

- **Scope containment** — a leaked token can only write points to one session.
- **Automatic expiry** — the token dies when the session is completed or expires.
- **Instant revocation** — bumping `token_version` on the session row invalidates
  everything through the Redis auth cache.
- **Replay protection** — nonce + timestamp window, with the server returning
  `serverTime` on every response so devices with wrong clocks self-correct.
- **Tamper evidence** — the HMAC means a stolen bearer token alone cannot forge points.
- **Anti-spoofing** — `isMock` is recorded per point, never silently dropped, and
  surfaced to dispatchers.

Dispatchers use ordinary email/password + Argon2id + refresh-token rotation, with
optional TOTP.

---

## ADR-010 — Offline-first is a storage problem, not a networking problem

**Accepted.**

The requirement "must never lose a coordinate" means the **network is never in the
acquisition path**. The GPS callback's only job is to write a row to SQLite and return.

```
FusedLocation callback ──▶ Room INSERT (WAL, synchronous=NORMAL) ──▶ return
                                   │
                     (completely independent)
                                   │
        ┌──────────────────────────┴──────────────────────────┐
        │  Realtime pump: every 10 s, if online, ship a batch  │
        │  SyncWorker: WorkManager, NetworkType.CONNECTED,     │
        │              exponential backoff, expedited          │
        └──────────────────────────────────────────────────────┘
```

Design rules that follow:

- Points are **claimed** into an in-flight batch (`batch_id` + state) before upload, so a
  process death mid-upload cannot lose or duplicate them. Stale in-flight claims older
  than 5 minutes are reset to `PENDING` on next run.
- Rows are deleted **only** on a `2xx` acknowledgement that names them.
- Every point gets a client-generated **ULID** at creation time — the idempotency key
  for ADR-005. Retries are free.
- The buffer is a **bounded ring** (default 500,000 rows ≈ 30+ truck-days). At capacity
  it evicts the oldest and records a `BUFFER_OVERFLOW` session event, rather than
  crashing or silently stopping.
- Request bodies are **gzipped** — a 10,000-point backlog compresses from ~2.4 MB to
  ~250 KB, which matters on a 2G edge connection at the moment coverage returns.
- On reconnect the worker uploads **oldest-first in chunks of 500** so the map fills in
  chronologically and a single bad chunk cannot block the rest.

---

## ADR-011 — Time: three timestamps per point, and we trust the satellites

**Accepted.**

Every point carries:

| Field | Source | Used for |
|---|---|---|
| `recorded_at` | `Location.getTime()` — **GPS-derived UTC**, not the phone clock | The authoritative fix time |
| `received_at` | Server `now()` | Latency measurement, offline-gap detection |
| `elapsed_realtime_ns` | `Location.getElapsedRealtimeNanos()` | Monotonic ordering immune to clock changes |

A driver changing the phone's timezone or clock mid-shift is common and must not corrupt
a route. GPS fixes carry satellite time, so `recorded_at` stays correct. For the HMAC
timestamp (which *does* use the wall clock) the client stores a server-time offset
returned on every response and signs with the corrected value.

---

## ADR-012 — Deployment: Docker Compose on Coolify, not Kubernetes

**Accepted.**

A single Hetzner CCX23 (4 vCPU / 16 GB / 160 GB NVMe, ~€25/mo) runs this entire system
with room for 10× the peak in ADR-001. Coolify gives us Git-push deploys, TLS via Let's
Encrypt, secret management, health checks, and log aggregation without operating a
control plane.

Scaling path, in order, before anyone says "Kubernetes":
1. Vertical: CCX33 → CCX43.
2. `deploy.replicas` on the API (stateless; Redis adapter already handles fan-out).
3. Move Postgres to a dedicated box + streaming replica.
4. Split `ingest` into its own service sharing the database.

**Backups:** `pgBackRest`-style nightly `pg_dump` + WAL archiving to Hetzner Storage Box
via a sidecar, with a *restore drill documented and rehearsed quarterly*. An untested
backup is not a backup.
