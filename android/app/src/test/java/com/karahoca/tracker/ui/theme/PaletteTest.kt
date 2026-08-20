package com.karahoca.tracker.ui.theme

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * One palette, four surfaces.
 *
 * The dispatcher's dashboard, the consignee's tracking page, the two driver web
 * pages and this app are all supposed to be the same product. Three of those
 * four read their colours from one stylesheet; this one cannot, because it is
 * Kotlin, so its values are transcribed by hand — and a hand-transcribed copy
 * of anything drifts the first time somebody adjusts the original.
 *
 * This reads both files and compares them. It is the only mechanism that can
 * catch the drift: nothing else in either build knows the other exists.
 *
 * It is deliberately not exhaustive. Only the tokens that must agree are
 * listed — the accent, the surfaces, the lines, the text, and the two domain
 * colours a driver and a dispatcher have to see identically. The app has no use
 * for a map marker colour and the web has no use for a chip disc, and forcing
 * either to carry the other's would be worse than letting them differ.
 *
 * If the web module is not present — someone has opened `android/` on its own —
 * the test skips rather than fails. A guard that cannot run is not a defect.
 */
class PaletteTest {

    /** kh- token in globals.css  ->  property name in Theme.kt */
    private val scheme = mapOf(
        "brand" to "primary",
        "brand-soft" to "primaryContainer",
        "brand-text" to "onPrimaryContainer",
        "brand-hover" to "secondary",
        "bg" to "background",
        "surface" to "surface",
        "surface-2" to "surfaceVariant",
        "surface-3" to "surfaceContainerHigh",
        "border" to "outlineVariant",
        "border-strong" to "outline",
        "text" to "onSurface",
        "text-2" to "onSurfaceVariant",
        "danger" to "error",
        "danger-bg" to "errorContainer",
    )

    /** The same, for the domain colours Material has no slot for. */
    private val status = mapOf(
        "live" to "live",
        "live-bg" to "liveContainer",
        "delayed" to "warn",
        "delayed-bg" to "warnContainer",
        "danger" to "danger",
        "danger-bg" to "dangerContainer",
    )

    @Test
    fun theAppUsesTheSameColoursAsEveryOtherSurface() {
        val css = globalsCss() ?: return
        val kt = themeKt()

        for ((themeName, cssBlock, ktBlock) in listOf(
            Triple("light", cssTokens(css, LIGHT_ROOT), ktColors(kt, "LightColors")),
            Triple("dark", cssTokens(css, DARK_ROOT), ktColors(kt, "DarkColors")),
        )) {
            assertTrue("could not read the $themeName block of globals.css", cssBlock.isNotEmpty())
            assertTrue("could not read the $themeName ColorScheme in Theme.kt", ktBlock.isNotEmpty())
            for ((token, slot) in scheme) {
                val expected = cssBlock[token] ?: continue
                val actual = ktBlock[slot]
                assertEquals(
                    "$themeName: $slot in Theme.kt must equal --kh-$token in globals.css",
                    expected,
                    actual,
                )
            }
        }
    }

    @Test
    fun theStatusColoursMatchTheDispatchersOwn() {
        /*
         * These are the ones that matter most, and the reason is a telephone
         * call. A driver says the screen is green and a dispatcher looks at
         * their own screen to agree; if "the GPS is reporting" is one green
         * here and another there, that conversation goes wrong in a way neither
         * of them can see.
         */
        val css = globalsCss() ?: return
        val kt = themeKt()

        for ((themeName, cssBlock, ktBlock) in listOf(
            Triple("light", cssTokens(css, LIGHT_ROOT), ktColors(kt, "LightStatus")),
            Triple("dark", cssTokens(css, DARK_ROOT), ktColors(kt, "DarkStatus")),
        )) {
            assertTrue("could not read $themeName StatusColors in Theme.kt", ktBlock.isNotEmpty())
            for ((token, field) in status) {
                val expected = cssBlock[token] ?: continue
                assertEquals(
                    "$themeName: StatusColors.$field must equal --kh-$token in globals.css",
                    expected,
                    ktBlock[field],
                )
            }
        }
    }

    @Test
    fun theWindowResourcesMatchTheComposeTheme() {
        /*
         * colors.xml is what paints the window before Compose has drawn a
         * frame. If it disagrees with the theme the app is about to apply, the
         * driver sees the disagreement as a flash on every cold start — which
         * is exactly what a hard-coded #F8FAFC in the light file used to do to
         * anybody running a dark phone.
         */
        val kt = themeKt()
        val light = ktColors(kt, "LightColors")
        val dark = ktColors(kt, "DarkColors")

        assertEquals(
            "values/colors.xml window_background must equal the light theme's background",
            light["background"],
            xmlColor("values", "window_background"),
        )
        assertEquals(
            "values-night/colors.xml window_background must equal the dark theme's background",
            dark["background"],
            xmlColor("values-night", "window_background"),
        )
        assertEquals(
            "values/colors.xml brand_primary must equal the light theme's primary",
            light["primary"],
            xmlColor("values", "brand_primary"),
        )
        assertEquals(
            "values-night/colors.xml brand_primary must equal the dark theme's primary",
            dark["primary"],
            xmlColor("values-night", "brand_primary"),
        )
    }

    // ---------------------------------------------------------------- reading

    private companion object {
        const val LIGHT_ROOT = ":root {"
        const val DARK_ROOT = ":root[data-theme='dark'] {"
    }

    /** Gradle runs unit tests from the module directory, but do not depend on it. */
    private fun find(vararg candidates: String): File? =
        candidates.map(::File).firstOrNull { it.exists() }

    private fun globalsCss(): String? {
        val file = find(
            "../apps/web/src/app/globals.css",
            "../../apps/web/src/app/globals.css",
            "apps/web/src/app/globals.css",
        )
        // Skipped, not failed: someone may have opened android/ on its own.
        assumeTrue("web module not present; skipping the cross-surface check", file != null)
        return file?.readText()
    }

    private fun themeKt(): String =
        find(
            "src/main/java/com/karahoca/tracker/ui/theme/Theme.kt",
            "app/src/main/java/com/karahoca/tracker/ui/theme/Theme.kt",
            "android/app/src/main/java/com/karahoca/tracker/ui/theme/Theme.kt",
        )?.readText() ?: error("cannot locate Theme.kt from ${File(".").absolutePath}")

    private fun xmlColor(dir: String, name: String): String {
        val file = find("src/main/res/$dir/colors.xml", "app/src/main/res/$dir/colors.xml")
            ?: error("cannot locate res/$dir/colors.xml")
        val match = Regex("""<color name="$name">#([0-9A-Fa-f]{6})</color>""").find(file.readText())
            ?: error("$dir/colors.xml has no $name")
        return match.groupValues[1].uppercase()
    }

    /**
     * The custom properties inside one `:root` block, as uppercase RRGGBB.
     *
     * globals.css stores them as space-separated RGB triplets so Tailwind can
     * apply an alpha modifier — `--kh-brand: 20 96 200`. Anything that is not
     * exactly three integers (there is a `0 0 0 / 0` in there) is skipped.
     */
    private fun cssTokens(css: String, header: String): Map<String, String> {
        val start = css.indexOf(header)
        if (start < 0) return emptyMap()
        val open = css.indexOf('{', start)
        val close = css.indexOf("\n  }", open)
        val block = css.substring(open, if (close > 0) close else css.length)
        return Regex("""--kh-([a-z0-9-]+):\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})\s*;""")
            .findAll(block)
            .associate { m ->
                val (name, r, g, b) = m.destructured
                name to "%02X%02X%02X".format(r.toInt(), g.toInt(), b.toInt())
            }
    }

    /** `name = Color(0xFFRRGGBB)` pairs inside one declaration in Theme.kt. */
    private fun ktColors(kt: String, symbol: String): Map<String, String> {
        val start = kt.indexOf("val $symbol")
        if (start < 0) return emptyMap()
        val open = kt.indexOf('(', start)
        var depth = 0
        var close = kt.length - 1
        for (i in open until kt.length) {
            if (kt[i] == '(') depth++
            if (kt[i] == ')') {
                depth--
                if (depth == 0) { close = i; break }
            }
        }
        return Regex("""(\w+)\s*=\s*Color\(0x[Ff]{2}([0-9A-Fa-f]{6})\)""")
            .findAll(kt.substring(open, close))
            .associate { it.groupValues[1] to it.groupValues[2].uppercase() }
    }
}
