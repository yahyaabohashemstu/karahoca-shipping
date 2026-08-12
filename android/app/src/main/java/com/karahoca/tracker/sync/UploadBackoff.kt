package com.karahoca.tracker.sync

/**
 * When the next upload attempt is allowed.
 *
 * Extracted from [com.karahoca.tracker.data.repository.TrackingRepository] as
 * plain arithmetic with an injectable clock, because the repository takes ten
 * constructor dependencies and none of them are needed to answer "how long
 * should we wait". This is the part with the off-by-one risks, so it is the
 * part that gets tested.
 *
 * THE PROBLEM IT SOLVES. The service's realtime pump fires every 15 seconds and
 * used to attempt an upload on every tick regardless of how the previous one
 * had failed. A server returning 429 or 503 therefore received 240 requests an
 * hour from every truck in the fleet, each one dragging the modem out of
 * RRC_IDLE and back through the tail timer for nothing — worst precisely when
 * the server is already struggling.
 *
 * Not thread-safe by construction; the caller holds the upload mutex.
 */
class UploadBackoff(
    private val baseMs: Long = 15_000L,
    private val capMs: Long = 5 * 60 * 1000L,
    /**
     * elapsedRealtime, never wall clock. An NTP correction mid-shift must not
     * skip a backoff or extend it by hours.
     */
    private val clock: () -> Long,
    /** 0..1. Injectable so tests are deterministic. */
    private val random: () -> Double = Math::random,
) {
    private var untilMs = 0L
    private var failures = 0

    /** Consecutive failures since the last success. Exposed for logging. */
    val failureCount: Int get() = failures

    /** True when an attempt should be skipped without touching the radio. */
    fun shouldWait(): Boolean = clock() < untilMs

    /** Milliseconds remaining, for the log line. Zero when clear to send. */
    fun remainingMs(): Long = (untilMs - clock()).coerceAtLeast(0)

    /**
     * Record a failed attempt.
     *
     * @param retryAfterSec what the server asked for, if it said. It wins over
     *   the local schedule: it is the only party that knows when its own
     *   rate-limit window resets, and guessing shorter just burns the allowance
     *   again immediately.
     */
    fun onFailure(retryAfterSec: Long? = null) {
        // Cap the shift count before shifting, not after: 1L shl 63 is negative
        // and 1L shl 64 wraps to 1, either of which would clear the backoff
        // entirely after enough failures — the exact opposite of the intent.
        failures = (failures + 1).coerceAtMost(MAX_SHIFTS)

        val base = when {
            retryAfterSec != null && retryAfterSec > 0 -> retryAfterSec * 1000
            else -> (baseMs shl (failures - 1)).coerceAtMost(capMs)
        }

        /*
         * Jitter is not decoration. Forty trucks that hit the same 429 in the
         * same second would otherwise retry in lockstep forever, reconstructing
         * the burst that caused the limit. Up to +20%, never negative — waiting
         * less than the server asked for is the one direction that must not
         * happen.
         */
        val jitter = (base * JITTER_FRACTION * random()).toLong()
        untilMs = clock() + base + jitter
    }

    /** A successful upload clears everything. */
    fun onSuccess() {
        failures = 0
        untilMs = 0
    }

    private companion object {
        /** 2^8 × 15 s already exceeds the 5-minute cap; beyond this the shift is unsafe. */
        const val MAX_SHIFTS = 8
        const val JITTER_FRACTION = 0.2
    }
}
