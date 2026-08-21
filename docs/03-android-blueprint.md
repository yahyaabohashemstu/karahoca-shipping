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

### The startForeground deadline, and how it was being missed

`startForegroundService()` promises the system we will call `startForeground()`
within ten seconds, and the penalty for breaking it is not a dropped session but
`ForegroundServiceDidNotStartInTimeException` killing the process. Drivers hit
it after a reboot — the worst possible moment, because the phone is trying to
resume a shipment that is already under way.

Running `promoteToForeground()` before any suspend work is necessary but was not
sufficient. Everything that happens *before* it also spends the budget, and on
the boot path none of it is warm. Measured on a real reboot with a live session
and the device at 99.9% I/O pressure:

| Where the 1.8 s went | Fix |
|---|---|
| `onCreate` built the `FusedLocationProviderClient`. That pulls the Play Services location classes in and ART verifies them on the calling thread — `zzbb.getLastLocation` 194 ms, `zzbi.flushLocations` 103 ms, `Status.<init>` 100 ms, and those are only the ones slow enough for ART to log. ~700 ms. | `fused` is `by lazy`; the cost lands on first use, behind the notification |
| `promoteToForeground` built the full notification: three `PendingIntent`s, each a round trip into `ActivityManagerService`, plus a locale-wrapped `Resources` with its own `AssetManager`. ~405 ms. | `bootstrapNotification()` — an icon and two strings — keeps the promise; `postRichNotification()` puts the buttons back one call later |
| The service built its own locale-wrapped `Resources` when the process already held an identical one. | `getResources()` borrows `applicationContext`'s, which `TrackerApplication` caches by language tag |
| A repeat start command posted **nothing** — the method returned early once foreground. Two starts arrive on every boot (`TrackerApplication`'s self-heal and `BootReceiver`, ~40 ms apart), each carrying its own deadline, and under that I/O pressure the second was delivered **10.1 s** after it was requested. | `promoteToForeground()` re-posts on every start command; the duplicate `beginTracking` is suppressed by `trackingRequested` |

Same boot afterwards: **47 ms** from the start request to `onCreate`, and
**28 ms** from there to `startForeground` — 75 ms against a 10-second budget,
where it had been 1.8 s. Reproduced across three reboots (23–32 ms), with the
resumed session recording and uploading fixes each time.

The margin is logged on every start (`Foreground after Nms`) because it is the
only warning this path will ever get on a handset we cannot attach a debugger
to, and [`ForegroundDeadlineTest`](../android/app/src/test/java/com/karahoca/tracker/service/ForegroundDeadlineTest.kt)
fails the build if `onCreate` grows again.

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

## 4b. Cadence — time or distance

The dispatcher chooses, per session, how often a truck reports:

| Mode | Meaning | `min_distance_m` |
|---|---|---|
| Time | a fix every N seconds | `0` |
| Distance | a fix every N metres travelled | `> 0` |

**There is no mode column.** Distance mode *is* `min_distance_m > 0`. Deriving
it keeps the wire format unchanged, keeps every already-issued session valid,
and removes a second source of truth that could disagree with the first.

Bounds, enforced identically in the DTO and in `ck_session_intervals`: ping
2 s – 1 h, idle 5 s – 4 h, distance 0 – 20 km, and **`idle >= ping`**. That last
one is not decorative — a parked truck sampled more often than a driving one is
backwards. The API derives `idle = max(requested, ping)` so a dispatcher asking
for a slow cadence cannot produce a constraint violation from a form they filled
in correctly.

### Why the distance filter is not `setMinUpdateDistanceMeters`

The obvious implementation is to hand the figure to `LocationRequest`. It is the
wrong one for this product.

A displacement filter makes the fused client stop calling back. A truck standing
at a customer's gate would then produce **nothing at all** — the server would see
no telemetry, and the dashboard would report a healthy parked truck as `STALE`
and then `LOST`. That is the one signal the entire system exists to make
trustworthy, and a legitimate three-hour dwell is indistinguishable from a phone
in a drawer.

`LocationTrackingService.shouldStore()` filters in the callback instead:

```
store this fix if:
    distance mode is off                                  (every fix counts)
 OR it is the first fix of the session                    (the map needs a start)
 OR distance from the last STORED fix >= min_distance_m   (the trigger)
 OR time since the last STORED fix >= idle_interval       (the heartbeat)
```

The heartbeat is what makes distance mode safe: a dwell is proven, silence still
means a problem, and a slow city leg stops writing a thousand rows of the same
junction.

`lastFixAtMs` — what the watchdog reads to decide whether the location engine
has wedged — is updated on every **received** fix, not every stored one. Gating
it on storage would make the watchdog tear down a perfectly healthy parked truck
once per idle interval.

**What distance mode does and does not save.** It cuts stored rows, uploads and
therefore radio time. It does *not* turn the GNSS receiver off: the device still
samples at `ping_interval_sec`, because that is what a receiver does. Expect a
large reduction in data volume and a modest one in battery.

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
`/downloads/karahoca-takip.apk` so the QR landing page's
`S.browser_fallback_url` resolves. Publishing it is a file copy onto a host
bind mount, outside the deploy cycle, and it has to be done atomically — the
procedure is in [05 §6](05-deployment-coolify.md).

## 7a. Problem 4b — the driver who stopped tracking by mistake

Everything in sections 3 and 4 defends against the app being **killed**. None of
it defends against the app being **told to stop**, because from the inside those
are not the same event: a stop clears TRACKING_ACTIVE, cancels the watchdog and
parks the session server-side, and every resurrection mechanism correctly stands
down. That is right when the driver meant it, and it is the whole failure when
they did not.

And it was the easier mistake to make. The Stop button is large and red, and the
same action sat on the **ongoing notification** — reachable from the lock screen,
without unlocking, on a phone spending eight hours in a door pocket. One tap and
the shipment went dark. Worse, it went dark *silently*: `SIGNAL_LOST` is raised
only `WHERE s.status = 'ACTIVE'`, so a PAUSED session raised nothing at all, and
nothing else watched paused sessions either.

Three changes, one per layer:

**Ask first.** `StopConfirmDialog`, mounted at the root of the composition
because both routes end there — the button on screen, and an intent extra from
the notification that arrives long before the tracking screen has composed. The
notification's action is now a `getActivity` PendingIntent rather than a
`getBroadcast` one: a notification cannot ask a question, so it opens the app on
the question instead.

**Tell the desk.** `PAUSED_TOO_LONG`, raised by the API ten minutes after a pause
on a session that started and whose order is still open, WARNING and then
CRITICAL after an hour. It resolves itself the moment the session leaves PAUSED.
Ten minutes is the shortest threshold in that file on purpose: a pause is not a
fault the system can wait out, it is a decision that has already been taken, and
the lorry is moving either way.

**Let the desk undo it.** A dispatcher pressing Resume flips the session back to
ACTIVE, and `TrackingRepository.dispatcherResumedTracking()` is how a phone
hears about it — there is no push channel, and a stopped phone sends nothing the
server could answer. Checked when the driver opens the app, and by `SyncWorker`
for a phone whose app is closed. The guards are the safety story and are pinned
by [`ResumeDecisionTest`](../android/app/src/test/java/com/karahoca/tracker/data/repository/ResumeDecisionTest.kt):
it only ever turns tracking **on**, never off, and only when our own stop was
acknowledged by the server — otherwise a Stop pressed in a tunnel, whose POST
failed, would leave the server reading ACTIVE and the phone would override the
driver every fifteen minutes for the rest of the shift.

The driver is told why, with an alert notification. A phone that silently
started tracking again is a phone whose driver's obvious next move is to stop it
a second time.

## 7b. Problem 5 — reaching a phone that has no app store

Sideloading solved distribution and created this: there is no update channel,
so a fixed bug reaches a driver only when somebody telephones them and talks
them through re-downloading. Three releases in a row failed to make that trip —
a redesign, the language switcher, and a crash on reboot all sat in `main`
while every phone in the fleet ran the build from a fortnight earlier.

From 1.5.0 the app carries its own updater.

```
/downloads/latest.json  ──check, 6-hourly──▶  UpdateRepository
   versionCode, sha256, size, notes                 │
                                          Available │ notification (ongoing)
                                                    │ + banner on every screen
                                     driver presses ▼
                                        download ─▶ sha256 ─▶ PackageInstaller
                                                                   │
                                              MY_PACKAGE_REPLACED ─┘
                                                    │
                                          BootReceiver resumes the session
```

**The check is cheap and rare.** A few hundred bytes of JSON, throttled to once
every six hours, on work that was going to run anyway — process start and
`SyncWorker`. It is placed *before* SyncWorker's session guard on purpose: a
driver between shipments is exactly the driver with time to install something.

**Nothing downloads until the driver presses the button.** 24 MB on a roaming
plan in Iraq is their money. The banner shows the size before they commit, and
says tracking comes back by itself — which is the one thing that would
otherwise stop a driver mid-run from pressing it.

**The notification is "semi-permanent", and that needs both halves.**
`setOngoing` keeps it out of a careless swipe up to Android 13; on 14 and above
the platform lets anything be dismissed, so what actually makes it persistent is
that the next six-hourly check posts it again. A driver can clear it to see
their lock screen and it returns that evening.

**The install ends at a system dialog, and only a visible app may launch one.**
That constraint shapes the whole flow: the notification's Update action is a
`getActivity` PendingIntent that opens the app and starts the download there,
rather than a `getBroadcast` that would be unable to finish what it started. If
the download outlives the driver's attention — the normal case on a rural cell —
`UpdateInstallReceiver` falls back to posting the confirmation dialog as its own
notification.

**Three things stand between a bad manifest and a bad install.** The sha256 in
the manifest is checked against the downloaded bytes; the platform refuses any
APK not signed with the key the installed app already carries; and
`setAppPackageName` means a session for some other package is rejected before
the driver sees a prompt. The worst a tampered manifest achieves is a wasted
download.

Publishing is one command — `infra/publish-apk.sh` — because the APK and the
manifest have to move together. See [05 §6](05-deployment-coolify.md).

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
