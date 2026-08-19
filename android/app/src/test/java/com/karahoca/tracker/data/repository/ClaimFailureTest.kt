package com.karahoca.tracker.data.repository

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The rule: only a 4xx may ever blame the driver's code.
 *
 * These assert on causes rather than on wording. The earlier version matched
 * Turkish substrings, which meant every new locale would have broken tests that
 * were really testing the translation instead of the rule.
 *
 * Each case is one of the ways the previous implementation said "your code is
 * rejected" about a code that was fine — see the note on [ClaimFailure].
 */
class ClaimFailureTest {

    /** The incident, reproduced exactly. */
    @Test
    fun `a proxy error during a deploy does not blame the code`() {
        // What a driver actually hit: 502 from Traefik with an HTML body, which
        // is not decodable JSON, so the caller passes null.
        assertEquals(ClaimFailure.ServerUnreachable, ClaimFailure.of(502, null))
    }

    @Test
    fun `every server-side status says the server, not the code`() {
        for (status in listOf(500, 502, 503, 504, 599)) {
            assertEquals("HTTP $status", ClaimFailure.ServerUnreachable, ClaimFailure.of(status, null))
        }
    }

    /**
     * A 5xx that happens to carry a decodable body is still a server fault.
     *
     * Worth pinning: the obvious implementation checks "did the server send a
     * message" before it checks the status, and then a 503 with a JSON body is
     * reported to the driver as though it described their code.
     */
    @Test
    fun `a server message on a 5xx is not shown as a verdict on the code`() {
        assertEquals(
            ClaimFailure.ServerUnreachable,
            ClaimFailure.of(503, "Service temporarily unavailable"),
        )
    }

    @Test
    fun `a 4xx with a message shows what the server said`() {
        // The real one, from the claim endpoint.
        val server = "That session code is not valid, has expired, or was already used."
        assertEquals(ClaimFailure.FromServer(server), ClaimFailure.of(404, server))
    }

    @Test
    fun `a 4xx with an unreadable body reports the status, not a verdict`() {
        assertEquals(ClaimFailure.Rejected(400), ClaimFailure.of(400, null))
    }

    @Test
    fun `a blank body counts as no body`() {
        // Retrofit hands back an empty string for a bodyless response, and
        // whitespace for one that is only whitespace. Neither is a message.
        assertEquals(ClaimFailure.of(400, null), ClaimFailure.of(400, ""))
        assertEquals(ClaimFailure.of(400, null), ClaimFailure.of(400, "   "))
    }

    @Test
    fun `too many attempts is its own cause`() {
        assertEquals(ClaimFailure.TooManyAttempts, ClaimFailure.of(429, null))
    }

    /** 429 is inside 400..499, so a server message must still win over it. */
    @Test
    fun `a rate-limit message from the server is preferred`() {
        val server = "Too many claim attempts. Wait a few minutes and try again."
        assertEquals(ClaimFailure.FromServer(server), ClaimFailure.of(429, server))
    }

    @Test
    fun `a status outside every band is reported honestly`() {
        assertEquals(ClaimFailure.Unexpected(302), ClaimFailure.of(302, null))
    }

    /**
     * Nothing but FromServer can carry text the app did not write.
     *
     * The transport failure is the one that used to: Retrofit's IOException
     * message is a hostname and a chain of causes, and the view model puts
     * `err.message` straight on screen. Every other cause resolves through a
     * string resource, so it cannot leak plumbing by construction.
     */
    @Test
    fun `only a server message can carry text the app did not write`() {
        val causes = listOf(
            ClaimFailure.of(500, null),
            ClaimFailure.of(429, null),
            ClaimFailure.of(400, null),
            ClaimFailure.of(302, null),
            ClaimFailure.NoNetwork,
        )
        for (cause in causes) {
            assertTrue("$cause carries free text", cause !is ClaimFailure.FromServer)
        }
    }
}
