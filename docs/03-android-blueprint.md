# Android Blueprint — the Driver App

Source: [`android/`](../android). Package `com.karahoca.tracker`,
`minSdk 26`, `targetSdk 35`, Kotlin 2.1 + Compose + Hilt + Room + WorkManager.

The app has exactly one job: **produce a GPS fix every N seconds and make sure
every one of them eventually reaches the server** — while the screen is off, the
phone is in a pocket, the app has been swiped away, and the OS is doing
everything it can to stop us.

---

## 1. Component map

```
┌──────────────────────────────────────────────────────────────────────────┐
│ TrackerApplication                                                        │
│  • runs on EVERY process start, including resurrections                   │
│  • self-heal: TRACKING_ACTIVE set but no service? → start it              │
└───────────────┬──────────────────────────────────────────────────────────┘
                │
┌───────────────▼───────────────────┐        ┌─────────────────────────────┐
│ LocationTrackingService           │        │ RESURRECTION (outside proc.) │
│  FGS type=location                │        │                             │
│  • FusedLocationProviderClient    │        │ BootReceiver                │
│  • partial WakeLock               │◀───────│  BOOT_COMPLETED             │
│  • adaptive interval (move/idle)  │ start  │  MY_PACKAGE_REPLACED        │
│  • pump every 15 s                │        │                             │
│  • onTaskRemoved → alarm          │◀───────│ WatchdogReceiver            │
└───────────────┬───────────────────┘ start  │  AlarmManager every 5 min   │
                │ storeFix()                 │  setExactAndAllowWhileIdle  │
┌───────────────▼───────────────────┐        └─────────────────────────────┘
│ Room: location_points             │
│  PENDING → IN_FLIGHT → deleted    │
│  bounded ring, 500 000 rows       │
└───────────────┬───────────────────┘
                │ claim / send / ack
┌───────────────▼───────────────────┐        ┌─────────────────────────────┐
│ TrackingRepository                │───────▶│ OkHttp chain                │
│  the ONLY place rows are deleted  │        │  auth → gzip → HMAC → retry │
└───────────────▲───────────────────┘        └─────────────────────────────┘
                │ syncAll()
┌───────────────┴───────────────────┐
│ SyncWorker (WorkManager)          │
│  periodic 15 min + expedited      │
│  constraint: NetworkType.CONNECTED│
└───────────────────────────────────┘
```

---

## 2. Problem 1 — Doze, App Standby, and background execution limits

| OS behaviour | Countermeasure | Where |
|---|---|---|
| Doze defers background work and throttles location to a few fixes/hour | **Foreground service, `type=location`** — exempt from location throttling | [`AndroidManifest.xml`](../android/app/src/main/AndroidManifest.xml), `promoteToForeground()` |
| Android 15 caps `dataSync` FGS at 6 h/day | Chose `location` type, which is **not** time-limited | manifest `foregroundServiceType` |
| CPU suspends between callbacks, killing in-flight uploads | **`PARTIAL_WAKE_LOCK`**, acquired with a 30-min timeout and renewed by the pump so a crash cannot leak it | `acquireWakeLock()` / `renewWakeLock()` |
| App Standby buckets throttle jobs and alarms | **`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`** | [`PowerHelper`](../android/app/src/main/java/com/karahoca/tracker/util/PowerHelper.kt) |
| Android 12+ forbids starting an FGS from the background | Same exemption — being on the ignore-list is one of the documented conditions that **permits** a background FGS start. This is why the permission is non-negotiable, not just nice to have. | `PowerHelper.requestIgnoreBatteryOptimizations` |
| Android 14+ crashes on FGS-type mismatch | `ServiceCompat.startForeground(..., FOREGROUND_SERVICE_TYPE_LOCATION)` matching the manifest exactly | `promoteToForeground()` |
| Android 13+ needs `POST_NOTIFICATIONS` or the FGS notification is suppressed | Requested in the readiness checklist | `ReadinessScreen` |

### The 5-second rule

`startForegroundService()` promises the system we will call `startForeground()`
within five seconds. `promoteToForeground()` therefore runs **before any suspend
work** — reading DataStore first on a slow phone would earn a
`ForegroundServiceDidNotStartInTimeException`.

### FusedLocationProviderClient configuration, and why

```kotlin
LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, intervalMs)
    .setMinUpdateIntervalMillis(intervalMs / 2)
    .setMaxUpdateDelayMillis(0)
    .setMinUpdateDistanceMeters(0f)
    .setWaitForAccurateLocation(false)
    .setGranularity(Granularity.GRANULARITY_FINE)
```

- `PRIORITY_HIGH_ACCURACY` forces GNSS. `BALANCED_POWER` falls back to Wi-Fi/cell
  triangulation — on a rural highway that means no fix or a 2 km error.
- `setMaxUpdateDelayMillis(0)` **disables OS batching.** Hardware batching saves
  power but delivers fixes in bursts minutes later; we batch in SQLite instead,
  where a process kill cannot lose the batch.
- `setWaitForAccurateLocation(false)` gives a fast first fix instead of a 30-second
  sky search; we filter accuracy ourselves (`MAX_ACCEPTABLE_ACCURACY_M = 200`).
- `setMinUpdateDistanceMeters(0)` keeps sampling a stationary truck — dwell time
  at a customer gate is evidence of delivery.

### Adaptive cadence

Moving (`speed > 1 m/s` or moved > 25 m) → `pingIntervalSec` (default 10 s).
Stationary for 2 min → `idleIntervalSec` (default 60 s). Roughly halves
whole-shift battery consumption, and the very first moving fix snaps it back.

---

## 3. Problem 2 — being killed anyway

Stock Android respects the rules above. **MIUI, EMUI/HarmonyOS, ColorOS,
FuntouchOS and One UI power saving do not** — they kill foreground services
outright, with no `onDestroy`, no callback, nothing. Nothing running *inside*
the process can detect its own death.

Four layers, weakest to strongest:

1. **`android:stopWithTask="false"` + `START_STICKY`** — survives swipe-away and
   low-memory kills on well-behaved ROMs. START_STICKY restart timing is at the
   system's discretion.
2. **`onTaskRemoved` → `setExactAndAllowWhileIdle(+2 s)`** — when the driver
   swipes the app away, we arm an alarm before returning. If we survive, the
   alarm finds the service running and does nothing.
3. **Watchdog heartbeat, every 5 minutes** ([`ServiceWatchdog`](../android/app/src/main/java/com/karahoca/tracker/service/ServiceWatchdog.kt)).
   A `BroadcastReceiver` runs even when our process is gone — the system
   recreates the process to deliver the broadcast. It checks
   `TRACKING_ACTIVE && !isServiceRunning()` and restarts. This bounds any gap to
   ~5 minutes.
   `setExactAndAllowWhileIdle` is specifically the API that fires during Doze;
   the inexact variants batch into maintenance windows up to an hour apart.
   Without `SCHEDULE_EXACT_ALARM` we degrade to `setAndAllowWhileIdle` (~9 min
   slack) rather than giving up.
4. **`BOOT_COMPLETED` / `MY_PACKAGE_REPLACED`** — battery died and was recharged,
   driver rebooted a frozen phone, or we pushed an update mid-shift.

Plus **`TrackerApplication.onCreate`**, which runs on every process start
including resurrections and re-checks the flag.

Every involuntary restart writes a `SERVICE_RESTORED` event to the buffer, so a
dispatcher sees *"the OEM killed us at 14:02"* instead of guessing.

**OEM autostart** cannot be checked or granted programmatically. `PowerHelper`
deep-links into each vendor's undocumented settings activity (with
`resolveActivity` guards and a fall-back to app-info) and the onboarding screen
walks the driver through it. See the
[rollout runbook](06-device-rollout-runbook.md).

---

## 4. Problem 3 — zero connectivity

**The invariant:** a fix is deleted from the device only after the server
acknowledges, by batch id, that it holds it.

```
FusedLocation callback ──▶ Room INSERT ──▶ return          (no network, ever)
                                │
        ┌───────────────────────┴────────────────────────┐
        │ pump (15 s, if online)   SyncWorker (WorkManager)│
        └───────────────────────┬────────────────────────┘
                                │
              claimBatch(batchId, 500)      PENDING → IN_FLIGHT
              POST /ingest/batch (gzip)
                 ├─ 2xx  → deleteBatch(batchId)      ← the only DELETE
                 └─ else → releaseBatch(batchId)     IN_FLIGHT → PENDING, attempts++
```

Failure modes and what happens:

| Failure | Result |
|---|---|
| No coverage | Nothing runs. `NetworkType.CONNECTED` means we never poll and never wake the radio. |
| Timeout mid-POST | `releaseBatch` → back in the queue. |
| **Process killed mid-POST** | Rows stay `IN_FLIGHT`. `resetStaleInFlight(now − 5 min)` reclaims them on the next run. Worst case: a duplicate upload the server deduplicates. |
| Server 500 | `Result.retry()`, WorkManager exponential backoff (caps at 5 h). |
| Ack lost after the server committed | Retry re-sends; the PK collapses it. `duplicates` in the response, zero data change. |
| 413 too large | `chunkSize /= 2`, retry. Self-tunes to the link. |
| 400 poisoned payload | `chunkSize /= 4` to isolate the bad row rather than block the queue. |
| Buffer full (500 k rows ≈ 30+ truck-days) | Evict oldest, emit `BUFFER_OVERFLOW`. Never silent, never a crash. |

**Compression matters more than anything else here.** A 5,000-point backlog is
~1.4 MB of JSON and ~140 KB gzipped. On a 2G edge cell that is the difference
between completing in the 40 seconds of coverage a truck gets between hills and
not completing at all. The `GzipRequestInterceptor` also buffers the compressed
body so `Content-Length` is exact — some carrier proxies mishandle chunked POSTs,
and a rural cell is precisely where that bites.

**Interceptor order is load-bearing:** `auth → signing → gzip`. The HMAC covers
the **uncompressed** JSON, because the server decompresses in a `preParsing`
hook before capturing the raw body. Applying gzip before signing makes every
compressed upload fail `BAD_SIGNATURE` — an e2e assertion guards this in both
directions.

**Coverage-return trigger.** `NetworkMonitor` registers a
`ConnectivityManager.NetworkCallback` requiring `NET_CAPABILITY_VALIDATED` (not
merely "a network exists" — service-station captive portals associate happily
and route nowhere) and enqueues an expedited sync the instant it fires.

### Backoff on the realtime pump

The table above describes what WorkManager does with a failure. The pump had no
equivalent: it fired every 15 seconds and attempted an upload on every tick
regardless of how the previous one had failed. A server returning 429 or 503
therefore received **240 requests an hour from every truck in the fleet**, each
one dragging the modem out of `RRC_IDLE` and back through the tail timer for
nothing — and doing it precisely when the server was already struggling.

`sync/UploadBackoff.kt` gates it. 15 s base (one pump tick, so a single dropped
packet never delays a moving truck), doubling to a 5-minute cap — which is also
the watchdog heartbeat, so a genuinely unreachable server settles at roughly one
attempt per heartbeat instead of twenty. On success everything resets.

Three details are load-bearing, and each has a test:

- **`elapsedRealtime`, never wall clock.** An NTP correction mid-shift must not
  skip a backoff or extend it by hours.
- **`retryAfterSec` wins over the local ladder, in both directions.** The server
  is the only party that knows when its own rate-limit window resets. Guessing
  shorter burns the allowance again; guessing longer leaves a truck invisible
  for no reason.
- **Jitter is up to +20%, never negative.** Forty trucks that hit the same 429
  in the same second would otherwise retry in the same second forever,
  reconstructing the burst that caused the limit.

WorkManager keeps its own backoff and is deliberately not gated by this. It runs
on the order of minutes and is network-constrained, so it was never the source
of the wasted wake-ups.

---

## 5. Problem 4 — security

Per ADR-009 the device never holds a durable identity. At claim time it receives
a session-scoped JWT (24 h), an opaque refresh token, and a 32-byte HMAC key.
All three are sealed with a hardware-backed Keystore key
([`Keystore.kt`](../android/app/src/main/java/com/karahoca/tracker/util/Keystore.kt))
so a rooted phone or an `adb backup` yields nothing.

Every request carries:

```
Authorization : Bearer <session JWT>
X-KH-Timestamp: <clock-corrected epoch seconds>
X-KH-Nonce    : <16 random bytes, hex>
X-KH-Signature: HMAC-SHA256(ingestKey, "ts.nonce.sha256hex(body)")
```

**Clock correction** is the subtle part. The HMAC timestamp uses the wall clock,
and cheap phones drift or get set wrong. Every server response — *including error
responses* — carries `serverTime`; the device stores the offset and signs with
the corrected value. A phone two hours off still authenticates.

The key is deliberately **not** rotated on token refresh: rotating mid-shift
means a lost response forces a re-claim, and a driver in a dead zone cannot get
a new code. The key dies with the session instead.

---

## 6. Time (ADR-011)

`recordedAt` comes from `Location.getTime()` — **UTC derived from the GNSS fix
itself**, not `System.currentTimeMillis()`. A driver changing the timezone
mid-shift is common and must not corrupt a route. `elapsedRealtimeNanos` rides
along as a monotonic tiebreaker.

---

## 7. Build and distribution

Requires JDK 17 and an Android SDK with platform 35. The Gradle wrapper is
committed, so no local Gradle install is needed.

```bash
cd android
./gradlew assembleDebug                                                    # verification build
./gradlew assembleRelease -PkhApiBaseUrl=https://track.karahoca.com/api/v1/
# → app/build/outputs/apk/release/app-release.apk
```

Signing comes from `keystore.properties` (git-ignored) or the `KH_KEYSTORE_*`
env vars. **Keep the signing key forever**: change it and every installed
device must uninstall before it can update.

**Always verify with a release build, not just debug.** R8 is the difference:
nothing references the synthetic `kotlinx.serialization` `$$serializer` classes
statically, so without the rules in `proguard-rules.pro` every DTO throws
`SerializationException` in release only — the textbook "works on my machine,
dead in the field" failure. The same applies to `SyncWorker` (instantiated
reflectively by name) and the manifest-declared receivers the watchdog depends
on.

**Room schema JSON is committed** (`app/schemas/…/1.json`). `TrackerDatabase`
deliberately has no `fallbackToDestructiveMigration` — a destructive migration
on app update would delete buffered points that never reached the server — so
every schema change must ship a real `Migration`, and the exported JSON is what
makes that reviewable in a diff.

If the Kotlin compile daemon cannot be reached on a build machine
("Failed connecting to the daemon in 4 retries"), add
`-Pkotlin.compiler.execution.strategy=in-process`. It is slower but
deterministic and reports every diagnostic.

One universal APK, no ABI splits, no bundle — drivers install it by hand over a
hotspot and the file must always be the same file. Serve it from
`/downloads/karahoca-tracker.apk` so the QR landing page's
`S.browser_fallback_url` resolves.

## 8. Field verification checklist

Before declaring a device fleet-ready, on **that exact phone model**:

1. Start tracking, lock the screen, put it in a bag for 30 minutes → points keep
   arriving at the configured interval.
2. Swipe the app out of Recents → notification survives, or reappears within
   ~5 seconds.
3. Enable airplane mode for 20 minutes, then disable → the whole gap backfills
   within a minute, and the dashboard draws it as an amber dashed segment
   without the live marker jumping backwards.
4. Force-stop from Settings → next watchdog alarm (≤ 5 min) restores it.
   *(Note: on some ROMs force-stop also cancels alarms; document per model.)*
5. Reboot the phone → tracking resumes automatically.
6. Let the battery die, recharge, boot → session resumes and backfills.
7. Leave it running 12 hours → confirm battery consumption and that no gap
   exceeds the watchdog interval.
