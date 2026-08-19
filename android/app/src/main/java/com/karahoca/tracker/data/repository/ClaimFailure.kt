package com.karahoca.tracker.data.repository

/**
 * What to tell a driver when a session code does not go through.
 *
 * Extracted from TrackingRepository so it can be tested, and it earned that: it
 * is the one piece of this app that shipped without ever going through a
 * compiler, let alone a test, because there was no JDK on the machine it was
 * written on for several weeks.
 *
 * The rule it encodes came from a real incident. On 14 August a deploy replaced
 * the API container in the ninety seconds between a dispatcher issuing code
 * DXP1-KFBQ and the driver typing it. The proxy answered 502 with an HTML page,
 * the JSON decode returned null, and the phone said "Session code was rejected"
 * — about a code that was ASSIGNED, unexpired, and claimed successfully eight
 * minutes later.
 *
 * That is not a wording problem. A driver in a yard reads "your code is
 * rejected" and telephones the office; the dispatcher regenerates the code; the
 * good one is invalidated and the failure becomes real. The app turned a
 * ninety-second outage into a broken shipment.
 *
 * So the status code decides first, and only a 4xx may ever blame the code.
 */
object ClaimFailure {

    /**
     * @param status     the HTTP status the server answered with
     * @param fromServer a message decoded from the error body, or null if the
     *                   body was absent, empty, or not the JSON we expect —
     *                   which is exactly what an HTML proxy error looks like
     */
    fun message(status: Int, fromServer: String?): String {
        val server = fromServer?.takeIf { it.isNotBlank() }
        return when {
            // The server said something specific and it is about the request.
            // 429 included: "too many attempts" is its own message.
            status in 400..499 && server != null -> server

            status == 429 -> "Çok fazla deneme yapıldı. Bir dakika bekleyip tekrar deneyin."

            // 502/503/504 from the proxy while the API restarts, and 500 from
            // the API itself. None of these say anything about the code, and
            // saying the code is valid is the part that stops the phone call.
            status >= 500 ->
                "Sunucuya şu an ulaşılamıyor. Kod geçerli — bir dakika sonra tekrar deneyin."

            // A 4xx whose body could not be read. Rare, and still not evidence
            // that the code is wrong.
            status in 400..499 -> "İstek kabul edilmedi (HTTP $status). Tekrar deneyin."

            else -> "Beklenmeyen sunucu yanıtı (HTTP $status). Tekrar deneyin."
        }
    }

    /** Shown when the request never reached a server at all. */
    const val NO_NETWORK =
        "İnternet bağlantısı yok gibi görünüyor. Şebekeyi kontrol edip tekrar deneyin."
}
