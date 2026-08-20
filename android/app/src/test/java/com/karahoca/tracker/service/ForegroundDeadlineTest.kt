package com.karahoca.tracker.service

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Guards on the ten seconds between startForegroundService() and startForeground().
 *
 * Android treats that window as a promise, and the penalty for breaking it is
 * not a dropped session but ForegroundServiceDidNotStartInTimeException killing
 * the process. Drivers hit it after a reboot, which is the worst possible time:
 * the phone is resuming a shipment that is already in progress, and the crash
 * looks to them like the app simply refusing to come back.
 *
 * What it cost, measured on a boot with a live session and the device at 99.9%
 * I/O pressure:
 *
 *   - onCreate built the FusedLocationProviderClient, which pulls the Play
 *     Services location classes in and makes ART verify them on the calling
 *     thread: ~700 ms of the 1.4 s the service took to reach onStartCommand.
 *   - promoteToForeground built the full notification — three PendingIntents,
 *     each a round trip into ActivityManagerService, and a locale-wrapped
 *     Resources with its own AssetManager: another 405 ms.
 *   - and a repeat start command posted nothing at all, because the method
 *     returned early once the service was already foreground. Two starts arrive
 *     on every boot, and under that I/O pressure the second was delivered 10.1
 *     seconds after it was requested.
 *
 * Same boot after the fix: 47 ms to onCreate, 28 ms to startForeground.
 *
 * None of that is visible by reading the method — it looks fast either way —
 * and none of it is reachable from a unit test on the JVM, because every line
 * of it is a platform call. So these read the source instead. They are crude,
 * and they are the only thing standing between this window and the next
 * plausible-looking line somebody adds to onCreate.
 */
class ForegroundDeadlineTest {

    private val source: String by lazy {
        val candidates = listOf("", "app/", "android/app/").map {
            File("${it}src/main/java/com/karahoca/tracker/service/LocationTrackingService.kt")
        }
        candidates.firstOrNull { it.isFile }?.readText()
            ?: fail("cannot find LocationTrackingService.kt from ${File(".").absolutePath}")
                .let { error("unreachable") }
    }

    /**
     * The source with comments and string literals removed.
     *
     * Both would otherwise defeat every check below: the file explains this
     * deadline at length, so searching the raw text for "LocationServices"
     * matches the paragraph warning against it.
     */
    private val code: String by lazy { strip(source) }

    private fun strip(text: String): String {
        val out = StringBuilder(text.length)
        var i = 0
        while (i < text.length) {
            val rest = text.length - i
            when {
                rest >= 2 && text.startsWith("/*", i) -> {
                    val end = text.indexOf("*/", i + 2)
                    i = if (end < 0) text.length else end + 2
                }
                rest >= 2 && text.startsWith("//", i) -> {
                    val end = text.indexOf('\n', i)
                    i = if (end < 0) text.length else end
                }
                text[i] == '"' -> {
                    // Templates such as "${a - b}" keep their braces balanced,
                    // but the contents are not code we want to match on.
                    i++
                    while (i < text.length && text[i] != '"') {
                        if (text[i] == '\\') i++
                        i++
                    }
                    i++
                    out.append("\"\"")
                }
                else -> out.append(text[i++])
            }
        }
        return out.toString()
    }

    /** The body of a named function, braces matched, comments and strings gone. */
    private fun body(name: String): String {
        val signature = Regex("""(?:override |private )*fun $name\(""").find(code)
            ?: fail("no function named $name").let { error("unreachable") }
        var i = code.indexOf('{', signature.range.first)
        if (i < 0) fail("$name has no block body")
        /*
         * An expression body would make the search above skip straight into the
         * NEXT function and quietly assert against that one instead — which is
         * exactly what happened the first time this ran.
         */
        val assignment = code.indexOf('=', signature.range.last)
        if (assignment in 0 until i) {
            fail("$name has an expression body; these checks need a block one")
        }
        var depth = 0
        val start = i
        while (i < code.length) {
            if (code[i] == '{') depth++
            if (code[i] == '}') {
                depth--
                if (depth == 0) return code.substring(start + 1, i)
            }
            i++
        }
        fail("unbalanced braces in $name")
        error("unreachable")
    }

    /**
     * onCreate runs inside the deadline, after Hilt has already spent part of it
     * building the graph. Play Services is the specific thing that was in here.
     */
    @Test
    fun `onCreate does not touch Play Services`() {
        val onCreate = body("onCreate")
        assertFalse(
            "onCreate must not build the location client — ART verifies the Play " +
                "Services classes on this thread, inside the startForeground deadline. " +
                "`fused` is `by lazy` so the cost lands on first use instead:\n$onCreate",
            onCreate.contains("LocationServices"),
        )
    }

    /** Kept honest by size as well as by content: nothing new belongs here. */
    @Test
    fun `onCreate stays small`() {
        val statements = body("onCreate").lines()
            .map { it.trim() }
            .filter { it.isNotEmpty() }
        assertTrue(
            "onCreate has grown to ${statements.size} statements. Every one of them " +
                "is taken out of the ten seconds we have to reach startForeground on " +
                "the boot path. Move it to beginTracking:\n" + statements.joinToString("\n"),
            statements.size <= 4,
        )
    }

    /**
     * Each startForegroundService() call is its own promise.
     *
     * The system forgives a redundant one only if the service has *already*
     * reached the foreground by the time that call is delivered — and on the
     * boot path the second one arrived ten seconds late, which is the whole
     * width of the window.
     */
    @Test
    fun `a repeat start command re-posts instead of returning early`() {
        assertFalse(
            "promoteToForeground must not skip startForeground() when it has run " +
                "before. Two starts arrive on every boot — TrackerApplication's " +
                "self-heal and BootReceiver — and the second one's deadline is not " +
                "satisfied by the first one's call.",
            Regex("""if\s*\(\s*isForegroundStarted\s*\)\s*return""").containsMatchIn(code),
        )
        assertTrue(
            "promoteToForeground must still call startForeground",
            body("promoteToForeground").contains("ServiceCompat.startForeground"),
        )
    }

    /**
     * The notification that keeps the promise must be buildable from nothing.
     *
     * TrackingNotification.build attaches three PendingIntents and resolves the
     * action labels; postRichNotification puts all of that back one call later,
     * once the deadline is behind us.
     */
    @Test
    fun `the bootstrap notification pays for nothing it does not need`() {
        val bootstrap = body("bootstrapNotification")
        listOf("notifications", "setContentIntent", "addAction", "PendingIntent").forEach {
            assertFalse(
                "bootstrapNotification must not use `$it` — it exists to be the " +
                    "cheapest notification that can legally hold a foreground service:\n$bootstrap",
                bootstrap.contains(it),
            )
        }
    }

    /** Nothing may be dispatched ahead of the promise being kept. */
    @Test
    fun `the start branch promotes before it does anything else`() {
        val onStartCommand = body("onStartCommand")
        val promote = onStartCommand.indexOf("promoteToForeground()", onStartCommand.indexOf("else ->"))
        val launch = onStartCommand.indexOf("beginTracking")
        assertTrue("ACTION_START must call promoteToForeground()", promote > 0)
        assertTrue("ACTION_START must still begin tracking", launch > 0)
        assertTrue(
            "promoteToForeground() must come before beginTracking is dispatched: " +
                "a coroutine launched first would compete for the same main thread.",
            promote < launch,
        )
    }
}
