package com.karahoca.tracker.util

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.karahoca.tracker.R
import java.io.File
import java.util.Locale
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * Guards for the two ways this app's translations have actually broken.
 *
 * Neither was caught by reading the code, and both shipped: a string left
 * hard-coded in a composable, and a string added to values/ but not to
 * values-ar/. The second is the nastier of the two, because Android resolves a
 * missing translation by silently falling back to the default — there is no
 * warning, no exception, and the screen simply comes out half Turkish.
 *
 * Worse, both were invisible to the obvious check. Scanning for Turkish text by
 * looking for ı, ş, ğ, ç or ö misses "Sevkiyat Takibi", "Oturum Kodu", "Yenile"
 * and "Temizle", which is how three of them survived a scan that was supposed
 * to be exhaustive. These tests do not look at letters.
 */
@RunWith(RobolectricTestRunner::class)
class LocalisationTest {

    private val jvmDefault: Locale = Locale.getDefault()

    /**
     * wrap() calls Locale.setDefault, which is process-wide and outlives the
     * test. Left alone it leaked far enough to render Gradle's own build
     * summary in Arabic-Indic digits.
     */
    @After
    fun restoreJvmLocale() = Locale.setDefault(jvmDefault)

    /** Deliberately identical across languages, with the reason it is. */
    private val untranslated = mapOf(
        "app_name" to "what a driver looks for in a launcher and a dispatcher says down a phone",
    )

    private fun res(dir: String): File {
        // Gradle runs unit tests from the module directory, but do not depend on it.
        val candidates = listOf("src/main/res", "app/src/main/res", "android/app/src/main/res")
        return candidates.map { File(it, dir) }.firstOrNull { it.isDirectory }
            ?: fail("cannot locate res/$dir from ${File(".").absolutePath}").let { error("unreachable") }
    }

    private fun ids(dir: String): Set<String> =
        Regex("""<string name="([^"]+)"""")
            .findAll(File(res(dir), "strings.xml").readText())
            .map { it.groupValues[1] }
            .toSet()

    @Test
    fun everyStringIsTranslatedIntoEveryLanguage() {
        val default = ids("values")
        for (language in listOf("values-ar", "values-ku")) {
            val translated = ids(language) + untranslated.keys
            val missing = (default - translated).sorted()
            assertTrue(
                "$language is missing ${missing.size} string(s), so they will silently " +
                    "fall back to Turkish on a driver's phone: $missing",
                missing.isEmpty(),
            )
            val orphaned = (translated - default - untranslated.keys).sorted()
            assertTrue("$language defines strings that no longer exist: $orphaned", orphaned.isEmpty())
        }
    }

    @Test
    fun noUserFacingStringIsHardCodedInTheUi() {
        val ui = File(res("values").parentFile!!.parentFile, "java/com/karahoca/tracker/ui")
        val allowed = setOf(
            // A sample code shown as a placeholder is not prose.
            "K7H2-9QX4",
            // The wordmark, for the same reason app_name is not translated.
            "KARAHOCA",
            // The monogram on the brand mark. It is the company's initials,
            // which are the same two letters in all three languages and in two
            // scripts — and the dashboard's own guard allows it for the same
            // reason, see apps/web/scripts/check-i18n.mjs.
            "KH",
        )
        // Anchoring to Text(" is not enough. The literal that got past the
        // first version of this test was
        //     Text(if (expanded) "Daralt" else stringResource(...))
        // where the literal sits in second position, so the whole argument
        // list has to be read — hence the paren walk.
        val callSite = Regex("""Text\(""")
        val literal = Regex("""\u0022([^\u0022\n]{2,})\u0022""")
        val escapes = Regex("""[\\].""")
        val offenders = ui.walkTopDown().filter { it.extension == "kt" }.flatMap { file ->
            val source = file.readText()
            callSite.findAll(source).flatMap { call ->
                val open = call.range.last
                var depth = 0
                var close = source.length - 1
                for (i in open until source.length) {
                    if (source[i] == '(') depth++
                    if (source[i] == ')') {
                        depth--
                        if (depth == 0) { close = i; break }
                    }
                }
                literal.findAll(source.substring(open, close))
                    .map { it.groupValues[1] }
                    // A separator is not prose. Strip escape pairs first, so
                    // the n in a joinToString newline reads as a word and the
                    // separator reports itself as a missing translation.
                    .filter { escapes.replace(it, "").any(Char::isLetter) }
                    .map { file.name to it }
            }.filterNot { it.second in allowed }
        }.toList()
        assertTrue(
            "A literal passed to Text() cannot be translated. Move it into strings.xml: $offenders",
            offenders.isEmpty(),
        )
    }

    @Test
    fun noUserFacingStringIsHardCodedOutsideTheUi() {
        // Prose reaches a driver from outside ui/ too: the readiness checklist
        // is built in DeviceInfoProvider, and four of its rows were still
        // hard-coded Turkish long after the rest of the app was translated.
        // Only these four property names carry prose — a label, its
        // explanation, and the title and body of an alert.
        val prose = Regex("""(label|detail|title|body) = \u0022([^\u0022\n]{2,})\u0022""")
        val main = File(res("values").parentFile!!.parentFile, "java/com/karahoca/tracker")
        val offenders = main.walkTopDown().filter { it.extension == "kt" }.flatMap { file ->
            prose.findAll(file.readText()).map { file.name to it.groupValues[2] }
        }.toList()
        assertTrue(
            "A literal assigned to a user-facing property cannot be translated: $offenders",
            offenders.isEmpty(),
        )
    }

    @Test
    fun wrapResolvesTheLanguageTheDriverChose() {
        val app = ApplicationProvider.getApplicationContext<Context>()

        // The notification is the screen a driver reads for eighteen hours, and
        // it is resolved through a wrapped context rather than an activity's.
        val heading = mapOf(
            AppLocale.TURKISH to "Takip aktif",
            AppLocale.ARABIC to "التتبّع نشط",
            AppLocale.KURMANJI to "Şopandin çalak e",
        )
        for ((tag, expected) in heading) {
            AppLocale.set(app, tag)
            assertEquals(
                "notification_title in $tag",
                expected,
                AppLocale.wrap(app).getString(R.string.notification_title),
            )
        }
    }

    @Test
    fun theChoiceRoundTripsAndSystemMeansSystem() {
        val app = ApplicationProvider.getApplicationContext<Context>()
        for (tag in listOf(AppLocale.ARABIC, AppLocale.KURMANJI, AppLocale.TURKISH, AppLocale.SYSTEM)) {
            AppLocale.set(app, tag)
            assertEquals("round trip of '$tag'", tag, AppLocale.current(app))
        }
        // SYSTEM must hand back the context untouched, or the wrap would freeze
        // font scale and dark mode at whatever they were when it was called.
        AppLocale.set(app, AppLocale.SYSTEM)
        assertTrue("SYSTEM must not wrap", AppLocale.wrap(app) === app)
    }

    @Test
    fun distancesStayInLatinDigitsWhateverTheLanguage() {
        // An Arabic phone formatting a distance as ٨٫٣ beside a plate reading
        // 27 AB 100 looks broken. formatRemaining pins Locale.ROOT for this.
        val app = ApplicationProvider.getApplicationContext<Context>()
        AppLocale.set(app, AppLocale.ARABIC)
        val arabic = AppLocale.wrap(app)
        val rendered = arabic.getString(R.string.distance_kilometres, formatRemaining(8_300.0).first)
        assertTrue(
            "distance rendered with non-Latin digits: $rendered",
            rendered.none { it in '\u0660'..'\u0669' },
        )
    }
}
