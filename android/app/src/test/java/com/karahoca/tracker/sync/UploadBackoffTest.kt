package com.karahoca.tracker.sync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure JVM — no Robolectric, no Android, no clock.
 *
 * The behaviour under test is the one that costs battery when it is wrong: how
 * long a truck waits before hitting a server that has already refused it.
 */
class UploadBackoffTest {

    private var now = 0L
    private fun backoff(jitter: Double = 0.0) = UploadBackoff(
        baseMs = 15_000L,
        capMs = 5 * 60 * 1000L,
        clock = { now },
        random = { jitter },
    )

    @Test
    fun `a fresh backoff never waits`() {
        assertFalse(backoff().shouldWait())
        assertEquals(0L, backoff().remainingMs())
    }

    @Test
    fun `the first failure waits exactly one pump tick`() {
        val b = backoff()
        b.onFailure()
        // 15s is one tick of the realtime pump: a single dropped packet must not
        // delay a moving truck by more than the interval it was already waiting.
        assertEquals(15_000L, b.remainingMs())
        assertTrue(b.shouldWait())
    }

    @Test
    fun `consecutive failures double the wait`() {
        val b = backoff()
        val waits = (1..5).map {
            b.onFailure()
            b.remainingMs()
        }
        assertEquals(listOf(15_000L, 30_000L, 60_000L, 120_000L, 240_000L), waits)
    }

    @Test
    fun `the wait is capped`() {
        val b = backoff()
        repeat(40) { b.onFailure() }
        assertEquals(300_000L, b.remainingMs())
    }

    @Test
    fun `the shift cannot overflow into a cleared backoff`() {
        // 1L shl 64 wraps to 1 and 1L shl 63 is negative; either would silently
        // remove the backoff after enough failures, which is the exact opposite
        // of what a long outage should produce.
        val b = backoff()
        repeat(200) { b.onFailure() }
        assertTrue("wait must stay positive after 200 failures", b.remainingMs() > 0)
        assertEquals(300_000L, b.remainingMs())
    }

    @Test
    fun `time passing clears the wait`() {
        val b = backoff()
        b.onFailure()
        now += 14_999
        assertTrue(b.shouldWait())
        now += 2
        assertFalse(b.shouldWait())
        assertEquals(0L, b.remainingMs())
    }

    @Test
    fun `a success clears the wait and resets the ladder`() {
        val b = backoff()
        repeat(4) { b.onFailure() }
        b.onSuccess()
        assertFalse(b.shouldWait())
        assertEquals(0, b.failureCount)

        // And the next failure starts from the bottom again, not from where the
        // previous run left off.
        b.onFailure()
        assertEquals(15_000L, b.remainingMs())
    }

    @Test
    fun `the server's retryAfter overrides the local ladder`() {
        val b = backoff()
        b.onFailure()
        b.onFailure()
        // The local ladder would say 30s here; the server said 56.
        b.onFailure(retryAfterSec = 56)
        assertEquals(56_000L, b.remainingMs())
    }

    @Test
    fun `a shorter retryAfter is still honoured over a longer local wait`() {
        val b = backoff()
        repeat(6) { b.onFailure() }
        assertEquals(300_000L, b.remainingMs())
        // Trusting the server downward matters too: it knows when its own
        // window resets, and waiting five minutes when it said two is five
        // minutes of a truck being invisible for no reason.
        b.onFailure(retryAfterSec = 120)
        assertEquals(120_000L, b.remainingMs())
    }

    @Test
    fun `a nonsense retryAfter falls back to the ladder`() {
        val b = backoff()
        b.onFailure(retryAfterSec = 0)
        assertEquals(15_000L, b.remainingMs())
        b.onSuccess()
        b.onFailure(retryAfterSec = -30)
        assertEquals(15_000L, b.remainingMs())
    }

    @Test
    fun `jitter only ever extends the wait`() {
        // Never negative: waiting less than the server asked for is the one
        // direction that must not happen.
        val full = UploadBackoff(15_000L, 300_000L, { now }, { 1.0 })
        full.onFailure()
        assertEquals(18_000L, full.remainingMs())

        val none = UploadBackoff(15_000L, 300_000L, { now }, { 0.0 })
        none.onFailure()
        assertEquals(15_000L, none.remainingMs())
    }

    @Test
    fun `jitter spreads a fleet that failed together`() {
        // Forty trucks hitting the same 429 in the same second must not retry in
        // the same second, or they reconstruct the burst that caused the limit.
        val waits = (0 until 40).map { i ->
            val b = UploadBackoff(15_000L, 300_000L, { now }, { i / 40.0 })
            b.onFailure(retryAfterSec = 60)
            b.remainingMs()
        }
        assertEquals(60_000L, waits.min())
        assertTrue("spread must be meaningful", waits.max() - waits.min() >= 11_000)
        assertTrue("distinct wake-up times", waits.toSet().size > 30)
    }
}
