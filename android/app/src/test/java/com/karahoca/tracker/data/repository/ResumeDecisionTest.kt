package com.karahoca.tracker.data.repository

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The only way back from an accidental stop, and the ways it must not fire.
 *
 * A driver who taps Stop by mistake cannot recover on their own: the flag is
 * cleared, the watchdog is cancelled, and none of the six mechanisms that
 * resurrect a *killed* service apply, because from the inside a stop is
 * indistinguishable from a driver who meant it. So the correction comes from
 * the dashboard, and the phone picks it up here.
 *
 * Which makes the guards the whole safety story. This turns tracking back ON
 * without asking anybody, so every clause below is protecting a driver from the
 * dispatcher's stale view of their shipment — or from their own dropped
 * request.
 */
class ResumeDecisionTest {

    @Test
    fun `resumes only when every local condition holds`() {
        assertTrue(
            shouldAskAboutResume(
                hasSession = true,
                locallyTracking = false,
                ourStopWasAcknowledged = true,
            ),
        )
    }

    @Test
    fun `never asks before a code has been claimed`() {
        assertFalse(
            shouldAskAboutResume(
                hasSession = false,
                locallyTracking = false,
                ourStopWasAcknowledged = true,
            ),
        )
    }

    /**
     * This path turns tracking on. It must never be able to turn it off.
     *
     * A dispatcher reading a stale row, or a session parked server-side while
     * the phone is genuinely still sending, must not be able to reach in and
     * stop a shipment that is running.
     */
    @Test
    fun `does nothing while tracking is already running`() {
        assertFalse(
            shouldAskAboutResume(
                hasSession = true,
                locallyTracking = true,
                ourStopWasAcknowledged = true,
            ),
        )
    }

    /**
     * The clause that is easiest to delete and worst to lose.
     *
     * A driver who pressed Stop inside a tunnel had the POST fail, so the server
     * still reads ACTIVE. Without this guard the phone would see ACTIVE on the
     * next check and restart tracking against the driver's explicit decision —
     * and it would keep doing it, every fifteen minutes, for the rest of the
     * shift.
     */
    @Test
    fun `does not resume when our own stop never reached the server`() {
        assertFalse(
            shouldAskAboutResume(
                hasSession = true,
                locallyTracking = false,
                ourStopWasAcknowledged = false,
            ),
        )
    }

    @Test
    fun `only an ACTIVE session is worth resuming into`() {
        assertTrue(remoteWantsTracking("ACTIVE"))

        // Every one of these is "not PAUSED", and every one of them means the
        // shipment is over. Resuming would start a foreground service whose
        // very first upload the server would reject.
        for (status in listOf("PAUSED", "COMPLETED", "CANCELLED", "EXPIRED", "REVOKED", "DRAFT")) {
            assertFalse(status, remoteWantsTracking(status))
        }
        assertFalse("a body we could not read is not permission to act", remoteWantsTracking(null))
    }
}
