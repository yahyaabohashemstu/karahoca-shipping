package com.karahoca.tracker.data.repository

import android.content.Context
import com.karahoca.tracker.R

/**
 * Why a session code did not go through.
 *
 * A cause rather than a sentence, so the decision and the wording can live
 * apart: the rule below is pure and testable, and the Turkish, Arabic or
 * Kurdish comes from resources at the edge where a Context exists.
 *
 * The rule came from a real incident. On 14 August a deploy replaced the API
 * container in the ninety seconds between a dispatcher issuing code DXP1-KFBQ
 * and the driver typing it. The proxy answered 502 with an HTML page, the JSON
 * decode returned null, and the phone said "Session code was rejected" — about
 * a code that was ASSIGNED, unexpired, and claimed successfully eight minutes
 * later.
 *
 * That is not a wording problem. A driver in a yard reads "your code is
 * rejected" and telephones the office; the dispatcher regenerates the code; the
 * good one is invalidated and the failure becomes real. The app turned a
 * ninety-second outage into a broken shipment.
 *
 * So the status code decides first, and only a 4xx may ever blame the code.
 */
sealed interface ClaimFailure {

    /** The server explained itself, and it was about the request. */
    data class FromServer(val message: String) : ClaimFailure

    /** The request never reached a server. */
    data object NoNetwork : ClaimFailure

    /** 5xx. Says nothing about the code, and says so. */
    data object ServerUnreachable : ClaimFailure

    data object TooManyAttempts : ClaimFailure

    /** A 4xx whose body could not be read. Still not evidence the code is wrong. */
    data class Rejected(val status: Int) : ClaimFailure

    data class Unexpected(val status: Int) : ClaimFailure

    companion object {
        /**
         * @param status     the HTTP status the server answered with
         * @param fromServer a message decoded from the error body, or null when
         *                   the body was absent, empty, or not the JSON we
         *                   expect — which is exactly what an HTML proxy error
         *                   looks like
         */
        fun of(status: Int, fromServer: String?): ClaimFailure {
            val server = fromServer?.takeIf { it.isNotBlank() }
            return when {
                status in 400..499 && server != null -> FromServer(server)
                status == 429 -> TooManyAttempts
                // 502/503/504 from the proxy while the API restarts, and 500
                // from the API itself. Telling the driver the code is still
                // valid is the part that stops the phone call.
                status >= 500 -> ServerUnreachable
                status in 400..499 -> Rejected(status)
                else -> Unexpected(status)
            }
        }
    }
}

/**
 * The cause, in the driver's language.
 *
 * Separate from the decision so that adding Arabic and Kurdish changed no
 * logic, and so the tests above assert on causes rather than on Turkish
 * substrings — which would have had to be rewritten for every new locale and
 * would have been testing the translation, not the rule.
 */
fun ClaimFailure.messageFor(context: Context): String = when (this) {
    is ClaimFailure.FromServer -> message
    ClaimFailure.NoNetwork -> context.getString(R.string.claim_no_network)
    ClaimFailure.ServerUnreachable -> context.getString(R.string.claim_server_unreachable)
    ClaimFailure.TooManyAttempts -> context.getString(R.string.claim_too_many)
    is ClaimFailure.Rejected -> context.getString(R.string.claim_rejected, status.toString())
    is ClaimFailure.Unexpected -> context.getString(R.string.claim_unexpected, status.toString())
}
