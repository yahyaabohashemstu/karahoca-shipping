package com.karahoca.tracker.data.local

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/**
 * One buffered GPS fix.
 *
 * This table is the contract behind "the app must never lose a coordinate".
 * The location callback writes here and returns; nothing about acquisition
 * depends on the network being up (ADR-010).
 *
 * `id` is a client-generated ULID and doubles as the server-side idempotency
 * key, so re-uploading a batch whose acknowledgement was lost is a no-op
 * (`ON CONFLICT DO NOTHING` on the hypertable's primary key).
 */
@Entity(
    tableName = "location_points",
    indices = [
        // The sync worker's only query: oldest pending points first.
        Index(value = ["sync_state", "recorded_at"]),
        // Releasing / deleting a claimed batch.
        Index(value = ["batch_id"]),
    ],
)
data class LocationPointEntity(
    @PrimaryKey
    @ColumnInfo(name = "id")
    val id: String,

    @ColumnInfo(name = "session_id")
    val sessionId: String,

    /**
     * GPS-derived UTC from `Location.getTime()`.
     *
     * NOT `System.currentTimeMillis()`: a driver changing the phone clock or
     * timezone mid-shift must not corrupt the route. GNSS fixes carry satellite
     * time (ADR-011).
     */
    @ColumnInfo(name = "recorded_at")
    val recordedAt: Long,

    /** Monotonic since boot. Survives every wall-clock change; used for ordering. */
    @ColumnInfo(name = "elapsed_realtime_ns")
    val elapsedRealtimeNs: Long,

    @ColumnInfo(name = "lat") val lat: Double,
    @ColumnInfo(name = "lon") val lon: Double,

    @ColumnInfo(name = "accuracy_m")          val accuracyM: Float?,
    @ColumnInfo(name = "altitude_m")          val altitudeM: Double?,
    @ColumnInfo(name = "vertical_accuracy_m") val verticalAccuracyM: Float?,
    @ColumnInfo(name = "speed_mps")           val speedMps: Float?,
    @ColumnInfo(name = "speed_accuracy_mps")  val speedAccuracyMps: Float?,
    @ColumnInfo(name = "bearing_deg")         val bearingDeg: Float?,
    @ColumnInfo(name = "satellites")          val satellites: Int?,
    @ColumnInfo(name = "provider")            val provider: String?,

    /** Battery telemetry: the dispatcher's early warning that a truck is about to go dark. */
    @ColumnInfo(name = "battery_pct")  val batteryPct: Int?,
    @ColumnInfo(name = "is_charging")  val isCharging: Boolean,

    /** Recorded, never dropped — a spoofed route is evidence, not noise. */
    @ColumnInfo(name = "is_mock")      val isMock: Boolean,

    @ColumnInfo(name = "network_type") val networkType: String?,

    /** Monotonic per-install counter. Detects silent gaps the server cannot infer. */
    @ColumnInfo(name = "device_seq")   val deviceSeq: Long,

    // ---- Sync bookkeeping ---------------------------------------------------

    @ColumnInfo(name = "sync_state", defaultValue = "0")
    val syncState: Int = SYNC_PENDING,

    /** Set while a row is claimed by an in-flight upload. */
    @ColumnInfo(name = "batch_id")
    val batchId: String? = null,

    @ColumnInfo(name = "claimed_at", defaultValue = "0")
    val claimedAt: Long = 0,

    @ColumnInfo(name = "attempts", defaultValue = "0")
    val attempts: Int = 0,

    @ColumnInfo(name = "created_at")
    val createdAt: Long = System.currentTimeMillis(),
) {
    companion object {
        const val SYNC_PENDING = 0

        /**
         * Claimed by an upload that has not been acknowledged.
         *
         * Rows are deleted only on a 2xx that names their batch. If the process
         * dies mid-POST they stay IN_FLIGHT and are reclaimed by
         * `resetStaleInFlight` on the next run — so the worst case is a
         * duplicate upload, which the server deduplicates, never a lost point.
         */
        const val SYNC_IN_FLIGHT = 1
    }
}
