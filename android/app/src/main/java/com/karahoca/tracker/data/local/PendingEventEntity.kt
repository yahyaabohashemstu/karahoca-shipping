package com.karahoca.tracker.data.local

import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.PrimaryKey
import androidx.room.Query

/**
 * Lifecycle and diagnostic events, buffered exactly like location points.
 *
 * SERVICE_KILLED is the reason this table exists: the event that explains a gap
 * is generated *while offline*, at the same moment the gap starts. If events
 * were fire-and-forget HTTP calls, the one message that tells a dispatcher
 * "the OEM killed my service at 14:02" would be the one message that never
 * arrives.
 */
@Entity(tableName = "pending_events")
data class PendingEventEntity(
    @PrimaryKey(autoGenerate = true)
    val id: Long = 0,

    @ColumnInfo(name = "session_id") val sessionId: String,
    @ColumnInfo(name = "type")       val type: String,
    @ColumnInfo(name = "occurred_at") val occurredAt: Long,
    @ColumnInfo(name = "message")    val message: String?,
    /** JSON blob, passed through to kh.session_events.payload. */
    @ColumnInfo(name = "payload")    val payload: String?,
    @ColumnInfo(name = "attempts", defaultValue = "0") val attempts: Int = 0,
)

@Dao
interface PendingEventDao {

    @Insert
    suspend fun insert(event: PendingEventEntity): Long

    @Query("SELECT * FROM pending_events ORDER BY occurred_at ASC LIMIT :limit")
    suspend fun oldest(limit: Int): List<PendingEventEntity>

    @Query("DELETE FROM pending_events WHERE id = :id")
    suspend fun delete(id: Long)

    @Query("UPDATE pending_events SET attempts = attempts + 1 WHERE id = :id")
    suspend fun markAttempt(id: Long)

    /**
     * Give up after 20 tries. An event that cannot be delivered in 20 attempts
     * across a shift is a poison message; keeping it would block the queue
     * behind it forever.
     */
    @Query("DELETE FROM pending_events WHERE attempts >= 20")
    suspend fun dropPoisoned(): Int

    @Query("SELECT COUNT(*) FROM pending_events")
    suspend fun count(): Int
}
