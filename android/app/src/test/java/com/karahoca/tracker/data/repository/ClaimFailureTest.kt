package com.karahoca.tracker.data.repository

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The rule: only a 4xx may ever blame the driver's code.
 *
 * This exists because the previous version broke that rule for every failure
 * and turned a ninety-second deploy into a broken shipment — see the note on
 * [ClaimFailure]. Each case below is one of the ways the old code said "your
 * code is rejected" about a code that was fine.
 */
class ClaimFailureTest {

    /** The incident, reproduced exactly. */
    @Test
    fun `a proxy error during a deploy does not blame the code`() {
        // What a driver actually hit: 502 from Traefik with an HTML body, which
        // is not decodable JSON, so the caller passes null.
        val message = ClaimFailure.message(502, null)
        assertTrue(
            "a 5xx must say the code is still valid, said: $message",
            message.contains("Kod geçerli"),
        )
    }

    @Test
    fun `every server-side status says the server, not the code`() {
        for (status in listOf(500, 502, 503, 504)) {
            val message = ClaimFailure.message(status, null)
            assertTrue("HTTP $status blamed the code: $message", message.contains("Kod geçerli"))
        }
    }

    /**
     * A 5xx that happens to carry a decodable body is still a server fault.
     *
     * Worth pinning: the obvious implementation checks "did the server send a
     * message" before it checks the status, and then a 503 with a JSON body
     * would be reported to the driver as though it described their code.
     */
    @Test
    fun `a server message on a 5xx is not shown as a verdict on the code`() {
        val message = ClaimFailure.message(503, "Service temporarily unavailable")
        assertTrue(message.contains("Kod geçerli"))
        assertTrue(!message.contains("Service temporarily"))
    }

    @Test
    fun `a 4xx with a message shows what the server said`() {
        // The real one, from kh.alerts' claim endpoint.
        val server = "That session code is not valid, has expired, or was already used."
        assertEquals(server, ClaimFailure.message(404, server))
    }

    @Test
    fun `a 4xx with an unreadable body still does not assert the code is wrong`() {
        val message = ClaimFailure.message(400, null)
        assertTrue("said: $message", message.contains("400"))
        // "not accepted", not "your code is wrong" — the distinction the whole
        // class exists for.
        assertTrue(message.contains("İstek kabul edilmedi"))
    }

    @Test
    fun `a blank body counts as no body`() {
        // Retrofit hands back an empty string for a bodyless response, and
        // "   " for one that is whitespace. Neither is a message.
        assertEquals(ClaimFailure.message(400, null), ClaimFailure.message(400, ""))
        assertEquals(ClaimFailure.message(400, null), ClaimFailure.message(400, "   "))
    }

    @Test
    fun `too many attempts has its own message`() {
        val message = ClaimFailure.message(429, null)
        assertTrue("said: $message", message.contains("Çok fazla deneme"))
    }

    /** 429 is inside 400..499, so a server message must still win over it. */
    @Test
    fun `a rate-limit message from the server is preferred`() {
        val server = "Too many claim attempts. Wait a few minutes and try again."
        assertEquals(server, ClaimFailure.message(429, server))
    }

    @Test
    fun `a status outside every band is reported honestly`() {
        val message = ClaimFailure.message(302, null)
        assertTrue("said: $message", message.contains("302"))
        assertTrue(message.contains("Beklenmeyen"))
    }

    /**
     * Every message is Turkish and none leaks a hostname or a stack.
     *
     * The transport failure is the one that used to: Retrofit's IOException
     * message is a hostname and a chain of causes, and the view model puts
     * `err.message` straight on screen.
     */
    @Test
    fun `no message exposes plumbing to the driver`() {
        val all = listOf(
            ClaimFailure.NO_NETWORK,
            ClaimFailure.message(500, null),
            ClaimFailure.message(429, null),
            ClaimFailure.message(400, null),
            ClaimFailure.message(302, null),
        )
        for (message in all) {
            assertTrue("empty message", message.isNotBlank())
            for (leak in listOf("http://", "https://", "Exception", "karahoca.com", "at com.")) {
                assertTrue("leaked '$leak' in: $message", !message.contains(leak))
            }
        }
    }
}
