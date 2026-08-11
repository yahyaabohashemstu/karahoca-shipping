# API Contract

Base URL: `https://track.karahoca.com/api/v1`
Realtime: `wss://track.karahoca.com/realtime`

Two audiences with completely different auth models:

| Audience | Auth | Endpoints |
|---|---|---|
| Dispatchers | Email/password → JWT + rotating refresh | everything except `/driver/*` and `/ingest/*` |
| Driver devices | Session-scoped JWT + per-request HMAC | `/driver/*`, `/ingest/*` |

Every response, **including errors**, carries `serverTime` (epoch seconds).
Clients use it to correct their clock (ADR-011).

---

## Error envelope

```json
{
  "error": { "code": "SESSION_CLOSED", "message": "Tracking session is COMPLETED …" },
  "serverTime": 1786531200,
  "path": "/api/v1/ingest/batch"
}
```

`code` is the contract; `message` is for humans and may change.

---

## Dispatcher endpoints

### `POST /auth/login`

```json
{ "email": "dispatch@karahoca.com", "password": "…" }
```
→ `{ accessToken, refreshToken, expiresIn, user: { id, email, role, fullName } }`

Refresh tokens rotate on every use, with reuse detection: presenting an already-
rotated token revokes the entire family.

### `POST /sessions`

```json
{
  "orderId": "uuid",
  "shippingCompanyId": "uuid",
  "driverName": "Mehmet Kaplan",
  "driverPhone": "+90 555 100 1001",
  "vehiclePlate": "34 ABC 123",
  "pingIntervalSec": 10,
  "idleIntervalSec": 60,
  "claimTtlMinutes": 720
}
```

→ full session detail including the hand-off:

```json
{
  "sessionId": "…", "reference": "KH-3F9A2C71", "status": "ASSIGNED",
  "handoff": {
    "code": "K7H29QX4",
    "prettyCode": "K7H2-9QX4",
    "expiresAt": "2026-08-12T04:00:00Z",
    "deepLink": "karahoca://track?c=K7H29QX4",
    "webLink": "https://track.karahoca.com/t/K7H29QX4",
    "qrDataUrl": "data:image/png;base64,…"
  }
}
```

409 `SESSION_ALREADY_OPEN` if the order already has a live session.

### Other dispatcher routes

| Method | Path | Notes |
|---|---|---|
| `GET` | `/sessions?status=LIVE&search=…` | `status=LIVE` means CLAIMED ∪ ACTIVE ∪ PAUSED |
| `GET` | `/sessions/:id` | Detail + device health + last 100 events + hand-off |
| `POST` | `/sessions/:id/claim-code` | New code; **revokes the current device** |
| `PATCH` | `/sessions/:id/policy` | Retune intervals mid-shift; the device picks it up from its next ingest response |
| `POST` | `/sessions/:id/{pause\|resume\|complete\|cancel}` | `complete` recomputes exact distance and marks the order delivered |
| `GET` | `/tracking/live` | Fleet snapshot; the socket takes over after this |
| `GET` | `/tracking/sessions/:id/route?toleranceM=8&raw=false` | GeoJSON, simplified in Postgres |
| `GET` | `/tracking/sessions/:id/playback?maxPoints=4000` | Positional tuples for the scrubber |
| `GET` | `/tracking/sessions/:id/gaps?minGapSec=120` | Coverage gaps — the dispute-settling endpoint |
| `GET` | `/tracking/sessions/:id/speed-profile` | Per-minute rollup from the continuous aggregate |
| `GET` | `/tracking/sessions/:id/export.ndjson` | Streamed full-fidelity export |
| `GET` | `/tracking/carriers/performance` | Carrier scorecard |
| `GET` | `/orders?untracked=true` | Orders without a live session |
| `GET` | `/health`, `/health/ready`, `/health/stats` | Public |

---

## Driver endpoints

### `POST /driver/claim` — public

```json
{
  "code": "K7H2-9QX4",
  "device": {
    "deviceId": "b3f1…", "manufacturer": "Xiaomi", "model": "Redmi Note 12",
    "osVersion": "Android 14", "sdkInt": 34, "appVersion": "1.0.0", "appBuild": 10,
    "batteryOptimisationIgnored": true,
    "hasBackgroundLocation": true,
    "hasExactAlarm": true
  }
}
```

→
```json
{
  "sessionId": "…", "reference": "KH-3F9A2C71",
  "accessToken": "eyJ…",           // 24 h, aud=driver-ingest
  "refreshToken": "…",             // opaque, 14 d
  "ingestKey": "base64:32 bytes",  // HMAC key — sealed in Keystore, never resent
  "expiresIn": 86400,
  "serverTime": 1786531200,
  "policy": { "pingIntervalSec": 10, "idleIntervalSec": 60, "minDistanceM": 0 },
  "shipment": { "orderNumber": "SO-2026-000418", "customerName": "…", "destinationLat": 40.7654, … }
}
```

Codes are normalised the same way on both sides (Crockford Base32; `I`/`L`→`1`,
`O`→`0`, `U`→`1`), so `k7h2-9qx4` and `K7HI-9QX4` both resolve. Single-use;
claiming revokes any previously bound device. Rate limited to 20 attempts per IP
per 5 minutes.

The `device.*` health flags appear on the dispatcher's session page **before the
truck leaves**, turning a post-mortem into a pre-flight check.

### `POST /driver/token/refresh` — public

```json
{ "refreshToken": "…", "deviceId": "b3f1…" }
```

The ingest key is deliberately **not** rotated: a lost response mid-shift would
otherwise force a re-claim, and a driver in a dead zone cannot get a new code.

### Signed requests

Everything below requires all four headers:

```
Authorization : Bearer <access token>
X-KH-Timestamp: 1786531200                      clock-corrected epoch seconds
X-KH-Nonce    : 3f9a2c71b8e4…                   16 random bytes, hex
X-KH-Signature: 7d4e…                           see below
Content-Encoding: gzip                          for /ingest/batch
```

```
signature = HMAC-SHA256(ingestKey, "{timestamp}.{nonce}.{sha256hex(body)}")
```

**`body` is the UNCOMPRESSED JSON**, even when `Content-Encoding: gzip` is set.

The server decompresses in a `preParsing` hook before the raw body is captured,
so it hashes the uncompressed payload too. Compression is therefore a pure
transport concern: a proxy that re-encodes the request cannot break
authentication. On the client this means gzip must be applied *after* signing
(see the interceptor ordering note in `AppModule.okHttpClient`).

Signing the compressed bytes instead yields `BAD_SIGNATURE` on every gzipped
upload. There is an e2e assertion — *"gzipped batch accepted (signature covers
uncompressed JSON)"* — that fails if either side drifts.

Nonces are single-use for `2 × HMAC_SKEW_SEC`.

### `POST /ingest/batch`

```json
{
  "batchId": "uuid",
  "offline": true,
  "bufferRemaining": 8143,
  "points": [
    {
      "id": "01JQ8Z9K3M4N5P6Q7R8S9T0V1W",
      "recordedAt": 1786530000000,
      "lat": 40.76541, "lon": 29.91873,
      "accuracy": 8.4, "speed": 21.7, "bearing": 143.2,
      "altitude": 112.0, "elapsedRealtimeNs": 987654321000,
      "batteryPct": 64, "isCharging": true, "isMock": false,
      "satellites": 11, "provider": "fused", "networkType": "cellular",
      "seq": 41207
    }
  ]
}
```

→ `202`

```json
{
  "accepted": 500, "duplicates": 0, "rejected": 0,
  "batchId": "uuid", "serverTime": 1786531200,
  "sessionStatus": "ACTIVE", "pointsTotal": 4211, "distanceM": 187432.6,
  "policy": { "pingIntervalSec": 10, "idleIntervalSec": 60, "minDistanceM": 0 },
  "nextAction": "CONTINUE"
}
```

Notes:

- **`id` is the idempotency key.** Re-sending a batch is free — points collapse on
  `(session_id, client_point_id, recorded_at)` and come back as `duplicates`.
- **`offline: true`** makes the server emit `route:backfill` instead of
  `position:update`, so the dispatcher's marker does not rewind.
- **`recordedAt`** accepts epoch millis or ISO-8601.
- Max 5,000 points per batch (`INGEST_MAX_BATCH_POINTS`); 413 `BATCH_TOO_LARGE`
  carries `maxBatchPoints` so the client can re-chunk.
- Malformed individual points are counted in `rejected`, never fatal to the batch.

### `POST /ingest/ping`

`{ "batchId": "uuid", "point": { … } }` — identical semantics, one point.

### `POST /driver/events`

```json
{ "type": "SERVICE_KILLED", "occurredAt": "2026-08-11T14:02:11Z",
  "message": "Service restarted by the system", "payload": { "gapSec": "284" } }
```

Accepted types: `STARTED`, `PAUSED`, `RESUMED`, `GPS_LOST`, `GPS_RECOVERED`,
`NETWORK_LOST`, `NETWORK_RECOVERED`, `BUFFER_OVERFLOW`, `PERMISSION_REVOKED`,
`BATTERY_LOW`, `SERVICE_KILLED`, `SERVICE_RESTORED`, `NOTE`.

### `GET /driver/session`, `POST /driver/stop`

Current session state (and `serverTime` for clock correction), and a clean pause.
`stop` deliberately does **not** complete the order — only a dispatcher does that.

---

## Realtime

Connect with the dispatcher access token:

```js
io('wss://track.karahoca.com', { path: '/realtime', auth: { token: accessToken } })
```

| Emit | Payload | Ack / stream |
|---|---|---|
| `subscribe:fleet` | — | acks with `fleet:snapshot`, then `fleet:positions` ~1/s |
| `subscribe:session` | `{ sessionId }` | `position:update`, `route:backfill`, `session:event`, `session:state`, `ingest:stats` |
| `unsubscribe:fleet` / `unsubscribe:session` | | |
| `ping` | — | `pong { serverTime }` |

```jsonc
// position:update — MOVE the marker
{ "sessionId": "…", "lat": 40.7654, "lon": 29.9187, "speedMps": 21.7,
  "bearingDeg": 143.2, "batteryPct": 64, "recordedAt": "…",
  "pointsTotal": 4211, "distanceM": 187432.6 }

// route:backfill — SPLICE geometry, do NOT move the marker
{ "sessionId": "…", "batchId": "…", "from": "…", "to": "…", "count": 843,
  "truncated": false, "points": [[29.9187, 40.7654, "2026-08-11T12:00:03Z"], …] }
// truncated:true + hint:"refetch" → pull GET /tracking/sessions/:id/route instead
```

**Treat the socket as a patch channel, not the source of truth.** On every
reconnect, take a fresh HTTP snapshot and apply socket frames on top. Replaying
missed frames is how live maps end up showing last Tuesday's positions.

---

## Driver error-code precedence

The guard evaluates in this order, and the **first** match is what the device
sees:

1. `SESSION_NOT_FOUND` (401) — no such session row at all
2. `SESSION_CLOSED` (403) — COMPLETED / CANCELLED / EXPIRED
3. `TOKEN_REVOKED` (401) — `token_version` moved, or the device was unbound
4. `DEVICE_MISMATCH` (403) — a different phone holds this session
5. `RATE_LIMITED` (429)
6. `CLOCK_SKEW` / `REPLAY_DETECTED` / `BAD_SIGNATURE` (401)

Lifecycle is checked **before** revocation on purpose. Completing a delivery
both revokes the device and bumps `token_version`, so checking revocation first
would tell a driver "you were reassigned" when the truthful answer is "this
delivery is finished". The most specific explanation wins.

## Rate limits

| Scope | Limit |
|---|---|
| Ingest requests per session | 120/min |
| Ingest points per session | 20,000/min |
| Claim attempts per IP | 20 / 5 min |
| Failed dispatcher logins | 8, then 15-minute lockout |

429 responses carry `retryAfterSec`.
