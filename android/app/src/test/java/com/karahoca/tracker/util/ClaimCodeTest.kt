package com.karahoca.tracker.util

import android.net.Uri
import com.karahoca.tracker.BuildConfig
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.util.Locale

/**
 * The code is the only thing standing between a driver and a session, and every
 * path into it is untrusted input: a keyboard, a clipboard, and an intent from
 * an exported activity.
 */
@RunWith(RobolectricTestRunner::class)
class ClaimCodeTest {

    private val host = BuildConfig.APP_LINK_HOST
    private val scheme = BuildConfig.DEEP_LINK_SCHEME

    // ---- normalise ----------------------------------------------------------

    @Test
    fun `strips separators and upper-cases`() {
        assertEquals("K7H29QX4", ClaimCode.normalise("k7h2-9qx4"))
        assertEquals("K7H29QX4", ClaimCode.normalise("k7h2 9qx4"))
        assertEquals("K7H29QX4", ClaimCode.normalise(" K7H2 - 9QX4 "))
    }

    @Test
    fun `folds the Crockford aliases the alphabet omits`() {
        // I, L and U are not in the alphabet; a driver reading a printed code
        // will still type them.
        assertEquals("11101234", ClaimCode.normalise("ILUO1234"))
    }

    @Test
    fun `caps at the code length`() {
        assertEquals("K7H29QX4", ClaimCode.normalise("K7H29QX4EXTRA"))
        // The cap counts stored characters, not typed ones: a long run of
        // separators must not eat into it.
        assertEquals("K7H29QX4", ClaimCode.normalise("K-7-H-2-9-Q-X-4-9"))
    }

    @Test
    fun `handles empty and null`() {
        assertEquals("", ClaimCode.normalise(""))
        assertEquals("", ClaimCode.normalise(null))
        assertEquals("", ClaimCode.normalise("----"))
    }

    /**
     * The regression this app is most exposed to: every driver phone is set to
     * Turkish, where the default-locale uppercase of 'i' is 'İ' (U+0130) — not
     * a Latin I, not in the alphabet, and silently dropped.
     */
    @Test
    fun `dotted capital I is not produced on a Turkish device`() {
        val previous = Locale.getDefault()
        try {
            Locale.setDefault(Locale("tr", "TR"))
            // 'i' must fold to '1' via 'I', not vanish as 'İ'.
            assertEquals("1234567", ClaimCode.normalise("i234567"))
            assertEquals(7, ClaimCode.normalise("i234567").length)
        } finally {
            Locale.setDefault(previous)
        }
    }

    // ---- pretty -------------------------------------------------------------

    @Test
    fun `pretty inserts one dash after the fourth character`() {
        assertEquals("K7H2-9QX4", ClaimCode.pretty("K7H29QX4"))
        assertEquals("K7H2-9", ClaimCode.pretty("K7H29"))
        assertEquals("K7H2", ClaimCode.pretty("K7H2"))
        assertEquals("K7H", ClaimCode.pretty("K7H"))
        assertEquals("", ClaimCode.pretty(""))
    }

    // ---- fromLink -----------------------------------------------------------

    @Test
    fun `reads the App Link the QR encodes`() {
        assertEquals("K7H29QX4", ClaimCode.fromLink(Uri.parse("https://$host/t/K7H29QX4")))
        assertEquals("K7H29QX4", ClaimCode.fromLink(Uri.parse("https://$host/t/k7h2-9qx4")))
        // A trailing slash must not be read as an empty ninth character.
        assertEquals("K7H29QX4", ClaimCode.fromLink(Uri.parse("https://$host/t/K7H29QX4/")))
    }

    @Test
    fun `reads the custom scheme fallback`() {
        assertEquals("K7H29QX4", ClaimCode.fromLink(Uri.parse("$scheme://track?c=K7H29QX4")))
        assertEquals("K7H29QX4", ClaimCode.fromLink(Uri.parse("$scheme://track?c=k7h2-9qx4")))
    }

    @Test
    fun `query parameter wins over path on the web link`() {
        assertEquals("AAAA1111", ClaimCode.fromLink(Uri.parse("https://$host/t/?c=AAAA1111")))
    }

    @Test
    fun `rejects a link from another host`() {
        assertNull(ClaimCode.fromLink(Uri.parse("https://evil.example.com/t/K7H29QX4")))
    }

    @Test
    fun `rejects anything that is not a complete code`() {
        assertNull(ClaimCode.fromLink(Uri.parse("https://$host/t/K7H2")))
        assertNull(ClaimCode.fromLink(Uri.parse("https://$host/")))
        assertNull(ClaimCode.fromLink(Uri.parse("https://$host/sessions/K7H29QX4")))
        assertNull(ClaimCode.fromLink(Uri.parse("$scheme://track")))
        assertNull(ClaimCode.fromLink(null))
    }

    /**
     * MainActivity is exported, so any app on the phone can hand it a Uri.
     * getQueryParameter throws UnsupportedOperationException on an opaque one;
     * that must not become a crash on the launch path.
     */
    @Test
    fun `an opaque uri returns null instead of throwing`() {
        assertNull(ClaimCode.fromLink(Uri.parse("$scheme:track?c=K7H29QX4")))
        assertNull(ClaimCode.fromLink(Uri.parse("mailto:driver@example.com")))
    }
}
