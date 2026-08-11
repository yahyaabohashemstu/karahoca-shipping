package com.karahoca.tracker.data.local

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import com.karahoca.tracker.data.local.LocationPointEntity.Companion.SYNC_IN_FLIGHT
import com.karahoca.tracker.data.local.LocationPointEntity.Companion.SYNC_PENDING
import kotlinx.coroutines.flow.Flow

/**
 * The buffer's entire API.
 *
 * The claim/ack protocol below is what makes offline sync crash-safe:
 *
 *   claimBatch(batchId, n)   PENDING → IN_FLIGHT, stamped with batchId
 *   getBatch(batchId)        read exactly those rows
 *   ── upload ──
 *   deleteBatch(batchId)     only on a 2xx acknowledgement
 *   releaseBatch(batchId)    on any failure: IN_FLIGHT → PENDING, attempts++
 *   resetStaleInFlight()     on startup: recover rows orphaned by a process kill
 *
 * Nothing is ever deleted on a timeout, a 5xx, or a socket error.
 */
@Dao
interface LocationPointDao {

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insert(point: LocationPointEntity)

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertAll(points: List<LocationPointEntity>)

    // ---- Counters shown in the notification and the UI ----------------------

    @Query("SELECT COUNT(*) FROM location_points")
    suspend fun total(): Int

    @Query("SELECT COUNT(*) FROM location_points WHERE sync_state = $SYNC_PENDING")
    suspend fun pendingCount(): Int

    @Query("SELECT COUNT(*) FROM location_points")
    fun observeTotal(): Flow<Int>

    @Query("SELECT COUNT(*) FROM location_points WHERE session_id = :sessionId")
    suspend fun countForSession(sessionId: String): Int

    @Query("SELECT MIN(recorded_at) FROM location_points WHERE sync_state = $SYNC_PENDING")
    suspend fun oldestPendingAt(): Long?

    @Query("SELECT MAX(device_seq) FROM location_points")
    suspend fun maxDeviceSeq(): Long?

    @Query("SELECT * FROM location_points ORDER BY recorded_at DESC LIMIT 1")
    suspend fun latest(): LocationPointEntity?

    // ---- Claim / acknowledge protocol ---------------------------------------

    /**
     * Atomically move up to [limit] oldest PENDING rows into IN_FLIGHT under
     * [batchId]. Returns how many were claimed.
     *
     * Oldest-first is deliberate: after a dead zone the dispatcher's map fills
     * in chronologically, and one poisoned chunk cannot block the newer ones.
     */
    @Query(
        """
        UPDATE location_points
        SET sync_state = $SYNC_IN_FLIGHT,
            batch_id   = :batchId,
            claimed_at = :now
        WHERE id IN (
            SELECT id FROM location_points
            WHERE sync_state = $SYNC_PENDING
            ORDER BY recorded_at ASC
            LIMIT :limit
        )
        """,
    )
    suspend fun claimBatch(batchId: String, limit: Int, now: Long): Int

    @Query("SELECT * FROM location_points WHERE batch_id = :batchId ORDER BY recorded_at ASC")
    suspend fun getBatch(batchId: String): List<LocationPointEntity>

    /** Called ONLY after the server acknowledges the batch. */
    @Query("DELETE FROM location_points WHERE batch_id = :batchId")
    suspend fun deleteBatch(batchId: String): Int

    /** Any failure: hand the rows back to the queue and remember the attempt. */
    @Query(
        """
        UPDATE location_points
        SET sync_state = $SYNC_PENDING,
            batch_id   = NULL,
            claimed_at = 0,
            attempts   = attempts + 1
        WHERE batch_id = :batchId
        """,
    )
    suspend fun releaseBatch(batchId: String): Int

    /**
     * Recover rows whose uploader was killed (OOM, force-stop, reboot).
     *
     * Without this, a single process death during an upload would strand those
     * points in IN_FLIGHT forever — silently losing exactly the data the buffer
     * exists to protect.
     */
    @Query(
        """
        UPDATE location_points
        SET sync_state = $SYNC_PENDING,
            batch_id   = NULL,
            claimed_at = 0,
            attempts   = attempts + 1
        WHERE sync_state = $SYNC_IN_FLIGHT
          AND claimed_at < :staleBefore
        """,
    )
    suspend fun resetStaleInFlight(staleBefore: Long): Int

    // ---- Capacity management ------------------------------------------------

    /**
     * Bounded ring buffer. At the cap we drop the OLDEST points, because a
     * dispatcher hunting a truck right now needs the newest fixes; the caller
     * logs a BUFFER_OVERFLOW event so the loss is visible, never silent.
     */
    @Query(
        """
        DELETE FROM location_points
        WHERE id IN (
            SELECT id FROM location_points
            WHERE sync_state = $SYNC_PENDING
            ORDER BY recorded_at ASC
            LIMIT :count
        )
        """,
    )
    suspend fun evictOldest(count: Int): Int

    @Transaction
    suspend fun insertWithCap(point: LocationPointEntity, maxRows: Int): Int {
        insert(point)
        val overflow = total() - maxRows
        return if (overflow > 0) evictOldest(overflow) else 0
    }

    /** Session ended and fully synced — drop anything left over. */
    @Query("DELETE FROM location_points WHERE session_id = :sessionId")
    suspend fun deleteSession(sessionId: String): Int

    @Query("DELETE FROM location_points")
    suspend fun clear()
}
