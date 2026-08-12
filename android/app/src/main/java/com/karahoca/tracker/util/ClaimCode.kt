package com.karahoca.tracker.util

import android.net.Uri
import com.karahoca.tracker.BuildConfig
import java.util.Locale

/**
 * The session hand-off code, and every way it can arrive.
 *
 * Codes are 8 characters of Crockford Base32 — the alphabet
 * `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, which omits I, L, O and U precisely so a
 * driver reading one off a dispatch note in a dark cab cannot confuse 1/I/l or
 * 0/O. Displayed as `XXXX-XXXX`; stored, transmitted and compared without the
 * dash.
 *
 * This object is the single place that turns anything the outside world offers
 * — a typed character, a pasted string, a scanned URL — into that canonical
 * form. It mirrors `kh.normalize_claim_code` in the database and
 * `normalizeClaimCode` in the API; all three must agree or a code that looks
 * accepted on the phone is rejected by the server.
 */
object ClaimCode {

    /** Every code `kh.generate_claim_code(8)` issues is this long. */
    const val LENGTH = 8

    /** Where the dash goes when the code is shown to a human. */
    const val GROUP = 4

    /**
     * Canonical form: ASCII only, upper case, ambiguous letters folded, capped.
     *
     * `Locale.ROOT` is load-bearing. Every driver phone in this fleet is set to
     * Turkish, and Turkish has a dotted capital: `"i".uppercase()` with the
     * default locale yields `İ` (U+0130), not `I`. That character is not in the
     * alphabet, would not fold to `1`, and would be stripped — turning a typed
     * `i` into nothing at all on exactly the devices this app runs on.
     */
    fun normalise(raw: String?): String {
        if (raw.isNullOrEmpty()) return ""
        val out = StringBuilder(LENGTH)
        for (ch in raw) {
            if (out.length >= LENGTH) break
            val upper = ch.uppercaseChar()
            when {
                upper in '0'..'9' -> out.append(upper)
                upper in 'A'..'Z' -> out.append(fold(upper))
                // Dashes, spaces and anything else a human or a scanner adds.
                else -> Unit
            }
        }
        return out.toString()
    }

    /** Crockford's aliases: I and L read as one, O as zero, U as one. */
    private fun fold(upper: Char): Char = when (upper) {
        'I', 'L', 'U' -> '1'
        'O' -> '0'
        else -> upper
    }

    /** `K7H29QX4` -> `K7H2-9QX4`. Short codes are returned untouched. */
    fun pretty(code: String): String =
        if (code.length > GROUP) "${code.take(GROUP)}-${code.drop(GROUP)}" else code

    /**
     * Pull a code out of whatever URI launched us.
     *
     * Three shapes reach this app, and all three are real:
     *
     *   https://track.karahoca.com/t/K7H29QX4   verified App Link — the QR
     *   karahoca://track?c=K7H29QX4             landing page intent:// and SMS
     *   https://track.karahoca.com/t/?c=…       tolerated, never generated
     *
     * The https host is checked against the one this build claims. An intent
     * carrying a link from any other host did not come from our QR, and its
     * path segment is not our code.
     *
     * Wrapped in runCatching because MainActivity is an exported component:
     * any app on the phone can send it a VIEW intent with a hand-made Uri, and
     * `getQueryParameter` throws on an opaque one (`karahoca:track?c=…`, no
     * slashes). A malformed link must produce "no code", never a crash on the
     * launch path.
     */
    fun fromLink(uri: Uri?): String? = runCatching {
        if (uri == null) return@runCatching null

        val candidate = when (uri.scheme?.lowercase(Locale.ROOT)) {
            BuildConfig.DEEP_LINK_SCHEME ->
                if (uri.isHierarchical) uri.getQueryParameter("c") else null

            "https", "http" -> {
                if (!uri.host.equals(BuildConfig.APP_LINK_HOST, ignoreCase = true)) {
                    return@runCatching null
                }
                // getPathSegments() drops empty segments, so a trailing slash
                // does not hand us "".
                val segments = uri.pathSegments
                uri.getQueryParameter("c")
                    ?: segments.takeIf { it.size >= 2 && it[0].equals("t", ignoreCase = true) }?.get(1)
            }

            else -> null
        }

        normalise(candidate).takeIf { it.length == LENGTH }
    }.getOrNull()
}
