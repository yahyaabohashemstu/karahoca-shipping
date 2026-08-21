package com.karahoca.tracker.update

import com.karahoca.tracker.BuildConfig
import java.util.Locale
import kotlinx.serialization.Serializable

/**
 * What the server says the newest build is.
 *
 * Served as a static file next to the APK itself
 * (`/downloads/latest.json`) rather than from the API, for one reason: it is
 * written by the same command that swaps the APK into place, so the two cannot
 * drift. A manifest that advertises a version the download does not contain is
 * worse than no manifest at all — every phone in the fleet would download 24 MB
 * and install the build it already has.
 *
 * `ignoreUnknownKeys` is on in the app's Json, so fields can be added here
 * without breaking an APK already in a driver's pocket. That matters more than
 * usual: the whole point of this class is to reach phones we cannot otherwise
 * update.
 */
@Serializable
data class UpdateManifest(
    val versionCode: Int,
    val versionName: String,
    val url: String,
    val sha256: String,
    val sizeBytes: Long = 0,
    val publishedAt: String? = null,
    /** Keyed by language tag: tr, ar, ku. */
    val notes: Map<String, String> = emptyMap(),
) {

    /** True when this is worth telling the driver about. */
    val isNewerThanInstalled: Boolean get() = versionCode > BuildConfig.VERSION_CODE

    fun notesFor(tag: String): String? = notes[tag] ?: notes[FALLBACK_NOTES_TAG]

    /**
     * "24 MB", in Latin digits.
     *
     * Latin rather than the locale's own, matching every other number the app
     * shows a driver — the distance remaining, the buffered count, the clock.
     * An Arabic reader here sees ٢٤ everywhere else in their phone and 24 in
     * this app, consistently, which is less confusing than one screen doing it
     * differently from the next.
     */
    val sizeLabel: String
        get() = if (sizeBytes <= 0) {
            ""
        } else {
            String.format(Locale.ROOT, "%.0f MB", sizeBytes / 1_048_576.0)
        }
}

/**
 * Turkish, because it is the language of the yard the app is dispatched from —
 * a release note that failed to be translated is still readable by someone the
 * driver can telephone.
 *
 * Top-level rather than a companion: kotlinx.serialization generates
 * `Companion.serializer()`, and a hand-written `private companion object` here
 * shadows it, so the class becomes unserialisable with an error that names the
 * companion rather than the constant that caused it.
 */
private const val FALLBACK_NOTES_TAG = "tr"
