package com.karahoca.tracker.data.local

import android.content.Context
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.doublePreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.karahoca.tracker.util.Keystore
import dagger.hilt.android.qualifiers.ApplicationContext
import com.karahoca.tracker.util.Destination
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton

private val Context.dataStore by preferencesDataStore(name = "karahoca_session")

/**
 * Persistent tracking state.
 *
 * Everything the foreground service needs to resume after a reboot, an OEM
 * kill, or an app update lives here — because the service is expected to be
 * restarted by a receiver with no Activity, no ViewModel and no memory of what
 * was happening five minutes ago.
 *
 * Tokens and the HMAC key are sealed with a hardware-backed Keystore key
 * ([Keystore]); everything else is plain because none of it is a secret.
 */
@Singleton
class SessionStore @Inject constructor(
    @ApplicationContext private val context: Context,
) {

    private object Keys {
        val DEVICE_ID       = stringPreferencesKey("device_id")
        val SESSION_ID      = stringPreferencesKey("session_id")
        val REFERENCE       = stringPreferencesKey("reference")
        val ACCESS_TOKEN    = stringPreferencesKey("access_token_sealed")
        val REFRESH_TOKEN   = stringPreferencesKey("refresh_token_sealed")
        val INGEST_KEY      = stringPreferencesKey("ingest_key_sealed")
        val TOKEN_EXPIRES   = longPreferencesKey("token_expires_at")

        /** THE flag the whole resurrection chain keys off. */
        val TRACKING_ACTIVE = booleanPreferencesKey("tracking_active")

        val PING_INTERVAL   = longPreferencesKey("ping_interval_ms")
        val IDLE_INTERVAL   = longPreferencesKey("idle_interval_ms")
        val MIN_DISTANCE    = intPreferencesKey("min_distance_m")

        /** serverTimeSec*1000 − localMillis at the last successful call. */
        val CLOCK_OFFSET_MS = longPreferencesKey("clock_offset_ms")

        val DEVICE_SEQ      = longPreferencesKey("device_seq")
        val LAST_SYNC_AT    = longPreferencesKey("last_sync_at")
        val LAST_FIX_AT     = longPreferencesKey("last_fix_at")
        val ORDER_NUMBER    = stringPreferencesKey("order_number")
        val CUSTOMER_NAME   = stringPreferencesKey("customer_name")
        val DESTINATION     = stringPreferencesKey("destination_label")

        /*
         * The delivery point, which the server has always sent and this store
         * has always thrown away.
         *
         * Kept as three keys rather than one encoded string so a partial write
         * cannot produce a coordinate with no radius, and so a schema that
         * gains a field later does not have to parse its own history.
         */
        val DEST_LAT        = doublePreferencesKey("destination_lat")
        val DEST_LON        = doublePreferencesKey("destination_lon")
        val DEST_RADIUS_M   = intPreferencesKey("destination_radius_m")

        /*
         * Whether the driver has already been told they arrived.
         *
         * Persisted rather than held in the service, because the service is
         * restarted by the watchdog, by the OS reclaiming memory, and by the
         * boot receiver — and a driver parked at the gate for three hours of
         * customs would otherwise be told they had arrived once per restart.
         */
        val ARRIVAL_ANNOUNCED = booleanPreferencesKey("arrival_announced")

        /*
         * Straight-line metres left, published for the UI.
         *
         * The service computes this per fix and holds it in memory; only the
         * value the notification actually displays is written here, so a phone
         * driving for eighteen hours does not do four thousand disk writes to
         * move a number the driver is not looking at.
         */
        val REMAINING_M     = doublePreferencesKey("remaining_m")
    }

    // ---------------------------------------------------------------------------
    // Identity
    // ---------------------------------------------------------------------------

    /**
     * Stable per-install id. Generated once and never derived from ANDROID_ID or
     * any hardware identifier — those are restricted on modern Android and would
     * make the app look like a tracker of *people* rather than of trucks.
     */
    suspend fun deviceId(): String {
        val existing = context.dataStore.data.first()[Keys.DEVICE_ID]
        if (existing != null) return existing
        val generated = UUID.randomUUID().toString()
        context.dataStore.edit { it[Keys.DEVICE_ID] = generated }
        return generated
    }

    // ---------------------------------------------------------------------------
    // Credentials
    // ---------------------------------------------------------------------------

    suspend fun saveCredentials(
        sessionId: String,
        reference: String,
        accessToken: String,
        refreshToken: String?,
        ingestKeyB64: String?,
        expiresInSec: Long,
        serverTimeSec: Long,
    ) {
        context.dataStore.edit { prefs ->
            prefs[Keys.SESSION_ID] = sessionId
            prefs[Keys.REFERENCE] = reference
            prefs[Keys.ACCESS_TOKEN] = Keystore.seal(accessToken)
            refreshToken?.let { prefs[Keys.REFRESH_TOKEN] = Keystore.seal(it) }
            ingestKeyB64?.let { prefs[Keys.INGEST_KEY] = Keystore.seal(it) }
            prefs[Keys.TOKEN_EXPIRES] = System.currentTimeMillis() + expiresInSec * 1000
            prefs[Keys.CLOCK_OFFSET_MS] = serverTimeSec * 1000 - System.currentTimeMillis()
        }
    }

    suspend fun sessionId(): String? = context.dataStore.data.first()[Keys.SESSION_ID]
    suspend fun reference(): String? = context.dataStore.data.first()[Keys.REFERENCE]
    suspend fun accessToken(): String? = Keystore.open(context.dataStore.data.first()[Keys.ACCESS_TOKEN])
    suspend fun refreshToken(): String? = Keystore.open(context.dataStore.data.first()[Keys.REFRESH_TOKEN])
    suspend fun ingestKey(): ByteArray? =
        Keystore.open(context.dataStore.data.first()[Keys.INGEST_KEY])
            ?.let { android.util.Base64.decode(it, android.util.Base64.NO_WRAP) }

    /** True when the token expires within two minutes — refresh proactively. */
    suspend fun tokenNeedsRefresh(): Boolean {
        val expiry = context.dataStore.data.first()[Keys.TOKEN_EXPIRES] ?: return true
        return System.currentTimeMillis() > expiry - 120_000
    }

    // ---------------------------------------------------------------------------
    // Clock discipline (ADR-011)
    // ---------------------------------------------------------------------------

    /**
     * The HMAC timestamp uses the wall clock, and cheap phones drift or get set
     * wrong by drivers. Every server response carries `serverTime`; we store the
     * delta and sign with the corrected value, so a phone two hours off still
     * authenticates.
     */
    suspend fun recordServerTime(serverTimeSec: Long) {
        context.dataStore.edit {
            it[Keys.CLOCK_OFFSET_MS] = serverTimeSec * 1000 - System.currentTimeMillis()
        }
    }

    suspend fun correctedNowMs(): Long =
        System.currentTimeMillis() + (context.dataStore.data.first()[Keys.CLOCK_OFFSET_MS] ?: 0L)

    // ---------------------------------------------------------------------------
    // Tracking state
    // ---------------------------------------------------------------------------

    suspend fun setTrackingActive(active: Boolean) {
        context.dataStore.edit { it[Keys.TRACKING_ACTIVE] = active }
    }

    suspend fun isTrackingActive(): Boolean =
        context.dataStore.data.first()[Keys.TRACKING_ACTIVE] ?: false

    val trackingActiveFlow: Flow<Boolean> =
        context.dataStore.data.map { it[Keys.TRACKING_ACTIVE] ?: false }

    suspend fun savePolicy(pingIntervalSec: Int, idleIntervalSec: Int, minDistanceM: Int) {
        context.dataStore.edit {
            it[Keys.PING_INTERVAL] = pingIntervalSec * 1000L
            it[Keys.IDLE_INTERVAL] = idleIntervalSec * 1000L
            it[Keys.MIN_DISTANCE] = minDistanceM
        }
    }

    suspend fun policy(): TrackingPolicy {
        val prefs = context.dataStore.data.first()
        return TrackingPolicy(
            pingIntervalMs = prefs[Keys.PING_INTERVAL] ?: 10_000L,
            idleIntervalMs = prefs[Keys.IDLE_INTERVAL] ?: 60_000L,
            minDistanceM = prefs[Keys.MIN_DISTANCE] ?: 0,
        )
    }

    /**
     * Everything about the load, including where it is going.
     *
     * The coordinate is written unconditionally rather than through the
     * `?.let` the string fields use, because null here is meaningful: an order
     * whose destination was removed must clear the stored one, or the app would
     * keep announcing arrival at a warehouse that is no longer the delivery
     * point.
     */
    suspend fun saveShipment(
        orderNumber: String?,
        customerName: String?,
        destination: String?,
        destinationLat: Double? = null,
        destinationLon: Double? = null,
        destinationRadiusM: Int? = null,
    ) {
        context.dataStore.edit {
            orderNumber?.let { v -> it[Keys.ORDER_NUMBER] = v }
            customerName?.let { v -> it[Keys.CUSTOMER_NAME] = v }
            destination?.let { v -> it[Keys.DESTINATION] = v }

            if (destinationLat != null && destinationLon != null) {
                it[Keys.DEST_LAT] = destinationLat
                it[Keys.DEST_LON] = destinationLon
                destinationRadiusM?.let { r -> it[Keys.DEST_RADIUS_M] = r }
            } else {
                it.remove(Keys.DEST_LAT)
                it.remove(Keys.DEST_LON)
                it.remove(Keys.DEST_RADIUS_M)
            }
        }
    }

    /**
     * The delivery point, or null when the order has none.
     *
     * Three orders in four in production have no destination, so null is the
     * ordinary case: the screen says nothing about distance rather than showing
     * a number it cannot stand behind.
     */
    suspend fun setRemainingM(metres: Double?) {
        context.dataStore.edit {
            if (metres == null) it.remove(Keys.REMAINING_M) else it[Keys.REMAINING_M] = metres
        }
    }

    suspend fun arrivalAnnounced(): Boolean =
        context.dataStore.data.first()[Keys.ARRIVAL_ANNOUNCED] ?: false

    suspend fun setArrivalAnnounced(value: Boolean) {
        context.dataStore.edit { it[Keys.ARRIVAL_ANNOUNCED] = value }
    }

    suspend fun destination(): Destination? {
        val prefs = context.dataStore.data.first()
        return Destination.of(
            lat = prefs[Keys.DEST_LAT],
            lon = prefs[Keys.DEST_LON],
            radiusM = prefs[Keys.DEST_RADIUS_M],
            label = prefs[Keys.DESTINATION],
        )
    }

    suspend fun shipment(): Triple<String?, String?, String?> {
        val prefs = context.dataStore.data.first()
        return Triple(prefs[Keys.ORDER_NUMBER], prefs[Keys.CUSTOMER_NAME], prefs[Keys.DESTINATION])
    }

    /**
     * Last persisted device sequence number.
     *
     * The counter itself lives in memory in TrackingRepository and is flushed
     * here only occasionally. It used to be incremented with a DataStore
     * `edit{}` on every fix, and DataStore Preferences has no partial write:
     * each edit re-serialises the whole preferences map (18 keys, including
     * three Keystore-sealed blobs), writes a scratch file, fsyncs it and
     * renames. That was ~10,000 full rewrites per shift to maintain one
     * integer — on a third-party driver's personal flash.
     *
     * Note the inconsistency it created: TrackerDatabase deliberately runs
     * synchronous=NORMAL to avoid fsyncing on every Room commit, and then this
     * fsynced twice per fix on the same code path.
     */
    suspend fun deviceSeq(): Long = context.dataStore.data.first()[Keys.DEVICE_SEQ] ?: 0L

    suspend fun saveDeviceSeq(value: Long) {
        context.dataStore.edit { it[Keys.DEVICE_SEQ] = value }
    }

    suspend fun markSynced() {
        context.dataStore.edit { it[Keys.LAST_SYNC_AT] = System.currentTimeMillis() }
    }

    suspend fun markFix(atMs: Long) {
        context.dataStore.edit { it[Keys.LAST_FIX_AT] = atMs }
    }

    val statusFlow: Flow<StoredStatus> = context.dataStore.data.map(::toStatus)

    suspend fun status(): StoredStatus = toStatus(context.dataStore.data.first())

    private fun toStatus(prefs: Preferences) = StoredStatus(
        sessionId = prefs[Keys.SESSION_ID],
        reference = prefs[Keys.REFERENCE],
        trackingActive = prefs[Keys.TRACKING_ACTIVE] ?: false,
        lastSyncAt = prefs[Keys.LAST_SYNC_AT] ?: 0,
        lastFixAt = prefs[Keys.LAST_FIX_AT] ?: 0,
        orderNumber = prefs[Keys.ORDER_NUMBER],
        customerName = prefs[Keys.CUSTOMER_NAME],
        destination = prefs[Keys.DESTINATION],
        remainingM = prefs[Keys.REMAINING_M],
        arrived = prefs[Keys.ARRIVAL_ANNOUNCED] ?: false,
        destinationPoint = Destination.of(
            lat = prefs[Keys.DEST_LAT],
            lon = prefs[Keys.DEST_LON],
            radiusM = prefs[Keys.DEST_RADIUS_M],
            label = prefs[Keys.DESTINATION],
        ),
        clockOffsetMs = prefs[Keys.CLOCK_OFFSET_MS] ?: 0,
    )

    /**
     * Wipe credentials at session end.
     *
     * Deliberately keeps DEVICE_ID (so re-claiming the same phone is recognised)
     * and never touches the Room buffer — unsynced points from the session that
     * just ended must still be uploaded.
     */
    suspend fun clearSession() {
        context.dataStore.edit { prefs ->
            listOf(
                Keys.SESSION_ID, Keys.REFERENCE, Keys.ACCESS_TOKEN, Keys.REFRESH_TOKEN,
                Keys.INGEST_KEY, Keys.TOKEN_EXPIRES, Keys.ORDER_NUMBER,
                Keys.CUSTOMER_NAME, Keys.DESTINATION,
                Keys.DEST_LAT, Keys.DEST_LON, Keys.DEST_RADIUS_M,
                Keys.ARRIVAL_ANNOUNCED, Keys.REMAINING_M,
            ).forEach { prefs.remove(it) }
            prefs[Keys.TRACKING_ACTIVE] = false
        }
    }
}

data class TrackingPolicy(
    val pingIntervalMs: Long,
    val idleIntervalMs: Long,
    val minDistanceM: Int,
)

data class StoredStatus(
    val sessionId: String?,
    val reference: String?,
    val trackingActive: Boolean,
    val lastSyncAt: Long,
    val lastFixAt: Long,
    val orderNumber: String?,
    val customerName: String?,
    val destination: String?,
    /** Where the load is going, or null when the order carries no coordinate. */
    val destinationPoint: Destination? = null,
    /** Straight-line metres left, or null before the first fix. */
    val remainingM: Double? = null,
    /** Whether the driver has been told they reached the delivery point. */
    val arrived: Boolean = false,
    val clockOffsetMs: Long,
)
