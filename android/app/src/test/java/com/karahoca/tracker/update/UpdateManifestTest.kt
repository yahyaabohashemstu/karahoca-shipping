package com.karahoca.tracker.update

import com.karahoca.tracker.BuildConfig
import java.util.Locale
import kotlinx.serialization.json.Json
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The manifest is the only thing standing between a fixed bug and a driver.
 *
 * It is parsed by an APK that is already in the field, which is the whole
 * point of it — so the failure mode that matters is not "the new server broke
 * the new app" but "the new server broke the app somebody is holding in Iraq,
 * and the only way to fix that app is the thing that just broke".
 */
class UpdateManifestTest {

    private val json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
        explicitNulls = false
    }

    private val jvmDefault: Locale = Locale.getDefault()

    @After
    fun restoreLocale() = Locale.setDefault(jvmDefault)

    private fun parse(text: String) = json.decodeFromString(UpdateManifest.serializer(), text)

    private val minimal = """
        {"versionCode": 99, "versionName": "9.9.9",
         "url": "https://track.karahoca.com/downloads/karahoca-takip.apk",
         "sha256": "abc123"}
    """.trimIndent()

    @Test
    fun `parses a manifest with only the required fields`() {
        val m = parse(minimal)
        assertEquals(99, m.versionCode)
        assertEquals("9.9.9", m.versionName)
        assertEquals(0L, m.sizeBytes)
        assertTrue(m.notes.isEmpty())
    }

    /**
     * A server that grows a field must not brick the fleet.
     *
     * `ignoreUnknownKeys` is set on the app's Json; this fails if anybody ever
     * turns it off, which would take out every phone at once the first time
     * the manifest gained a key.
     */
    @Test
    fun `an older app ignores fields it has never heard of`() {
        val m = parse(
            """
            {"versionCode": 99, "versionName": "9.9.9", "url": "https://x/a.apk",
             "sha256": "abc123", "rolloutPercent": 25, "minSupported": {"code": 12}}
            """.trimIndent(),
        )
        assertEquals(99, m.versionCode)
    }

    @Test
    fun `only a higher versionCode counts as newer`() {
        assertTrue(parse(minimal).isNewerThanInstalled)

        val same = parse(minimal.replace("99", BuildConfig.VERSION_CODE.toString()))
        assertFalse("the installed build must never offer to install itself", same.isNewerThanInstalled)

        val older = parse(minimal.replace("\"versionCode\": 99", "\"versionCode\": 1"))
        assertFalse("a rollback must not be offered as an update", older.isNewerThanInstalled)
    }

    @Test
    fun `release notes fall back to Turkish when a language is missing`() {
        val m = parse(
            """
            {"versionCode": 99, "versionName": "9.9.9", "url": "https://x/a.apk",
             "sha256": "abc", "notes": {"tr": "Yenilikler", "ar": "الجديد"}}
            """.trimIndent(),
        )
        assertEquals("الجديد", m.notesFor("ar"))
        assertEquals("Yenilikler", m.notesFor("tr"))
        // Kurmanji was not translated for this release. Turkish is readable by
        // someone in the yard the driver can telephone; an empty banner is not.
        assertEquals("Yenilikler", m.notesFor("ku"))
        assertNull(parse(minimal).notesFor("tr"))
    }

    /**
     * The size is the number a driver decides on.
     *
     * It has to be Latin digits whatever the phone's locale is — an Arabic
     * default once turned a clock in this app into ١٣:٤٧:٢٠ sitting beside a
     * Latin session reference, and the size sits beside a Latin version number
     * in exactly the same way.
     */
    @Test
    fun `size is Latin digits even under an Arabic locale`() {
        Locale.setDefault(Locale.forLanguageTag("ar"))
        val m = parse(minimal.replace("\"sha256\"", "\"sizeBytes\": 25165824, \"sha256\""))
        assertEquals("24 MB", m.sizeLabel)
    }

    @Test
    fun `size is blank rather than zero when the server did not say`() {
        assertEquals("", parse(minimal).sizeLabel)
    }
}
