# KaraHoca Shipping — Unified 3PL Tracking Ecosystem

In-house GPS tracking for detergent shipments carried by **independent third-party
transport companies that have no tracking infrastructure of their own**.

The system replaces "the truck left the factory and we're blind until the customer
calls" with a live map, a verifiable history, and a chain of custody per order.

```
┌──────────────────────┐        ┌──────────────────────────────────────────┐
│  Driver's Android    │        │            Hetzner / Coolify             │
│  (sideloaded APK)    │        │                                          │
│                      │  HTTPS │  ┌────────┐   ┌──────────┐  ┌─────────┐  │
│  FGS + FusedLocation │───────▶│  │  API   │──▶│ Postgres │  │  Redis  │  │
│  Room ring-buffer    │ batch  │  │ NestJS │   │ +Timescale│ │ pub/sub │  │
│  WorkManager sync    │◀───────│  └───┬────┘   │ +PostGIS │  └────┬────┘  │
└──────────────────────┘  ack   │      │        └──────────┘       │       │
                                │      │  Socket.IO (rooms)        │       │
                                │      ▼                           ▼       │
                                │  ┌──────────────────────────────────┐    │
                                │  │  Web command center (Next.js)    │    │
                                │  │  MapLibre live map + history     │    │
                                │  └──────────────────────────────────┘    │
                                └──────────────────────────────────────────┘
```

## Repository layout

| Path | What it is |
|---|---|
| `docs/` | ADRs, data model, Android blueprint, backend notes, deployment runbook, API contract |
| `db/migrations/` | Ordered, idempotent SQL migrations (PostGIS + TimescaleDB) |
| `db/seed/` | Development seed data |
| `apps/api/` | NestJS + Fastify API: auth, sessions, ingest, realtime gateway, history |
| `apps/web/` | Next.js 15 command center: live map, session management, route replay |
| `android/` | Kotlin driver app: foreground service, offline buffer, sync worker |
| `infra/` | Compose stack, Caddy, backup + migration tooling |

## Quick start (Docker)

```bash
cp .env.example .env
docker compose --profile dev up -d --build
```

- API      → http://localhost:4000/api/v1/health
- Web       → http://localhost:3000
- Postgres  → localhost:5432 (`karahoca`)

The admin account is created on first boot from `ADMIN_EMAIL` / `ADMIN_PASSWORD`;
remove `ADMIN_PASSWORD` from the environment afterwards.

## Quick start (Windows, no Docker, no admin rights)

Docker Desktop needs administrator rights and WSL2. `scripts/dev-stack.ps1`
provisions the same component versions the compose file pins — PostgreSQL 16,
**TimescaleDB 2.17.2**, PostGIS 3.6, Redis 8 — entirely inside a user-writable
directory:

```powershell
./scripts/dev-stack.ps1 -Install    # one-time, ~500 MB of downloads
./scripts/dev-run.ps1 -Reset        # database + API + dashboard, all of it
```

That prints the URLs and the sign-in details. Afterwards:

```powershell
./scripts/dev-run.ps1               # start (keeps existing data)
./scripts/dev-run.ps1 -Lan          # also reachable from a phone on the same Wi-Fi
./scripts/dev-run.ps1 -Stop         # stop everything
```

| | |
|---|---|
| Dashboard | http://localhost:3000 |
| API | http://127.0.0.1:4000/api/v1 |
| Swagger | http://127.0.0.1:4000/api/v1/docs |
| Sign in | `admin@karahoca.local` / `KaraHoca!Dev2026` |

Secrets are generated once into `.env.dev.local` (git-ignored) and reused.
That is deliberate: `INGEST_KEY_SECRET` envelope-encrypts every session's HMAC
key, so regenerating it per run would invalidate every live tracking session.

### Trying the whole flow

1. Sign in, **Oturumlar → + Yeni oturum**, pick a seeded order and carrier.
2. You get an 8-character code and a QR — that is the driver hand-off.
3. Install `android/app/build/outputs/apk/debug/app-debug.apk`, enter the code,
   grant the permissions on the checklist, press **TAKİBİ BAŞLAT**.
4. The truck appears on the live map. Turn on airplane mode for a few minutes
   and watch the buffer count rise, then turn it off and watch the gap backfill
   as an amber dashed segment — without the marker jumping backwards.

For a **physical phone** the APK must point at your machine's LAN address, not
`10.0.2.2` (which is the emulator's alias for the host):

```powershell
./scripts/dev-run.ps1 -Lan          # prints your LAN IP and the exact gradle command
```

## Verification

Everything below is executed, not asserted in prose. One command runs the lot:

```powershell
./scripts/verify-all.ps1          # add -SkipAndroid on a machine without the SDK
```

| Gate | What it proves |
|---|---|
| **SQL — 86 assertions** | `kh.ingest_points` idempotency, in-batch dedup, validation rejects, the monotonic live-state guard vs backfill, GPS-teleport and low-accuracy exclusion from distance, mock-location accounting, batch receipts, route simplification, lifecycle functions, geofence arrival, and every uniqueness constraint — against a **real hypertable** |
| **API e2e — 102 assertions** | The real built server against real PostgreSQL + TimescaleDB + PostGIS and real Redis: dispatcher auth, session hand-off, QR landing, driver claim, HMAC-signed **gzipped** ingest, idempotent replay, offline backfill (the marker must not rewind), nonce replay rejection, clock-skew handling, token refresh, route/playback/gaps/NDJSON export, and lifecycle closure |
| **Web build** | Compiles, including the `standalone` output the Dockerfile copies |
| **Android debug** | KSP validates every Room `@Query` against the schema and Hilt validates the whole DI graph at compile time |
| **Android release** | R8 + resource shrinking + signing — the build drivers actually get. Catches what debug cannot: stripped serializers, and `debugImplementation` code referenced from `main` |

Both test suites need `DATABASE_URL` and `REDIS_URL` pointing at live services;
`dev-stack.ps1 -Start` provides them.

### Why these suites are integration tests, not unit tests

Every defect found while building this was invisible to type-checking and would
have been invisible to mocked unit tests too:

- `@Type()` is a class-*transformer* decorator, so `whitelist: true` silently
  stripped `ClaimSessionDto.device` — **every driver claim returned 500**.
- The Android client signed the *compressed* body while the server hashed the
  *decompressed* one — **every gzipped upload would have failed** `BAD_SIGNATURE`.
- Nest's FastifyAdapter already registers an `application/json` parser, so the
  hand-rolled one **prevented the server from booting at all**.
- Closing a delivery revokes the device *and* bumps `token_version`, so the
  guard reported `SESSION_NOT_FOUND` for a completed job.
- `kh.detect_arrivals` raised `column reference "session_id" is ambiguous` —
  geofence arrival detection was **completely broken**.
- `HttpLoggingInterceptor` is a `debugImplementation` dependency referenced from
  `main`, so **`assembleRelease` did not compile** while debug did.

A mock of Fastify, of class-validator, of R8 or of PL/pgSQL would have
reproduced none of them.

## Documentation index

1. [Architecture Decision Records](docs/01-architecture-decision-records.md)
2. [Data model](docs/02-data-model.md)
3. [Android blueprint](docs/03-android-blueprint.md)
4. [Backend design](docs/04-backend.md)
5. [Deployment on Coolify / Hetzner](docs/05-deployment-coolify.md)
6. [API contract](docs/api-contract.md)
7. [Field rollout runbook (OEM battery killers)](docs/06-device-rollout-runbook.md)
