# Backend Design

Source: [`apps/api/`](../apps/api). NestJS 11 on Fastify, TypeScript, `pg`.

## Module map

| Module | Responsibility |
|---|---|
| `config` | Eager, validated config. A missing secret crashes at boot, not at 03:00. |
| `database` | `pg.Pool` wrapper. `search_path=kh,public`, `timezone=UTC`, statement timeouts, slow-query logging, one-shot retry on 40001/40P01. |
| `redis` | Session auth cache, HMAC nonce store, rate limiter, leader locks. |
| `auth` | Dispatcher login (Argon2id + rotating refresh with reuse detection), the global `UserAuthGuard`, and `DriverSessionGuard`. |
| `sessions` | Session lifecycle, claim-code hand-off, driver claim/refresh/events, the QR landing page. |
| `ingest` | The write path. One DB round trip per batch. |
| `realtime` | Socket.IO gateway + the publisher that owns the event taxonomy. |
| `tracking` | Route geometry, playback, coverage gaps, speed profile, NDJSON export. |
| `catalog` | Orders, customers, carriers, vehicles, drivers. |
| `jobs` | Cron maintenance behind Redis leader locks. |

## Request pipeline

```
Fastify
  ├─ preParsing hook          gunzip / inflate / brotli request bodies
  ├─ content-type parser      parses JSON *and keeps req.rawBody* for HMAC
  ├─ helmet, cors, compress
  ├─ UserAuthGuard (global)   every route protected unless @Public()
  │    └─ DriverSessionGuard  on @Public() driver routes: stricter, not looser
  ├─ ValidationPipe           whitelist + transform
  └─ AllExceptionsFilter      uniform { error: { code, message }, serverTime }
```

Two details worth calling out.

**Raw body preservation.** The HMAC covers `sha256(rawBody)`. Re-serialising the
parsed object would produce different bytes (key order, number formatting,
whitespace), so the exact bytes must be kept.

This uses Nest's own `rawBody: true` option rather than a hand-rolled
content-type parser. The Fastify adapter registers its JSON parser with
`parseAs: 'buffer'` during `init()`, so adding one beforehand throws
`FST_ERR_CTP_ALREADY_PRESENT` and the process never starts.

Note the interaction with decompression: the `preParsing` hook inflates the
stream *before* the parser sees it, so `rawBody` — and therefore the signature —
covers the **uncompressed** JSON. The hook also rewrites `Content-Encoding` to
`identity` so no later hook tries to inflate plain text a second time.

**Fail-closed auth.** `UserAuthGuard` is registered as `APP_GUARD`, so forgetting
a decorator yields a 401 rather than an open endpoint. Driver routes carry
`@Public()` to escape the *dispatcher* guard and then `@UseGuards(DriverSessionGuard)`,
which is strictly stricter.

## The ingest hot path

```
POST /api/v1/ingest/batch
  ├─ DriverSessionGuard
  │    1. JWT verify                    CPU only, no I/O
  │    2. session auth                  Redis GET (Postgres only on miss)
  │    3. lifecycle (SESSION_CLOSED)    in-memory  ← before revocation, see below
  │    4. token_version + device match  in-memory
  │    5. request rate limit            one Redis EVAL
  │    6. HMAC timestamp window         CPU only
  │    7. nonce claim                   one Redis SET NX
  │    8. signature compare             constant-time
  ├─ IngestService
  │    • normalisePoints()   O(n), no reflection, ~4 ms for 5 000 points
  │    • point quota         one Redis EVAL
  │    • kh.ingest_points()  ONE database round trip
  │    └─ broadcast()        fire-and-forget, never blocks the truck
  └─ 202 { accepted, duplicates, rejected, serverTime, policy, nextAction }
```

Checks are ordered cheapest-and-most-likely-to-reject first: a forged token
costs one signature verification, not a database round trip.

**Lifecycle before revocation (step 3 before step 4).** `finalize_session`
revokes the bound device *and* bumps `token_version`, so checking revocation
first made a completed delivery report `TOKEN_REVOKED` — or, when the device row
was the only thing being looked up, `SESSION_NOT_FOUND`. Both are misleading:
the session exists and the job is simply done. Resolving the session even when
it has no active device, and testing the lifecycle first, makes the most
specific explanation win. Two e2e assertions pin this.

### Why not class-validator on every point

`@ValidateNested({ each: true })` over 5,000 points is ~150 ms of reflection per
request, for validation the database performs anyway, set-based, inside
`kh.ingest_points`. `normalisePoints` instead does one narrow job: guarantee
every value is *castable* by `jsonb_to_recordset`, because a single
`"lat": "abc"` would abort the whole batch with a cast error and cost the driver
5,000 points. Semantic validation (bounds, timestamp windows, Null Island) stays
in SQL.

### Response as instruction, not inference

Every ingest response carries:

- `serverTime` — the device recomputes its clock offset (ADR-011).
- `policy` — a dispatcher can retune ping frequency mid-shift with no push channel.
- `nextAction: "CONTINUE" | "PAUSE"` — an explicit instruction rather than
  something the client has to derive from a status string.

## Realtime fan-out (ADR-006)

[`RealtimePublisher`](../apps/api/src/realtime/realtime.publisher.ts) is the only
component that writes to sockets, and it enforces two rules.

**Event taxonomy.**

| Event | Room | Meaning | Client behaviour |
|---|---|---|---|
| `position:update` | `session:{id}` | Newer than anything seen | Move the marker |
| `route:backfill` | `session:{id}` | Recorded in the past, uploaded late | Splice geometry, **do not** move the marker |
| `session:state` | both | Lifecycle change | Update the badge |
| `session:event` | `session:{id}` | GPS_LOST, SERVICE_KILLED, arrival… | Append to timeline |
| `ingest:stats` | `session:{id}` | Per-batch accepted/dup/lag | Diagnostics panel |
| `fleet:positions` | `fleet:live` | Coalesced array | Update the map source |

Without the update/backfill split, a truck emerging from a dead zone makes its
own marker rewind across the map for several seconds. This is the single most
common bug in home-grown tracking systems.

**Coalescing.** Detail subscribers get everything immediately — they are watching
one truck. The fleet room receives a last-value-wins frame at most once per
second. With 250 trucks at 5 s intervals that is 1 msg/s carrying an array
instead of ~50 individual frames, which is what keeps a browser tab at 60 fps.

Backfill broadcasts are capped at 2,000 points; beyond that the client is told
to refetch the server-simplified route over HTTP rather than have a 10,000-point
array pushed down a WebSocket.

**Horizontal scale.** `RedisIoAdapter` wires `@socket.io/redis-adapter` so
`server.to(room).emit()` reaches clients on every replica. Without it, scaling
to two containers means half the dispatchers stop seeing half the trucks.

## Scheduled maintenance

All in [`MaintenanceService`](../apps/api/src/jobs/maintenance.service.ts), each
wrapped in a Redis leader lock whose TTL is shorter than its interval — so a
crashed leader is replaced on the next tick with no coordination protocol.

| Job | Interval | What it does |
|---|---|---|
| `expireSessions` | 1 min | Unused claim codes, sessions past `max_lifetime_hours` |
| `detectArrivals` | 30 s | Destination geofence entry → timeline event |
| `detectSilence` | 5 min | ACTIVE but no fix for 15 min → `GPS_LOST` + dashboard alert |
| `pruneTokens` | daily 03:00 | Expired/revoked refresh tokens |

`detectSilence` is the one that saves shipments. The server cannot distinguish
"dead zone" from "dead battery" from "OEM killed the service", so it surfaces the
fact rather than guessing, and a dispatcher phones the driver.

## Error contract

The Android client's entire retry policy branches on `error.code`, so the codes
are the contract and the messages are for humans:

| Code | HTTP | Client behaviour |
|---|---|---|
| `TOKEN_EXPIRED` | 401 | Refresh, retry the same batch |
| `TOKEN_REVOKED` / `DEVICE_MISMATCH` | 401/403 | Stop; driver needs a new code |
| `SESSION_CLOSED` | 403 | Stop the service, **keep** the buffer |
| `RATE_LIMITED` | 429 | Back off `retryAfterSec` |
| `BATCH_TOO_LARGE` | 413 | Halve the chunk, retry |
| `CLOCK_SKEW` | 401 | Resync from `serverTime`, retry |
| 5xx / network | — | Exponential backoff, keep buffering |

Every response — errors included — carries `serverTime`.

## Performance notes

Measured on a 4 vCPU / 16 GB Hetzner CCX23:

| Operation | Latency |
|---|---|
| Single ping (guard + ingest + broadcast) | ~4–8 ms |
| 500-point batch | ~35–60 ms |
| 5,000-point offline flush | ~180–400 ms |
| Fleet snapshot, 250 sessions | ~6 ms |
| `session_route` over 7,000 points, simplified | ~45 ms |

The peak from ADR-001 (50 pts/s fleet-wide) uses roughly 2% of one core.
