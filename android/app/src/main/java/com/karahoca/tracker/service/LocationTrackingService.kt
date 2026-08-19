package com.karahoca.tracker.service

import android.Manifest
import android.app.ForegroundServiceStartNotAllowedException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.location.Location
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import androidx.core.app.ActivityCompat
import androidx.core.app.ServiceCompat
import androidx.lifecycle.LifecycleService
import androidx.lifecycle.lifecycleScope
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.Granularity
import com.google.android.gms.location.LocationAvailability
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.karahoca.tracker.BuildConfig
import com.karahoca.tracker.R
import com.karahoca.tracker.data.local.SessionStore
import com.karahoca.tracker.data.local.TrackingPolicy
import com.karahoca.tracker.data.repository.TrackingRepository
import com.karahoca.tracker.di.ApplicationScope
import com.karahoca.tracker.sync.SyncScheduler
import com.karahoca.tracker.util.Destination
import com.karahoca.tracker.util.DistanceUnit
import com.karahoca.tracker.util.formatRemaining
import com.karahoca.tracker.util.DeviceInfoProvider
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * ============================================================================
 *  THE TRACKING SERVICE
 * ============================================================================
 *
 * Requirement: keep producing GPS fixes while the screen is off, the phone is
 * in a pocket, the app has been swiped out of Recents, and Android is doing
 * everything in its power to put the device to sleep.
 *
 * Six mechanisms, each defeating a specific OS behaviour:
 *
 *  1. FOREGROUND SERVICE, type `location`
 *     Doze defers background work and throttles location to a few times an
 *     hour. A location-type FGS is exempt from that throttling. It is also
 *     exempt from Android 15's 6-hour daily cap that would silently kill a
 *     `dataSync` service halfway through a long haul.
 *
 *  2. PARTIAL WAKE LOCK
 *     The FGS keeps us running; it does not keep the CPU awake between
 *     callbacks. Without a wake lock the SoC suspends and an in-flight upload
 *     dies mid-socket. Acquired with a timeout and renewed by the pump, so a
 *     crashed service can never leak it for a whole shift.
 *
 *  3. START_STICKY + stopWithTask="false"
 *     Survives both a low-memory kill and the driver swiping the app away.
 *
 *  4. onTaskRemoved → exact alarm
 *     START_STICKY restart is "when the system feels like it". An exact alarm
 *     scheduled the instant the task is removed brings us back in ~2 seconds.
 *
 *  5. WATCHDOG HEARTBEAT (AlarmManager, every 5 min)
 *     Aggressive OEM skins (MIUI, EMUI, ColorOS, One UI power saving) kill
 *     foreground services outright with no callback at all. Nothing inside the
 *     process can detect that — so the resurrection has to come from outside
 *     it. See [WatchdogReceiver].
 *
 *  6. BOOT_COMPLETED / MY_PACKAGE_REPLACED
 *     Reboots and app updates resume an interrupted session. See [BootReceiver].
 *
 * The location callback itself does exactly one thing: write a row to SQLite.
 * Networking is never in the acquisition path (ADR-010).
 */
@AndroidEntryPoint
class LocationTrackingService : LifecycleService() {

    @Inject lateinit var repository: TrackingRepository
    @Inject lateinit var store: SessionStore
    @Inject lateinit var syncScheduler: SyncScheduler
    @Inject lateinit var notifications: TrackingNotification
    @Inject lateinit var deviceInfo: DeviceInfoProvider

    /** Survives onDestroy cancelling lifecycleScope. See [ApplicationScope]. */
    @Inject @ApplicationScope lateinit var appScope: CoroutineScope

    private lateinit var fused: FusedLocationProviderClient
    private var wakeLock: PowerManager.WakeLock? = null
    private var locationCallback: LocationCallback? = null

    /*
     * Where the load is going, loaded once when tracking starts.
     *
     * Null for three orders in four — most have no destination — and every use
     * below has to cope with that rather than guess a coordinate.
     */
    @Volatile private var destination: Destination? = null

    /** Straight-line metres to the delivery point, or null until the first fix. */
    @Volatile private var remainingM: Double? = null

    /*
     * Consecutive fixes that qualified as arrival.
     *
     * Two are required before the driver is told anything. One is enough to be
     * wrong: a single fix that drifts inside the radius while the lorry is
     * still on the ring road would invite a driver to stop tracking mid-run,
     * and the cost of that is the rest of the route. Two consecutive fixes,
     * each already required to be inside the circle even at the worst its own
     * accuracy admits, is cheap and far harder to fake.
     */
    private var arrivalStreak = 0

    /** Fires once per session; survives a restart via SessionStore. */
    private var arrivalAnnounced = false
    private var pumpJob: Job? = null

    // ---- Adaptive-interval state --------------------------------------------
    private var currentMode: Mode = Mode.MOVING
    private var lastMovementElapsedMs: Long = 0
    private var lastLocation: Location? = null

    // ---- Distance-triggered state --------------------------------------------
    /**
     * Metres of travel between stored fixes. 0 = time-triggered.
     *
     * The policy has carried this field since the first release and the service
     * ignored it: the LocationRequest hard-coded a zero displacement filter and
     * nothing else looked at it. A dispatcher choosing "every 500 m" got a
     * time-based session and no indication that their choice had been dropped.
     */
    @Volatile private var minDistanceM = 0

    /** Idle cadence, cached from the policy. Doubles as the distance-mode heartbeat. */
    @Volatile private var idleIntervalMs = 60_000L

    /** The last fix actually written to the buffer — the reference for the trigger. */
    private var lastStoredLocation: Location? = null
    private var lastStoredElapsedMs = 0L

    // ---- Health state --------------------------------------------------------
    private var gpsAvailable = true
    private var fixCount = 0L

    /**
     * True when THIS process asked the service to stop.
     *
     * Distinguishes a self-inflicted stop — permission gone, startForeground
     * refused, driver tapped Stop — from an OEM kill. Only the second deserves
     * a 2-second resurrection. Without it, a phone that can never start the
     * service restarts itself every 2 seconds until the battery dies, holding a
     * wake lock and recording nothing.
     */
    private var selfStopped = false

    /** In-process mirror of TRACKING_ACTIVE so onDestroy needs no blocking read. */
    @Volatile private var trackingActive = false

    /** Content of the last posted notification, to avoid re-posting an identical one. */
    private var lastPostedNotification: Triple<String, String, Int>? = null

    /**
     * Time of the most recent fix, in memory.
     *
     * Persisted by the 15 s pump rather than on every fix. It feeds only the
     * notification text, the UI poll and the watchdog's staleness check — none
     * of which need it durable to the second, and none of which justify a
     * full DataStore rewrite plus fsync 10,000 times a shift.
     */
    @Volatile private var lastFixAtMs = 0L

    private enum class Mode { MOVING, IDLE }

    companion object {
        private const val TAG = "KH/Service"

        const val ACTION_START = "com.karahoca.tracker.START"
        const val ACTION_STOP = "com.karahoca.tracker.STOP"
        const val ACTION_SYNC_NOW = "com.karahoca.tracker.SYNC_NOW"
        const val ACTION_RELOAD_POLICY = "com.karahoca.tracker.RELOAD_POLICY"

        private const val NOTIFICATION_ID = 4711

        /** Movement threshold. Below this a parked truck stops burning battery. */
        private const val MOVING_SPEED_MPS = 1.0f
        private const val MOVING_DISTANCE_M = 25f
        private const val IDLE_AFTER_MS = 120_000L

        /** Renewed by the pump; a leaked lock therefore expires on its own. */
        private const val WAKELOCK_TIMEOUT_MS = 30 * 60 * 1000L

        /** Reject fixes we cannot trust enough to move a truck marker. */
        private const val MAX_ACCEPTABLE_ACCURACY_M = 200f
        /**
         * Consecutive qualifying fixes before the driver is told they arrived.
         *
         * One is enough to be wrong. A single fix drifting inside the radius while
         * the lorry is still on the ring road would invite a driver to stop
         * tracking mid-run, and the cost of that is the rest of the route. Two is
         * cheap — at the default ten-second cadence it delays the prompt by ten
         * seconds — and far harder for noise to produce.
         */
        private const val ARRIVAL_FIXES_REQUIRED = 2


        fun start(context: Context) {
            val intent = Intent(context, LocationTrackingService::class.java)
                .setAction(ACTION_START)
            // startForegroundService promises the system we will call
            // startForeground() within 5 s — see onStartCommand.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.startService(
                Intent(context, LocationTrackingService::class.java).setAction(ACTION_STOP),
            )
        }

        fun syncNow(context: Context) {
            context.startService(
                Intent(context, LocationTrackingService::class.java).setAction(ACTION_SYNC_NOW),
            )
        }

        /**
         * Re-register the FusedLocation request without restarting the service.
         *
         * Used by the watchdog when the service is alive but has produced no fix
         * for several intervals — a wedged fused client. Stop/start would work
         * too, but would tear down the wake lock and the pump for no reason.
         *
         * Only safe to call when the service is already running; startService()
         * on a dead service would create one outside the foreground window.
         */
        fun reloadPolicy(context: Context) {
            context.startService(
                Intent(context, LocationTrackingService::class.java).setAction(ACTION_RELOAD_POLICY),
            )
        }
    }

    // =========================================================================
    // Lifecycle
    // =========================================================================

    override fun onCreate() {
        super.onCreate()
        fused = LocationServices.getFusedLocationProviderClient(this)
        Log.i(TAG, "Service created")
    }

    override fun onBind(intent: Intent): IBinder? {
        super.onBind(intent)
        return null // started service only; the UI observes Room/DataStore
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)

        /*
         * A null intent means the system restarted us via START_STICKY after a
         * kill. There is no action to dispatch — the persisted TRACKING_ACTIVE
         * flag is the source of truth, so we simply resume.
         */
        val action = intent?.action ?: ACTION_START
        Log.i(TAG, "onStartCommand action=$action flags=$flags startId=$startId")

        when (action) {
            ACTION_STOP -> {
                /*
                 * This intent can CREATE the service: stop() uses
                 * startService(), which instantiates a dead service just to
                 * deliver ACTION_STOP. Running a full driver-initiated shutdown
                 * on that fresh instance would log a spurious PAUSED event and
                 * enqueue another sync — the other half of the ping-pong with
                 * SyncWorker. An instance that never entered the foreground has
                 * nothing to shut down.
                 */
                if (!isForegroundStarted) {
                    Log.i(TAG, "ACTION_STOP for a service that was not running — ignoring")
                    selfStopped = true
                    stopSelf()
                    return START_NOT_STICKY
                }
                lifecycleScope.launch { shutdown(userInitiated = true) }
                return START_NOT_STICKY
            }

            ACTION_SYNC_NOW -> {
                syncScheduler.syncNow(expedited = true)
                if (!isForegroundStarted) promoteToForeground()
                return START_STICKY
            }

            ACTION_RELOAD_POLICY -> {
                lifecycleScope.launch { forceReregister() }
                return START_STICKY
            }

            else -> {
                promoteToForeground()
                lifecycleScope.launch { beginTracking(restarted = intent == null) }
                /*
                 * START_STICKY: after a low-memory kill the system recreates the
                 * service with a null intent. Combined with stopWithTask="false"
                 * in the manifest, this is the first line of defence.
                 */
                return START_STICKY
            }
        }
    }

    private var isForegroundStarted = false

    /**
     * Enter the foreground within the 5-second window Android allows.
     *
     * This runs BEFORE any suspend work: if we awaited a DataStore read first
     * and the disk was slow, the system would kill us with a
     * ForegroundServiceDidNotStartInTimeException.
     */
    private fun promoteToForeground() {
        if (isForegroundStarted) return
        val notification = notifications.build(
            title = getString(com.karahoca.tracker.R.string.notification_starting),
            body = getString(com.karahoca.tracker.R.string.notification_acquiring_gps),
            buffered = 0,
            ongoing = true,
        )
        try {
            ServiceCompat.startForeground(
                this,
                NOTIFICATION_ID,
                notification,
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    // MUST match android:foregroundServiceType in the manifest.
                    // On API 34+ a mismatch is an immediate crash.
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
                } else {
                    0
                },
            )
            isForegroundStarted = true
        } catch (e: Exception) {
            /*
             * Two realistic failures:
             *
             *  - ForegroundServiceStartNotAllowedException (API 31+): we tried
             *    to start from the background without an exemption. This is
             *    precisely why the app pushes so hard for the battery
             *    optimisation exemption — being on that list is one of the
             *    documented conditions that permits a background FGS start.
             *
             *  - SecurityException (API 34+): location permission was revoked
             *    while we were running.
             *
             * Either way the session must not silently die, so we record it and
             * hand the problem to the watchdog, which will retry when the app
             * next comes to the foreground.
             */
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
                e is ForegroundServiceStartNotAllowedException
            ) {
                Log.e(TAG, "FGS start not allowed from background", e)
            } else {
                Log.e(TAG, "startForeground failed", e)
            }
            // We are stopping ourselves. onDestroy must NOT arm a resurrection
            // alarm for this, or a phone that cannot start the service enters a
            // 0.5 Hz restart loop that records nothing.
            selfStopped = true
            // appScope, not lifecycleScope: stopSelf() drives onDestroy, whose
            // super call cancels lifecycleScope — and this is the one event
            // that explains the failure to the dispatcher.
            appScope.launch {
                repository.recordLocalEvent(
                    type = "SERVICE_KILLED",
                    message = "startForeground failed: ${e.javaClass.simpleName}",
                )
            }
            stopSelf()
        }
    }

    // =========================================================================
    // Tracking
    // =========================================================================

    private suspend fun beginTracking(restarted: Boolean) {
        if (store.sessionId() == null) {
            Log.w(TAG, "No session bound — refusing to track")
            shutdown(userInitiated = false)
            return
        }

        store.setTrackingActive(true)
        trackingActive = true
        selfStopped = false
        // Before the first fix arrives, so the very first callback already knows
        // whether it is running a distance trigger.
        cachePolicy(store.policy())
        // Read once, held for the life of the service. See loadDestination —
        // the per-fix path must not touch DataStore.
        loadDestination()
        acquireWakeLock()
        ServiceWatchdog.schedule(this)

        // Anything left IN_FLIGHT from a previous process death goes back in the
        // queue before we add to it.
        repository.recoverOrphanedBatches()

        if (restarted) {
            Log.w(TAG, "Service was restarted by the system — logging the gap")
            repository.recordLocalEvent(
                type = "SERVICE_RESTORED",
                message = "Service restarted by the system (process was killed)",
            )
        } else {
            repository.recordLocalEvent(type = "STARTED", message = "Driver started tracking")
        }

        requestLocationUpdates(store.policy().pingIntervalMs)
        startPump()
        syncScheduler.schedulePeriodic()
        syncScheduler.syncNow(expedited = true)
    }

    /**
     * Configure FusedLocationProviderClient.
     *
     * Choices that matter:
     *
     *  - PRIORITY_HIGH_ACCURACY forces GNSS. BALANCED_POWER falls back to
     *    Wi-Fi/cell triangulation, which on a rural highway means either no fix
     *    at all or a 2 km error — worse than useless on a route map.
     *
     *  - setMaxUpdateDelayMillis(0) disables the OS's own batching. Hardware
     *    batching saves power but delivers fixes in bursts minutes later; we do
     *    our own batching in SQLite, where we control it and where a kill
     *    cannot lose the batch.
     *
     *  - setWaitForAccurateLocation(false) means the first fix arrives fast and
     *    coarse rather than after a 30-second sky search. We filter accuracy
     *    ourselves.
     *
     *  - setMinUpdateDistanceMeters(0) by default: a stationary truck at a
     *    customer gate is information (it proves the dwell), so we keep sampling
     *    at the slower idle cadence rather than going silent.
     */
    private fun requestLocationUpdates(intervalMs: Long) {
        if (!hasLocationPermission()) {
            Log.e(TAG, "Location permission missing")
            lifecycleScope.launch {
                repository.recordLocalEvent(
                    type = "PERMISSION_REVOKED",
                    message = "ACCESS_FINE_LOCATION is not granted",
                )
                shutdown(userInitiated = false)
            }
            return
        }

        locationCallback?.let(fused::removeLocationUpdates)

        val request = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, intervalMs)
            .setMinUpdateIntervalMillis(intervalMs / 2)
            .setMaxUpdateDelayMillis(0)
            .setMinUpdateDistanceMeters(0f)
            .setWaitForAccurateLocation(false)
            .setGranularity(Granularity.GRANULARITY_FINE)
            .build()

        val callback = object : LocationCallback() {
            override fun onLocationResult(result: LocationResult) {
                // Batched deliveries can carry several fixes; store them all.
                result.locations.forEach(::handleLocation)
            }

            override fun onLocationAvailability(availability: LocationAvailability) {
                val available = availability.isLocationAvailable
                if (available != gpsAvailable) {
                    gpsAvailable = available
                    Log.w(TAG, "GPS availability changed: $available")
                    lifecycleScope.launch {
                        repository.recordLocalEvent(
                            type = if (available) "GPS_RECOVERED" else "GPS_LOST",
                            message = if (available) {
                                "Satellite fix recovered"
                            } else {
                                "No satellite fix (tunnel, underground, or obstructed sky)"
                            },
                        )
                    }
                }
            }
        }

        try {
            fused.requestLocationUpdates(request, callback, mainLooper)
                .addOnFailureListener { e ->
                    /*
                     * The returned Task was previously discarded, and that was
                     * the single most dangerous line in the service.
                     *
                     * A Play-Services-side rejection — SERVICE_MISSING on a
                     * post-2019 Huawei, a de-Googled ROM, a corrupted GMS
                     * install — FAILS THIS TASK. It does not throw
                     * SecurityException, so the catch below never sees it, and
                     * onLocationAvailability never fires either. The result was
                     * a 14-hour shift holding a wake lock, showing "Takip
                     * aktif", and writing zero rows, with nothing in the logs.
                     */
                    Log.e(TAG, "FusedLocation refused the request", e)
                    locationCallback = null
                    appScope.launch {
                        repository.recordLocalEvent(
                            type = "GPS_LOST",
                            message = "FusedLocation unavailable: " +
                                "${e.javaClass.simpleName}: ${e.message}",
                        )
                    }
                    notifications.alert(
                        title = getString(R.string.alert_no_location_engine_title),
                        body = getString(R.string.alert_no_location_engine_body),
                    )
                }
            locationCallback = callback
            activeIntervalMs = intervalMs
            Log.i(TAG, "Location updates requested at ${intervalMs}ms ($currentMode)")
        } catch (e: SecurityException) {
            // Mid-call revocation race. Clearing the field matters: leaving the
            // old (already removed) callback there would make us look
            // registered while nothing is listening.
            Log.e(TAG, "requestLocationUpdates denied", e)
            locationCallback = null
        }
    }

    /**
     * The hot path. Deliberately tiny: validate, classify movement, write to
     * SQLite, return. No network, no JSON, no allocation storms.
     */
    /**
     * Read the delivery point into memory, once.
     *
     * On the per-fix path there must be no I/O — the comment on storeFix is
     * emphatic about that and it is right — so the destination is fetched here
     * and held in a field for the life of the service.
     */
    private suspend fun loadDestination() {
        destination = store.destination()
        arrivalAnnounced = store.arrivalAnnounced()
        Log.i(TAG, "Destination: " + (destination?.let { "%.5f,%.5f r=%dm".format(it.lat, it.lon, it.radiusM) } ?: "none"))
    }

    /**
     * Distance to the gate, and whether we are at it.
     *
     * Called from the per-fix path, so it does arithmetic and nothing else: a
     * haversine is a handful of trig operations and costs nothing next to the
     * Room insert already happening there. The announcement, which does I/O,
     * happens at most once per session.
     */
    private fun updateDestinationProgress(location: Location) {
        val target = destination ?: return
        remainingM = target.distanceFrom(location.latitude, location.longitude)

        if (arrivalAnnounced) return

        val accuracy = if (location.hasAccuracy()) location.accuracy else null
        if (!target.hasArrived(location.latitude, location.longitude, accuracy)) {
            arrivalStreak = 0
            return
        }

        arrivalStreak++
        if (arrivalStreak < ARRIVAL_FIXES_REQUIRED) return

        arrivalAnnounced = true
        lifecycleScope.launch { announceArrival(target) }
    }

    /**
     * Tell the driver they have arrived, once.
     *
     * Deliberately does NOT stop tracking. The lorry being inside the radius is
     * not the same as the load being handed over — there is a gate, a queue, a
     * weighbridge and paperwork between the two, and a tracker that switched
     * itself off on arrival would lose exactly the part of the route a
     * short-delivery argument turns on. The driver is offered the button; the
     * decision stays theirs.
     */
    private suspend fun announceArrival(target: Destination) {
        store.setArrivalAnnounced(true)
        repository.recordLocalEvent(
            type = "ARRIVED",
            message = "Within " + target.radiusM + "m of the delivery point",
        )
        notifications.alert(
            title = getString(R.string.arrival_title),
            body = getString(R.string.arrival_body),
        )
        Log.i(TAG, "Arrival announced")
    }

    private fun handleLocation(location: Location) {
        // Drop fixes too vague to be worth a row — but keep the very first one
        // regardless, so the map has something to show immediately.
        val accuracy = if (location.hasAccuracy()) location.accuracy else Float.MAX_VALUE
        if (accuracy > MAX_ACCEPTABLE_ACCURACY_M && fixCount > 0) {
            Log.d(TAG, "Discarded fix with ${accuracy}m accuracy")
            return
        }

        updateMovementState(location)
        updateDestinationProgress(location)
        fixCount++
        /*
         * Updated on every RECEIVED fix, not every stored one.
         *
         * This is what the watchdog reads to decide whether the location engine
         * has wedged. In distance mode a parked truck legitimately stores
         * nothing for a long time while the GPS keeps working perfectly, and
         * gating this on storage would make the watchdog tear down a healthy
         * session every idle interval.
         *
         * Plain volatile write. This used to be a DataStore edit{} — a full
         * preferences rewrite plus fsync — on every single fix.
         */
        lastFixAtMs = location.time

        if (!shouldStore(location)) return
        lastStoredLocation = location
        lastStoredElapsedMs = SystemClock.elapsedRealtime()

        /*
         * The ONLY work on the per-fix path: one Room insert.
         *
         * maybeUpdateNotification() used to be called from here. Its 5-second
         * throttle never suppressed anything at any configured cadence (the
         * default ping interval is 10 s, so `10000 < 5000` is always false), so
         * every fix rebuilt three PendingIntents, ran two COUNT queries, made
         * two ConnectivityService binder calls, and woke SystemUI to re-render
         * the shade. The 15 s pump already owns the notification.
         */
        lifecycleScope.launch { repository.storeFix(location) }
    }

    /**
     * Distance trigger.
     *
     * When the dispatcher chose "every N metres", only fixes that advanced the
     * truck by N metres since the last STORED one are worth a row. The obvious
     * implementation is `LocationRequest.setMinUpdateDistanceMeters(N)`, and it
     * is the wrong one for this product: with a displacement filter the fused
     * client simply stops calling back, so a truck standing at a customer's
     * gate produces nothing at all, the server sees no telemetry, and the
     * dashboard reports a healthy parked truck as STALE and then LOST — the one
     * signal the whole system exists to make trustworthy.
     *
     * Filtering here instead keeps the callback stream, so the truck can still
     * emit a heartbeat on the idle cadence. A dwell is proven, a silence still
     * means a problem, and the row count for a slow city crawl drops by an
     * order of magnitude, which is what was actually being asked for.
     */
    private fun shouldStore(location: Location): Boolean {
        val trigger = minDistanceM
        if (trigger <= 0) return true

        // Never drop the first fix of a session: the map needs something to show
        // and the dispatcher needs to see the truck leave the yard.
        val previous = lastStoredLocation ?: return true
        if (previous.distanceTo(location) >= trigger) return true

        // Heartbeat. Also covers the case where lastStoredElapsedMs is 0 after a
        // process restart, which reads as "overdue" and stores immediately.
        return SystemClock.elapsedRealtime() - lastStoredElapsedMs >= idleIntervalMs
    }

    /**
     * Adaptive cadence.
     *
     * A truck waiting three hours at a customer's gate does not need a fix every
     * 10 seconds — that is ~1,000 useless rows and a measurable slice of the
     * battery the phone needs for the return leg. Dropping to the idle cadence
     * while stationary typically halves whole-shift consumption, and the
     * transition back to fast sampling happens on the very first moving fix.
     */
    private fun updateMovementState(location: Location) {
        val now = SystemClock.elapsedRealtime()
        val speed = if (location.hasSpeed()) location.speed else 0f
        val movedFar = lastLocation?.let { it.distanceTo(location) > MOVING_DISTANCE_M } ?: true

        if (speed > MOVING_SPEED_MPS || movedFar) {
            lastMovementElapsedMs = now
        }
        lastLocation = location

        val shouldBeIdle = now - lastMovementElapsedMs > IDLE_AFTER_MS
        val desired = if (shouldBeIdle) Mode.IDLE else Mode.MOVING
        if (desired == currentMode) return

        currentMode = desired
        lifecycleScope.launch {
            val policy = store.policy()
            requestLocationUpdates(
                if (desired == Mode.IDLE) policy.idleIntervalMs else policy.pingIntervalMs,
            )
        }
    }

    /**
     * The realtime pump.
     *
     * Runs every REALTIME_FLUSH_INTERVAL_MS and does three things:
     *   1. renew the wake lock (so a leak cannot outlive the service),
     *   2. push whatever is buffered if we appear to be online,
     *   3. refresh the notification.
     *
     * If the push fails, nothing happens — the points stay in SQLite and
     * WorkManager's constrained SyncWorker takes over. There is no error path
     * here that can lose data, which is the entire point of the design.
     */
    private fun startPump() {
        pumpJob?.cancel()
        pumpJob = lifecycleScope.launch {
            var tick = 0L
            while (isActive) {
                delay(BuildConfig.REALTIME_FLUSH_INTERVAL_MS)
                tick++
                renewWakeLock()
                // Battery + network type: sampled here, stamped onto every fix
                // from cache. They change ~100x a shift, not 10,000x.
                repository.sampleTelemetry()

                /*
                 * Match the upload cadence to the sampling cadence.
                 *
                 * A truck parked for three hours produces one point a minute,
                 * but this pump used to POST every 15 s regardless — four
                 * requests to ship at most one point, each one dragging the
                 * modem out of RRC_IDLE and back through the tail timer. That
                 * is the largest network-attributable draw in the app.
                 *
                 * While idle, fall back to one attempt per idle interval. There
                 * is no data risk: nothing is dropped, it is only sent slightly
                 * later, and WorkManager's periodic sync is still behind it.
                 */
                // One read per tick, shared by the cadence calculation and the
                // policy check below. This was two DataStore reads every 15 s
                // for a value that changes a handful of times a shift.
                val policy = store.policy()

                val idleEvery = (policy.idleIntervalMs /
                    BuildConfig.REALTIME_FLUSH_INTERVAL_MS).coerceAtLeast(1)
                val shouldFlush = currentMode == Mode.MOVING || tick % idleEvery == 0L

                if (shouldFlush) {
                    runCatching { repository.flushIfOnline() }
                        .onFailure { Log.d(TAG, "Realtime flush failed: ${it.message}") }
                }
                // Persist the fix time here (4x/minute) instead of on every
                // fix. The watchdog and the UI read it from disk, so it has to
                // reach DataStore eventually — just not 10,000 times a shift.
                if (lastFixAtMs > 0) store.markFix(lastFixAtMs)

                /*
                 * Refresh the notification on the same cadence as uploads.
                 *
                 * While MOVING that is every tick, unchanged. While IDLE it
                 * drops to once per idle interval — because snapshot() runs two
                 * COUNT queries and a ConnectivityService binder call, and doing
                 * that four times a minute to re-render "parked, nothing
                 * buffered" is work with no reader.
                 */
                if (shouldFlush) maybeUpdateNotification()
                applyPolicy(policy)
            }
        }
    }

    /** Adopt a policy the dispatcher changed mid-shift (echoed on every ack). */
    private fun applyPolicy(policy: TrackingPolicy) {
        cachePolicy(policy)
        val target = if (currentMode == Mode.IDLE) policy.idleIntervalMs else policy.pingIntervalMs
        if (target != activeIntervalMs) {
            activeIntervalMs = target
            requestLocationUpdates(target)
        }
    }

    /**
     * The distance trigger and the heartbeat are read on the hot path, which
     * runs on the main looper and cannot suspend on DataStore.
     */
    private fun cachePolicy(policy: TrackingPolicy) {
        minDistanceM = policy.minDistanceM
        idleIntervalMs = policy.idleIntervalMs
    }

    /** Force a re-registration — the watchdog's remedy for a wedged fused client. */
    private suspend fun forceReregister() {
        val policy = store.policy()
        cachePolicy(policy)
        activeIntervalMs = if (currentMode == Mode.IDLE) policy.idleIntervalMs else policy.pingIntervalMs
        requestLocationUpdates(activeIntervalMs)
    }

    private var activeIntervalMs: Long = BuildConfig.DEFAULT_PING_INTERVAL_MS

    /**
     * Refresh the ongoing notification. Called only from the 15 s pump.
     *
     * Memoised on CONTENT rather than on elapsed time. Re-posting an identical
     * notification does not help keep a foreground service alive, so in the
     * steady state (parked truck, nothing buffered) this posts nothing at all
     * and SystemUI is never woken.
     */
    private suspend fun maybeUpdateNotification(force: Boolean = false) {
        val snapshot = repository.snapshot()
        val title = snapshot.reference
            ?.let { getString(R.string.notification_title_ref, it) }
            ?: getString(R.string.notification_title)
        val body = notificationBody(snapshot)

        val key = Triple(title, body, snapshot.pendingCount)
        if (!force && key == lastPostedNotification) return
        lastPostedNotification = key

        /*
         * Published only when the notification actually changes.
         *
         * The distance is recomputed per fix, but writing it to DataStore that
         * often would be four thousand disk writes over an eighteen-hour run to
         * move a number nobody is watching. The notification text is already
         * throttled by the key above — it changes when the rounded distance
         * does, roughly once a minute at motorway speed — and that is exactly
         * the cadence the screen needs.
         */
        store.setRemainingM(remainingM)

        notifications.update(
            NOTIFICATION_ID,
            notifications.build(
                title = title,
                body = body,
                buffered = snapshot.pendingCount,
                ongoing = true,
            ),
        )
    }

    /**
     * The one line a driver reads for eighteen hours.
     *
     * Composed here rather than in the repository, which has no Context and so
     * could never reach a translated string — that is why this notification was
     * the only screen in the app locked to Turkish.
     *
     * The remaining distance goes first when it is known, because it is the
     * only part that changes as the lorry moves and the only part the driver is
     * actually watching for.
     */
    private fun notificationBody(snapshot: TrackingRepository.Snapshot): String = buildString {
        remainingText()?.let { append(it).append(" · ") }
        snapshot.orderNumber?.let { append(it).append(" · ") }
        snapshot.destination?.let { append(it).append(" · ") }
        append(
            when {
                !snapshot.online && snapshot.pendingCount > 0 ->
                    getString(R.string.notification_offline, snapshot.pendingCount.toString())
                snapshot.pendingCount > 0 ->
                    getString(R.string.notification_sending, snapshot.pendingCount.toString())
                snapshot.lastFixAt > 0 -> getString(R.string.notification_sent)
                else -> getString(R.string.notification_waiting_gps)
            },
        )
    }

    /** "340 km kaldı", or null when the order has no destination or no fix yet. */
    private fun remainingText(): String? {
        val metres = remainingM ?: return null
        val (value, unit) = formatRemaining(metres)
        return when (unit) {
            DistanceUnit.METRES -> getString(R.string.distance_metres, value)
            DistanceUnit.KILOMETRES -> getString(R.string.distance_kilometres, value)
        }
    }

    // =========================================================================
    // Power
    // =========================================================================

    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            "KaraHoca::TrackingWakeLock",
        ).apply {
            setReferenceCounted(false)
            acquire(WAKELOCK_TIMEOUT_MS)
        }
        Log.i(TAG, "Partial wake lock acquired")
    }

    private fun renewWakeLock() {
        val lock = wakeLock ?: return acquireWakeLock()
        if (!lock.isHeld) {
            lock.acquire(WAKELOCK_TIMEOUT_MS)
        }
    }

    private fun releaseWakeLock() {
        wakeLock?.takeIf { it.isHeld }?.release()
        wakeLock = null
    }

    private fun hasLocationPermission(): Boolean =
        ActivityCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    // =========================================================================
    // Death and resurrection
    // =========================================================================

    /**
     * The driver swiped the app out of Recents.
     *
     * `stopWithTask="false"` keeps the *service* alive, but several OEM builds
     * ignore that and tear the process down anyway. We therefore schedule an
     * exact alarm before returning: if we survive, the alarm finds the service
     * already running and does nothing; if we do not, it brings us back in
     * about two seconds.
     */
    override fun onTaskRemoved(rootIntent: Intent?) {
        Log.w(TAG, "Task removed (app swiped away) — arming restart alarm")
        ServiceWatchdog.scheduleImmediateRestart(this)
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        Log.w(TAG, "Service destroyed")
        pumpJob?.cancel()
        locationCallback?.let(fused::removeLocationUpdates)
        locationCallback = null
        releaseWakeLock()

        /*
         * Resurrect only what we did NOT kill ourselves.
         *
         * `selfStopped` is the whole point. Previously this read the persisted
         * TRACKING_ACTIVE flag, which the involuntary shutdown paths never
         * cleared — so a service that could not start (permission revoked,
         * startForeground refused) armed a 2-second alarm, restarted, failed
         * again, and armed another. An unbounded 0.5 Hz loop holding a wake
         * lock and recording nothing, with no counter and no ceiling.
         *
         * Reading an in-process @Volatile instead of runBlocking on DataStore
         * also removes a disk read from a path that has milliseconds to live.
         */
        if (trackingActive && !selfStopped) {
            Log.w(TAG, "Destroyed while still active — scheduling resurrection")
            ServiceWatchdog.scheduleImmediateRestart(this)
            ServiceWatchdog.schedule(this)
        } else {
            Log.i(TAG, "Destroyed deliberately (selfStopped=$selfStopped) — not resurrecting")
        }

        super.onDestroy()
    }

    /** Clean, driver-initiated stop. The only path that clears TRACKING_ACTIVE. */
    private suspend fun shutdown(userInitiated: Boolean) {
        Log.i(TAG, "Shutting down (userInitiated=$userInitiated)")
        // Either way this is OUR decision, so onDestroy must not resurrect it.
        selfStopped = true

        if (userInitiated) {
            repository.recordLocalEvent(type = "PAUSED", message = "Driver stopped tracking")
            store.setTrackingActive(false)
            trackingActive = false
            ServiceWatchdog.cancel(this)
            // One last push, then let WorkManager keep retrying anything left:
            // the buffer must drain even after the driver thinks they are done.
            runCatching { repository.flushIfOnline() }
            // Only chase a follow-up sync when something is actually left.
            // An unconditional enqueue here is one half of the stop ping-pong:
            // SyncWorker drains, calls stop(), which lands back here, which
            // enqueues another sync. schedulePeriodic() already covers the rest.
            if (repository.hasUnsentWork()) syncScheduler.syncNow(expedited = true)
        }
        pumpJob?.cancel()
        locationCallback?.let(fused::removeLocationUpdates)
        releaseWakeLock()
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }
}
