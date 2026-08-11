package com.karahoca.tracker.data.local

import androidx.test.core.app.ApplicationProvider
import com.karahoca.tracker.data.local.LocationPointEntity.Companion.SYNC_IN_FLIGHT
import com.karahoca.tracker.data.local.LocationPointEntity.Companion.SYNC_PENDING
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * Opens the REAL database, through the real [TrackerDatabase.build], on a real
 * SQLite — on the JVM, with no device.
 *
 * This exists because of a shipped bug: `onOpen` ran
 * `execSQL("PRAGMA busy_timeout = 5000")`, and that pragma returns a row even
 * when it is being SET, so execSQL threw on every database open on every
 * device. The buffer — the component the entire offline design rests on —
 * could never be created, and the app died two seconds after launch.
 *
 * Nothing caught it because nothing had ever opened the database outside a
 * phone. Everything below runs in about a second in CI.
 */
@RunWith(RobolectricTestRunner::class)
class TrackerDatabaseTest {

    private lateinit var db: TrackerDatabase
    private lateinit var dao: LocationPointDao
    private lateinit var events: PendingEventDao

    @Before
    fun setUp() {
        // Deliberately the production builder, not an in-memory one: the
        // addCallback/onOpen pragmas are exactly what regressed.
        db = TrackerDatabase.build(ApplicationProvider.getApplicationContext())
        dao = db.locationPointDao()
        events = db.pendingEventDao()
    }

    @After
    fun tearDown() = db.close()

    private fun point(id: String, at: Long, state: Int = SYNC_PENDING) = LocationPointEntity(
        id = id,
        sessionId = "11111111-2222-3333-4444-555555555555",
        recordedAt = at,
        elapsedRealtimeNs = at * 1_000_000,
        lat = 40.7654,
        lon = 29.9187,
        accuracyM = 6f,
        altitudeM = 112.0,
        verticalAccuracyM = 3f,
        speedMps = 18f,
        speedAccuracyMps = 1f,
        bearingDeg = 143f,
        satellites = 11,
        provider = "fused",
        batteryPct = 74,
        isCharging = true,
        isMock = false,
        networkType = "cellular",
        deviceSeq = at,
        syncState = state,
    )

    @Test
    fun `database opens and the tuning pragmas do not throw`() = runTest {
        // Any query forces the open + onOpen callback. Before the fix this
        // threw SQLiteException("Queries can be performed using ...").
        assertEquals(0, dao.total())
        assertEquals(0, dao.pendingCount())
    }

    @Test
    fun `write ahead logging is actually enabled`() {
        db.openHelper.readableDatabase.query("PRAGMA journal_mode").use {
            assertTrue(it.moveToFirst())
            assertEquals("wal", it.getString(0).lowercase())
        }
    }

    @Test
    fun `claim, acknowledge and delete is the only path that removes a point`() = runTest {
        repeat(5) { dao.insert(point("01JT${it}AAAAAAAAAAAAAAAAAAAAA", 1_000L + it)) }
        assertEquals(5, dao.pendingCount())

        val batch = "batch-1"
        assertEquals(3, dao.claimBatch(batch, limit = 3, now = 9_000L))
        assertEquals(2, dao.pendingCount())
        assertEquals(3, dao.getBatch(batch).size)

        // Claimed rows are still present — an unacknowledged upload must never
        // lose them.
        assertEquals(5, dao.total())

        assertEquals(3, dao.deleteBatch(batch))
        assertEquals(2, dao.total())
    }

    @Test
    fun `a failed upload returns its rows to the queue and counts the attempt`() = runTest {
        dao.insert(point("01JTRELEASEAAAAAAAAAAAAAAA", 1_000L))
        val batch = "batch-2"
        dao.claimBatch(batch, 10, 9_000L)
        assertEquals(0, dao.pendingCount())

        assertEquals(1, dao.releaseBatch(batch))
        assertEquals(1, dao.pendingCount())

        // The claim is fully undone: batch_id is cleared, so the row no longer
        // belongs to the dead batch and cannot be double-deleted by a late ack.
        assertTrue("released rows must not still carry the batch id", dao.getBatch(batch).isEmpty())

        // …and the attempt is remembered, which is what drives backoff and the
        // poison-message detection.
        val row = dao.latest()!!
        assertEquals(SYNC_PENDING, row.syncState)
        assertEquals(1, row.attempts)
        assertEquals(null, row.batchId)
    }

    @Test
    fun `rows orphaned by a process kill are reclaimed, never lost`() = runTest {
        dao.insert(point("01JTORPHANAAAAAAAAAAAAAAAA", 1_000L))
        dao.claimBatch("dead-batch", 10, now = 1_000L)
        assertEquals(0, dao.pendingCount())

        // Simulates the next run: anything claimed longer ago than the stale
        // window belonged to a process that died mid-upload.
        assertEquals(1, dao.resetStaleInFlight(staleBefore = 500_000L))
        assertEquals(1, dao.pendingCount())
    }

    @Test
    fun `oldest points are claimed first so a dead zone backfills chronologically`() = runTest {
        dao.insert(point("01JTNEWAAAAAAAAAAAAAAAAAAA", 9_000L))
        dao.insert(point("01JTOLDAAAAAAAAAAAAAAAAAAA", 1_000L))
        dao.insert(point("01JTMIDAAAAAAAAAAAAAAAAAAA", 5_000L))

        dao.claimBatch("ordered", limit = 2, now = 10_000L)
        val claimed = dao.getBatch("ordered").map { it.recordedAt }
        assertEquals(listOf(1_000L, 5_000L), claimed)
    }

    @Test
    fun `the buffer is a bounded ring that evicts the oldest`() = runTest {
        repeat(6) { dao.insert(point("01JTCAP${it}AAAAAAAAAAAAAAAA", 1_000L + it)) }
        val evicted = dao.insertWithCap(point("01JTCAPNEWAAAAAAAAAAAAAAAA", 9_999L), maxRows = 4)

        assertEquals(3, evicted)
        assertEquals(4, dao.total())
        // The newest survived; the oldest went.
        assertNotNull(dao.latest())
        assertEquals(9_999L, dao.latest()!!.recordedAt)
    }

    @Test
    fun `duplicate ids are ignored rather than throwing`() = runTest {
        val p = point("01JTDUPEAAAAAAAAAAAAAAAAAA", 1_000L)
        dao.insert(p)
        dao.insert(p)
        assertEquals(1, dao.total())
    }

    @Test
    fun `maxDeviceSeq reseeds the counter after a restart`() = runTest {
        dao.insert(point("01JTSEQ1AAAAAAAAAAAAAAAAAA", 1_000L))
        dao.insert(point("01JTSEQ2AAAAAAAAAAAAAAAAAA", 7_000L))
        assertEquals(7_000L, dao.maxDeviceSeq())
    }

    @Test
    fun `events queue survives and drops poison messages`() = runTest {
        events.insert(
            PendingEventEntity(
                sessionId = "s", type = "SERVICE_KILLED",
                occurredAt = 1_000L, message = "test", payload = null, attempts = 25,
            ),
        )
        events.insert(
            PendingEventEntity(
                sessionId = "s", type = "STARTED",
                occurredAt = 2_000L, message = null, payload = null,
            ),
        )
        assertEquals(2, events.count())
        assertEquals(1, events.dropPoisoned())
        assertEquals(1, events.count())
        assertEquals("STARTED", events.oldest(10).single().type)
    }

    @Test
    fun `in-flight rows are excluded from the pending count`() = runTest {
        dao.insert(point("01JTSTATE1AAAAAAAAAAAAAAAA", 1_000L, SYNC_PENDING))
        dao.insert(point("01JTSTATE2AAAAAAAAAAAAAAAA", 2_000L, SYNC_IN_FLIGHT))
        assertEquals(2, dao.total())
        assertEquals(1, dao.pendingCount())
        assertEquals(1_000L, dao.oldestPendingAt())
    }
}
