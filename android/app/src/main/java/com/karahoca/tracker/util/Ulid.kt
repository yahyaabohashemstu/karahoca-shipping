package com.karahoca.tracker.util

import java.security.SecureRandom
import java.util.concurrent.atomic.AtomicLong

/**
 * ULID — 26 characters, Crockford Base32, lexicographically sortable by time.
 *
 * Chosen over UUIDv4 as the point identity because the server's primary key is
 * `(session_id, client_point_id, recorded_at)`. A time-ordered id means B-tree
 * inserts land at the right edge of the index instead of scattering across it,
 * which matters when a single offline flush inserts 8,600 rows at once.
 *
 * Monotonic within a millisecond: if two fixes share a timestamp the random
 * component is incremented rather than redrawn, so ids never collide and never
 * go backwards.
 */
object Ulid {

    private const val ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    private const val TIME_CHARS = 10
    private const val RANDOM_CHARS = 16

    private val random = SecureRandom()
    private val lastTime = AtomicLong(0)
    private var lastRandom = ByteArray(10)

    @Synchronized
    fun generate(timestampMs: Long = System.currentTimeMillis()): String {
        val previous = lastTime.get()
        if (timestampMs == previous) {
            incrementRandom()
        } else {
            random.nextBytes(lastRandom)
            lastTime.set(timestampMs)
        }
        return buildString(TIME_CHARS + RANDOM_CHARS) {
            appendTime(timestampMs)
            appendRandom()
        }
    }

    private fun StringBuilder.appendTime(ts: Long) {
        var value = ts
        val chars = CharArray(TIME_CHARS)
        for (i in TIME_CHARS - 1 downTo 0) {
            chars[i] = ENCODING[(value and 0x1F).toInt()]
            value = value shr 5
        }
        append(chars)
    }

    private fun StringBuilder.appendRandom() {
        // 10 bytes = 80 bits → 16 Base32 characters, exactly.
        var bitBuffer = 0
        var bitCount = 0
        var emitted = 0
        for (byte in lastRandom) {
            bitBuffer = (bitBuffer shl 8) or (byte.toInt() and 0xFF)
            bitCount += 8
            while (bitCount >= 5 && emitted < RANDOM_CHARS) {
                bitCount -= 5
                append(ENCODING[(bitBuffer shr bitCount) and 0x1F])
                emitted++
            }
        }
        while (emitted < RANDOM_CHARS) {
            append(ENCODING[0])
            emitted++
        }
    }

    /** Big-endian +1 with carry, so monotonicity holds inside a millisecond. */
    private fun incrementRandom() {
        for (i in lastRandom.indices.reversed()) {
            val next = (lastRandom[i].toInt() and 0xFF) + 1
            lastRandom[i] = (next and 0xFF).toByte()
            if (next <= 0xFF) return
        }
        // Overflowed all 80 bits inside one millisecond — impossible in practice;
        // redraw rather than wrap to zero.
        random.nextBytes(lastRandom)
    }
}
