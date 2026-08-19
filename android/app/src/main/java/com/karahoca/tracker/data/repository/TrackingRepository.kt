package com.karahoca.tracker.data.repository

import android.content.Context
import android.location.Location
import android.os.BatteryManager
import android.os.Build
import android.os.SystemClock
import android.util.Log
import com.karahoca.tracker.BuildConfig
import com.karahoca.tracker.data.local.LocationPointDao
import com.karahoca.tracker.data.local.LocationPointEntity
import com.karahoca.tracker.data.local.PendingEventDao
import com.karahoca.tracker.data.local.PendingEventEntity
import com.karahoca.tracker.data.local.SessionStore
import com.karahoca.tracker.data.remote.ApiFailure
import com.karahoca.tracker.data.remote.ClaimRequest
import com.karahoca.tracker.data.remote.DriverEventRequest
import com.karahoca.tracker.data.remote.IngestBatchRequest
import com.karahoca.tracker.data.remote.LocationPointDto
import com.karahoca.tracker.data.remote.RefreshRequest
import com.karahoca.tracker.data.remote.TrackingApi
import com.karahoca.tracker.sync.UploadBackoff
import com.karahoca.tracker.sync.NetworkMonitor
import com.karahoca.tracker.util.DeviceInfoProvider
import com.karahoca.tracker.util.Ulid
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import retrofit2.Response
import java.io.IOException
import java.time.Instant
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong
import javax.inject.Inject
import javax.inject.Singleton

/**
 * ============================================================================
 *  OFFLINE-FIRST BUFFERING AND SYNC
 * ============================================================================
 *
 * The invariant this class exists to protect:
 *
 *     A GPS fix is deleted from the device only after the server has
 *     acknowledged, by batch id, that it holds it.
 *
 * Nothing — a timeout, a 500, a killed process, a flat battery, a lost ack —
 * can delete a point. The worst possible outcome is that a batch is uploaded
 * twice, which the server deduplicates on `(session_id, client_point_id,
 * recorded_at)` for free (ADR-005, ADR-010).
 */
@Singleton
class TrackingRepository @Inject constructor(
    @ApplicationContext private val context: Context,
    private val api: TrackingApi,
    private val pointDao: LocationPointDao,
    private val eventDao: PendingEventDao,
    private val store: SessionStore,
    private val network: NetworkMonitor,
    private val deviceInfo: DeviceInfoProvider,
) {

    companion object {
        private const val TAG = "KH/Repo"

        /** Anything claimed longer ago than this belonged to a dead process. */
        private const val STALE_CLAIM_MS = 5 * 60 * 1000L

        /** Cap on chunks per sync pass, so one run cannot spin forever. */
        private const val MAX_CHUNKS_PER_PASS = 40

        /** Sequence numbers reserved per DataStore write. ~100 fsyncs/shift, not 10,000. */
        private const val SEQ_WINDOW = 100L

        /**
         * Upload backoff bounds for the 15-second realtime pump.
         *
         * 15 s base is one pump tick — the first failure costs nothing extra,
         * so a single dropped packet does not delay a live truck. Doubling
         * reaches the 5-minute cap after five consecutive failures, which is
         * also the watchdog's heartbeat, so a genuinely unreachable server
         * settles at roughly one attempt per heartbeat instead of twenty.
         */
        private const val BACKOFF_BASE_MS = 15_000L
        private const val BACKOFF_CAP_MS = 5 * 60 * 1000L

        /** Shared serializer for the free-form event payload map. */
        private val STRING_MAP = MapSerializer(String.serializer(), String.serializer())
    }

    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    /**
     * Serialises uploads. The realtime pump (every 15 s) and the WorkManager
     * SyncWorker can both fire at once; without this they would claim
     * overlapping batches and waste bandwidth re-sending the same points.
     */
    private val uploadMutex = Mutex()

    /** Halved on 413, restored on success. Adapts to whatever the link can carry. */
    @Volatile private var chunkSize: Int = BuildConfig.SYNC_BATCH_SIZE

    /**
     * Device sequence counter, held in memory and flushed rarely.
     *
     * Seeded from max(persisted, MAX(device_seq) in the buffer), which is
     * strictly safer than the previous per-fix DataStore increment: that one
     * already burned a sequence number whenever the process died between the
     * write and the insert.
     */
    private val deviceSeq = AtomicLong(-1)
    private val seqMutex = Mutex()
    @Volatile private var seqCeiling = 0L

    /**
     * Battery and network type, sampled on a timer rather than per fix.
     *
     * Both change on the order of a hundred times a shift; they were being read
     * ten thousand times. `batteryPct` costs a health-HAL traversal and
     * `currentType()` two binder round trips into ConnectivityService.
     */
    @Volatile private var cachedBatteryPct: Int? = null
    @Volatile private var cachedCharging = false
    @Volatile private var cachedNetworkType: String? = null
    @Volatile private var telemetrySampledAt = 0L

    /**
     * Gates the realtime pump after a failed upload. See [UploadBackoff].
     *
     * WorkManager keeps its own backoff and is deliberately not gated by this:
     * it runs on the order of minutes and is network-constrained, so it was
     * never the source of the wasted radio wake-ups.
     */
    private val backoff = UploadBackoff(
        baseMs = BACKOFF_BASE_MS,
        capMs = BACKOFF_CAP_MS,
        clock = SystemClock::elapsedRealtime,
    )

    // =========================================================================
    // 1. CAPTURE — called from the location callback. Must be fast and infallible.
    // =========================================================================

    /**
     * Next sequence number. In-memory increment; persisted every 100th value.
     *
     * A crash loses at most the tail of the range, and re-seeding from
     * MAX(device_seq) in the buffer recovers it exactly. The sequence only has
     * to be monotonic for gap detection — it is not an identity, that is the
     * ULID.
     */
    private suspend fun nextSeq(): Long {
        if (deviceSeq.get() < 0) {
            seqMutex.withLock {
                if (deviceSeq.get() < 0) {
                    val seed = maxOf(store.deviceSeq(), pointDao.maxDeviceSeq() ?: 0L)
                    seqCeiling = seed
                    deviceSeq.set(seed)
                }
            }
        }
        val n = deviceSeq.incrementAndGet()
        if (n > seqCeiling) {
            /*
             * Persist the CEILING of a reserved window, never the last number
             * issued. A process kill can then only SKIP sequence numbers, never
             * reuse them — and that asymmetry matters: skips are harmless to
             * the dispatcher's gap detection, reuse would corrupt it.
             *
             * Seeding from MAX(device_seq) alone is not enough, because rows are
             * deleted from the buffer once the server acknowledges them, so the
             * table's maximum can be lower than the highest number ever issued.
             */
            seqCeiling = n + SEQ_WINDOW
            store.saveDeviceSeq(seqCeiling)
        }
        return n
    }

    /**
     * Refresh the cached battery/network telemetry. Called from the 15 s pump.
     *
     * Deliberately not on the per-fix path: these values change ~100 times a
     * shift and were being polled ~10,000 times.
     */
    fun sampleTelemetry() {
        cachedBatteryPct = batteryPercent()
        cachedCharging = isCharging()
        cachedNetworkType = network.currentType()
        telemetrySampledAt = System.currentTimeMillis()
    }

    /** Is there anything at all still waiting to reach the server? */
    suspend fun hasUnsentWork(): Boolean =
        pointDao.pendingCount() > 0 || eventDao.oldest(1).isNotEmpty()

    suspend fun storeFix(location: Location) {
        val sessionId = store.sessionId() ?: return

        // First fix after a (re)start: make sure the cache is populated rather
        // than writing a row with null battery and null network type.
        if (telemetrySampledAt == 0L) sampleTelemetry()

        val entity = LocationPointEntity(
            id = Ulid.generate(location.time.takeIf { it > 0 } ?: System.currentTimeMillis()),
            sessionId = sessionId,
            /*
             * Location.getTime() is UTC derived from the GNSS fix itself, not
             * from the phone's clock. A driver who changes the timezone or sets
             * the clock wrong mid-shift cannot corrupt the route (ADR-011).
             */
            recordedAt = location.time.takeIf { it > 0 } ?: System.currentTimeMillis(),
            elapsedRealtimeNs = location.elapsedRealtimeNanos,
            lat = location.latitude,
            lon = location.longitude,
            accuracyM = location.accuracy.takeIf { location.hasAccuracy() },
            altitudeM = location.altitude.takeIf { location.hasAltitude() },
            verticalAccuracyM = if (location.hasVerticalAccuracy()) {
                location.verticalAccuracyMeters
            } else {
                null
            },
            speedMps = location.speed.takeIf { location.hasSpeed() },
            speedAccuracyMps = if (location.hasSpeedAccuracy()) {
                location.speedAccuracyMetersPerSecond
            } else {
                null
            },
            bearingDeg = location.bearing.takeIf { location.hasBearing() },
            satellites = location.extras?.getInt("satellites")?.takeIf { it > 0 },
            provider = location.provider,
            batteryPct = cachedBatteryPct,
            isCharging = cachedCharging,
            /*
             * Never discarded. A spoofed route is evidence in a dispute with a
             * carrier, and silently dropping the points would destroy it.
             */
            isMock = isMockLocation(location),
            networkType = cachedNetworkType,
            deviceSeq = nextSeq(),
        )

        /*
         * Never let a storage failure escape.
         *
         * storeFix is invoked from a bare `lifecycleScope.launch` in the
         * service with no CoroutineExceptionHandler. lifecycleScope uses a
         * SupervisorJob so siblings survive, but an *uncaught* exception still
         * reaches Android's default handler and takes the whole process down —
         * so one SQLITE_FULL on a driver's nearly-full phone would end the
         * shift with a crash dialog instead of a degraded but working tracker.
         */
        val evicted = try {
            pointDao.insertWithCap(entity, BuildConfig.BUFFER_MAX_ROWS)
        } catch (e: Exception) {
            Log.e(TAG, "Buffer write failed — dropping this fix, tracking continues", e)
            return
        }

        if (evicted > 0) {
            // Loud, and recorded server-side the moment we reconnect. A silent
            // buffer overflow is indistinguishable from a bug.
            Log.e(TAG, "BUFFER OVERFLOW — evicted $evicted oldest point(s)")
            recordLocalEvent(
                type = "BUFFER_OVERFLOW",
                message = "Local buffer hit ${BuildConfig.BUFFER_MAX_ROWS} rows; " +
                    "dropped $evicted oldest point(s)",
                payload = mapOf("evicted" to evicted.toString()),
            )
        }
    }

    /**
     * Queue a lifecycle/diagnostic event.
     *
     * Buffered like a location point, on purpose: SERVICE_KILLED and
     * BUFFER_OVERFLOW are generated exactly when we are offline or dying, so a
     * fire-and-forget HTTP call would lose the one message a dispatcher needs.
     */
    suspend fun recordLocalEvent(
        type: String,
        message: String? = null,
        payload: Map<String, String>? = null,
    ) {
        val sessionId = store.sessionId() ?: return
        eventDao.insert(
            PendingEventEntity(
                sessionId = sessionId,
                type = type,
                occurredAt = System.currentTimeMillis(),
                message = message,
                // Explicit serializer rather than the reified `encodeToString(value)`.
                // Both overloads take a single type parameter, so an explicit type
                // argument does not disambiguate them and the compiler binds to
                // `encodeToString(SerializationStrategy<T>, T)` instead.
                payload = payload?.let { json.encodeToString(STRING_MAP, it) },
            ),
        )
        Log.i(TAG, "Event queued: $type ${message.orEmpty()}")
    }

    /** Startup recovery: reclaim rows stranded by a process kill mid-upload. */
    suspend fun recoverOrphanedBatches() {
        val recovered = pointDao.resetStaleInFlight(System.currentTimeMillis() - STALE_CLAIM_MS)
        if (recovered > 0) {
            Log.w(TAG, "Recovered $recovered orphaned point(s) from a previous run")
        }
        eventDao.dropPoisoned()
    }

    // =========================================================================
    // 2. SYNC
    // =========================================================================

    sealed interface SyncOutcome {
        /** Buffer is empty. */
        data object Drained : SyncOutcome
        /** Progress made, more remains — run again immediately. */
        data class Progress(val uploaded: Int, val remaining: Int) : SyncOutcome
        /** Retry later with backoff; points are safe in the buffer. */
        data class Retry(val reason: String) : SyncOutcome
        /** Session is over. Stop the service; do NOT discard the buffer. */
        data class SessionClosed(val status: String) : SyncOutcome
        /** Credentials are dead. The driver must re-claim with a new code. */
        data object Unauthorised : SyncOutcome
    }

    /** Opportunistic single-chunk push from the service's realtime pump. */
    suspend fun flushIfOnline(): SyncOutcome {
        if (backoff.shouldWait()) {
            // The cheapest possible exit: no connectivity binder call, no Room
            // query, no socket. Arithmetic only.
            return SyncOutcome.Retry("backing off ${backoff.remainingMs() / 1000}s")
        }
        if (!network.isOnline()) return SyncOutcome.Retry("offline")
        return syncOnce()
    }

    private fun noteFailure(retryAfterSec: Long? = null) {
        backoff.onFailure(retryAfterSec)
        Log.d(TAG, "Backing off ${backoff.remainingMs() / 1000}s (failure #${backoff.failureCount})")
    }

    private fun noteSuccess() = backoff.onSuccess()

    /** Seconds the server asked us to wait, if it said. */
    private fun retryAfterFrom(response: Response<*>, body: String?): Long? {
        // Prefer the standard header; fall back to the envelope's details block,
        // which is what this API actually populates (ADR-011).
        response.headers()["Retry-After"]?.toLongOrNull()?.let { return it }
        if (body == null) return null
        return runCatching {
            json.decodeFromString<com.karahoca.tracker.data.remote.ApiErrorBody>(body)
                .error?.details?.get("retryAfterSec")?.toLongOrNull()
        }.getOrNull()
    }

    /**
     * Drain the buffer, called by [com.karahoca.tracker.sync.SyncWorker].
     *
     * Loops chunk by chunk so that a truck emerging from a two-hour dead zone
     * uploads its whole 700-point backlog in one wake-up rather than one chunk
     * every 15 minutes.
     */
    suspend fun syncAll(): SyncOutcome {
        recoverOrphanedBatches()
        uploadPendingEvents()

        var uploaded = 0
        repeat(MAX_CHUNKS_PER_PASS) {
            when (val outcome = syncOnce()) {
                is SyncOutcome.Progress -> {
                    uploaded += outcome.uploaded
                    if (outcome.remaining == 0) return SyncOutcome.Drained
                }
                is SyncOutcome.Drained -> return SyncOutcome.Drained
                else -> return outcome
            }
        }
        return SyncOutcome.Progress(uploaded, pointDao.pendingCount())
    }

    /**
     * Upload exactly one chunk. The complete claim → send → ack/release cycle.
     */
    // Every exit uses a labelled `return@withLock`. Bare non-local returns out
    // of an expression-bodied function are subtle to read and easy to break, so
    // the label is deliberate rather than incidental.
    private suspend fun syncOnce(): SyncOutcome = uploadMutex.withLock {
        if (store.sessionId() == null) return@withLock SyncOutcome.Unauthorised

        // ---- Proactive token refresh -----------------------------------------
        // Done before claiming rows: refreshing after a claim would leave the
        // batch IN_FLIGHT during a failed refresh, delaying it by STALE_CLAIM_MS.
        if (store.tokenNeedsRefresh() && !refreshToken()) {
            return@withLock SyncOutcome.Retry("token refresh failed")
        }

        // ---- Claim ------------------------------------------------------------
        val batchId = UUID.randomUUID().toString()
        val claimed = pointDao.claimBatch(batchId, chunkSize, System.currentTimeMillis())
        if (claimed == 0) return@withLock SyncOutcome.Drained

        val rows = pointDao.getBatch(batchId)
        if (rows.isEmpty()) return@withLock SyncOutcome.Drained

        val remainingBefore = pointDao.pendingCount()

        /*
         * "offline" is not "was the radio down" — it is "is this a backlog?".
         * The server uses the flag to emit route:backfill instead of
         * position:update, so a truck coming out of a dead zone does not make
         * its own marker rewind across the dispatcher's map (ADR-006).
         */
        val isBacklog = rows.size > 1 &&
            (System.currentTimeMillis() - rows.first().recordedAt) > 60_000

        val request = IngestBatchRequest(
            batchId = batchId,
            offline = isBacklog,
            bufferRemaining = remainingBefore,
            points = rows.map(::toDto),
        )

        // ---- Send -------------------------------------------------------------
        val response: Response<com.karahoca.tracker.data.remote.IngestResponse> = try {
            api.ingestBatch(request)
        } catch (e: IOException) {
            // Network died mid-flight. Release and let backoff handle it.
            pointDao.releaseBatch(batchId)
            noteFailure()
            Log.d(TAG, "Upload failed (network): ${e.message}")
            return@withLock SyncOutcome.Retry("network: ${e.message}")
        } catch (e: Exception) {
            pointDao.releaseBatch(batchId)
            noteFailure()
            Log.e(TAG, "Upload failed (unexpected)", e)
            return@withLock SyncOutcome.Retry("unexpected: ${e.message}")
        }

        // ---- Acknowledge ------------------------------------------------------
        if (response.isSuccessful) {
            val body = response.body()

            // THE ONLY DELETE IN THE ENTIRE APP.
            pointDao.deleteBatch(batchId)

            body?.let {
                if (it.serverTime > 0) store.recordServerTime(it.serverTime)
                it.policy?.let { policy ->
                    store.savePolicy(
                        policy.pingIntervalSec,
                        policy.idleIntervalSec,
                        policy.minDistanceM,
                    )
                }
            }
            store.markSynced()
            noteSuccess()
            if (chunkSize < BuildConfig.SYNC_BATCH_SIZE) {
                chunkSize = (chunkSize * 2).coerceAtMost(BuildConfig.SYNC_BATCH_SIZE)
            }

            val remaining = pointDao.pendingCount()
            Log.i(
                TAG,
                "Uploaded ${rows.size} point(s) " +
                    "(accepted=${body?.accepted} dup=${body?.duplicates} " +
                    "backlog=$isBacklog remaining=$remaining)",
            )

            val closedStatus = body?.sessionStatus
                ?.takeIf { it !in setOf("CLAIMED", "ACTIVE", "PAUSED") }
            if (closedStatus != null) return@withLock SyncOutcome.SessionClosed(closedStatus)

            return@withLock if (remaining == 0) {
                SyncOutcome.Drained
            } else {
                SyncOutcome.Progress(rows.size, remaining)
            }
        }

        // ---- Failure ----------------------------------------------------------
        pointDao.releaseBatch(batchId)

        /*
         * The error body is read EXACTLY ONCE.
         *
         * okhttp's ResponseBody.string() consumes and closes the source; a
         * second call throws. Both of this class's parse helpers call it, and
         * because they wrap in runCatching a double read would not surface as
         * an error — it would silently return null and the retry policy would
         * quietly fall through to the generic branch. Read it here, pass the
         * string down.
         */
        val rawError = runCatching { response.errorBody()?.string() }.getOrNull()
        val apiCode = decodeErrorCode(rawError)
        Log.w(TAG, "Upload rejected: HTTP ${response.code()} / $apiCode")

        return@withLock when (ApiFailure.from(response.code(), apiCode)) {
            ApiFailure.TOKEN_EXPIRED ->
                if (refreshToken()) SyncOutcome.Retry("token refreshed, retry")
                else SyncOutcome.Unauthorised

            ApiFailure.SESSION_CLOSED -> SyncOutcome.SessionClosed(apiCode ?: "CLOSED")

            ApiFailure.UNAUTHORISED -> SyncOutcome.Unauthorised

            ApiFailure.BATCH_TOO_LARGE -> {
                // Halve and retry. Self-tunes to whatever this link/server allows
                // instead of retrying an identical oversized payload forever.
                // Not a backoff case: a smaller payload may well succeed at once.
                chunkSize = (chunkSize / 2).coerceAtLeast(25)
                Log.w(TAG, "Chunk size reduced to $chunkSize")
                SyncOutcome.Retry("batch too large; chunk=$chunkSize")
            }

            ApiFailure.RATE_LIMITED -> {
                val after = retryAfterFrom(response, rawError)
                noteFailure(retryAfterSec = after)
                SyncOutcome.Retry("rate limited${after?.let { "; retry after ${it}s" } ?: ""}")
            }

            ApiFailure.PERMANENT -> {
                /*
                 * A 400 on a whole batch usually means one poisoned row. Rather
                 * than block the queue forever, shrink so the next attempts
                 * isolate it; the server also counts malformed points and
                 * accepts the rest of a batch, so this converges.
                 */
                chunkSize = (chunkSize / 4).coerceAtLeast(10)
                SyncOutcome.Retry("payload rejected; isolating with chunk=$chunkSize")
            }

            ApiFailure.TRANSIENT -> {
                noteFailure()
                SyncOutcome.Retry("server ${response.code()}")
            }
        }
    }

    /** Events ride their own tiny queue; a failure never blocks location sync. */
    private suspend fun uploadPendingEvents() {
        if (!network.isOnline()) return
        val events = eventDao.oldest(20)
        for (event in events) {
            val ok = runCatching {
                api.postEvent(
                    DriverEventRequest(
                        type = event.type,
                        occurredAt = Instant.ofEpochMilli(event.occurredAt).toString(),
                        message = event.message,
                        payload = event.payload?.let {
                            runCatching { json.decodeFromString<Map<String, String>>(it) }.getOrNull()
                        },
                    ),
                ).isSuccessful
            }.getOrDefault(false)

            if (ok) eventDao.delete(event.id) else eventDao.markAttempt(event.id)
        }
    }

    // =========================================================================
    // 3. SESSION LIFECYCLE
    // =========================================================================

    suspend fun claimSession(code: String): Result<String> = runCatching {
        val response = try {
            api.claim(ClaimRequest(code = code, device = deviceInfo.toDto(store.deviceId())))
        } catch (io: java.io.IOException) {
            /*
             * No answer at all: no signal in the yard, DNS down, or the API
             * being replaced mid-deploy. Retrofit surfaces this as an
             * IOException whose message is a hostname and a stack of causes,
             * and the view model puts `err.message` straight on screen — so
             * without this the driver reads something like
             * "Failed to connect to track.karahoca.com/1.2.3.4:443".
             *
             * Caught separately from the HTTP branch below because the two need
             * opposite advice: this one says wait, that one may say the code is
             * wrong.
             */
            error(ClaimFailure.NO_NETWORK)
        }
        if (!response.isSuccessful) {
            error(ClaimFailure.message(response.code(), response.errorBody()?.string()))
        }
        val body = response.body() ?: error("Empty response from server")

        store.saveCredentials(
            sessionId = body.sessionId,
            reference = body.reference,
            accessToken = body.accessToken,
            refreshToken = body.refreshToken,
            ingestKeyB64 = body.ingestKey,
            expiresInSec = body.expiresIn,
            serverTimeSec = body.serverTime,
        )
        store.savePolicy(
            body.policy.pingIntervalSec,
            body.policy.idleIntervalSec,
            body.policy.minDistanceM,
        )
        store.saveShipment(
            orderNumber = body.shipment.orderNumber,
            customerName = body.shipment.customerName,
            destination = body.shipment.destinationLabel ?: body.shipment.destinationAddress,
            // The coordinate the server has always sent and this app has never
            // read. Without it there is no distance remaining and no arrival.
            destinationLat = body.shipment.destinationLat,
            destinationLon = body.shipment.destinationLon,
            destinationRadiusM = body.shipment.destinationRadiusM,
        )
        body.reference
    }

    private suspend fun refreshToken(): Boolean {
        val refresh = store.refreshToken() ?: return false
        val deviceId = store.deviceId()
        return runCatching {
            val response = api.refresh(RefreshRequest(refresh, deviceId))
            if (!response.isSuccessful) return@runCatching false
            val body = response.body() ?: return@runCatching false
            store.saveCredentials(
                sessionId = body.sessionId,
                reference = body.reference,
                accessToken = body.accessToken,
                // Refresh token and ingest key are intentionally NOT rotated:
                // rotating mid-shift means a lost response forces a re-claim,
                // and a driver in a dead zone cannot get a new code.
                refreshToken = null,
                ingestKeyB64 = null,
                expiresInSec = body.expiresIn,
                serverTimeSec = body.serverTime,
            )
            store.savePolicy(
                body.policy.pingIntervalSec,
                body.policy.idleIntervalSec,
                body.policy.minDistanceM,
            )
            Log.i(TAG, "Driver token refreshed")
            true
        }.getOrDefault(false)
    }

    suspend fun notifyStop() {
        runCatching { api.stop() }
    }

    // =========================================================================
    // 4. UI / notification snapshot
    // =========================================================================

    /**
     * Facts, not sentences.
     *
     * This used to carry a composed Turkish `title` and `body`, built here —
     * in a class with no Context and therefore no access to string resources,
     * which made the persistent notification the one part of the app that
     * could never be translated. It is also the only place a driver looks for
     * eighteen hours.
     *
     * The service composes the wording now, because the service has resources
     * and knows the remaining distance, which this class does not.
     */
    data class Snapshot(
        val reference: String?,
        val orderNumber: String?,
        val destination: String?,
        val pendingCount: Int,
        val totalCount: Int,
        val lastFixAt: Long,
        val lastSyncAt: Long,
        val online: Boolean,
    )

    suspend fun snapshot(): Snapshot {
        val status = store.status()
        val pending = pointDao.pendingCount()
        val total = pointDao.total()
        val online = network.isOnline()

        return Snapshot(
            reference = status.reference,
            orderNumber = status.orderNumber,
            destination = status.destination,
            pendingCount = pending,
            totalCount = total,
            lastFixAt = status.lastFixAt,
            lastSyncAt = status.lastSyncAt,
            online = online,
        )
    }

    // =========================================================================
    // Helpers
    // =========================================================================

    private fun toDto(e: LocationPointEntity) = LocationPointDto(
        id = e.id,
        recordedAt = e.recordedAt,
        lat = e.lat,
        lon = e.lon,
        accuracy = e.accuracyM,
        altitude = e.altitudeM,
        verticalAccuracy = e.verticalAccuracyM,
        speed = e.speedMps,
        speedAccuracy = e.speedAccuracyMps,
        bearing = e.bearingDeg,
        elapsedRealtimeNs = e.elapsedRealtimeNs,
        batteryPct = e.batteryPct,
        isCharging = e.isCharging,
        isMock = e.isMock,
        satellites = e.satellites,
        provider = e.provider,
        networkType = e.networkType,
        seq = e.deviceSeq,
    )

    /*
     * These take the already-read body rather than the Response, so a caller
     * cannot accidentally consume errorBody() twice. Reading it is the caller's
     * job, exactly once.
     */
    private fun decodeErrorCode(raw: String?): String? = raw?.let {
        runCatching {
            json.decodeFromString<com.karahoca.tracker.data.remote.ApiErrorBody>(it).error?.code
        }.getOrNull()
    }

    private fun decodeErrorMessage(raw: String?): String? = raw?.let {
        runCatching {
            json.decodeFromString<com.karahoca.tracker.data.remote.ApiErrorBody>(it).error?.message
        }.getOrNull()
    }

    @Suppress("DEPRECATION")
    private fun isMockLocation(location: Location): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) location.isMock else location.isFromMockProvider

    private fun batteryPercent(): Int? = runCatching {
        val bm = context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY).takeIf { it in 0..100 }
    }.getOrNull()

    private fun isCharging(): Boolean = runCatching {
        val bm = context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        bm.isCharging
    }.getOrDefault(false)
}
