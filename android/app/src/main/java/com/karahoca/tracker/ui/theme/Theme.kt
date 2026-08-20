package com.karahoca.tracker.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/* =============================================================================
   One design, on the fourth surface
   =============================================================================
   The dispatcher's dashboard, the consignee's tracking page and the two driver
   web pages are all built from one set of values. This app was not: it carried
   a palette of its own — #1D4ED8, #0EA5E9, #0B1220, #111C33 — that shared not a
   single colour with anything else KaraHoca puts on a screen, plus seven more
   hexes written inline in MainActivity for the status icons.

   Everything below is those same values, transcribed from
   apps/web/src/app/globals.css. Where that file writes `--kh-brand: 20 96 200`
   this writes 0xFF1460C8. They are the same colour and they must stay the same
   colour: a dispatcher and the driver they are talking to should be looking at
   one product, and the dispatcher's "Duraklatıldı" orange has to be the
   driver's too.

   Two things Material 3 has no slot for are carried separately:

   STATUS. Live, delayed and lost are domain states, not theme roles. Material's
   `error` is the closest and it is wrong — a lorry that has gone quiet is not
   an error, it is a lorry in a tunnel. They were inline hexes before, which is
   why the "satisfied" green in the readiness list was a different green from
   the "online" green two screens later.

   THE HAIRLINE. Every floating panel in this product carries one pixel of light
   along its top edge. It is what separates a raised sheet from a rectangle of
   fog, and there is nowhere in a ColorScheme to put it.
   ========================================================================== */

// ---------------------------------------------------------------- light ramp
private val LightColors = lightColorScheme(
    primary = Color(0xFF1460C8),          // --kh-brand
    onPrimary = Color(0xFFFFFFFF),        // --kh-text-inverse
    primaryContainer = Color(0xFFE2EDFD), // --kh-brand-soft
    onPrimaryContainer = Color(0xFF124CA0), // --kh-brand-text
    secondary = Color(0xFF1050AA),        // --kh-brand-hover
    onSecondary = Color(0xFFFFFFFF),
    secondaryContainer = Color(0xFFE2EDFD),
    onSecondaryContainer = Color(0xFF124CA0),
    tertiary = Color(0xFF057A55),         // --kh-live
    onTertiary = Color(0xFFFFFFFF),
    tertiaryContainer = Color(0xFFD6F5E8), // --kh-live-bg
    onTertiaryContainer = Color(0xFF04553B),

    background = Color(0xFFF7F9F9),       // --kh-bg
    onBackground = Color(0xFF0E171B),     // --kh-text
    surface = Color(0xFFFFFFFF),          // --kh-surface
    onSurface = Color(0xFF0E171B),
    surfaceVariant = Color(0xFFF0F3F4),   // --kh-surface-2
    onSurfaceVariant = Color(0xFF54646B), // --kh-text-2
    surfaceContainerLowest = Color(0xFFFFFFFF),
    surfaceContainerLow = Color(0xFFF7F9F9),
    surfaceContainer = Color(0xFFF0F3F4),
    surfaceContainerHigh = Color(0xFFE7ECED), // --kh-surface-3
    surfaceContainerHighest = Color(0xFFE7ECED),

    outline = Color(0xFFC1CACC),          // --kh-border-strong
    outlineVariant = Color(0xFFDEE4E5),   // --kh-border

    error = Color(0xFFBE1C1C),            // --kh-danger
    onError = Color(0xFFFFFFFF),
    errorContainer = Color(0xFFFEE9E9),   // --kh-danger-bg
    onErrorContainer = Color(0xFF8E1414),

    scrim = Color(0xFF0E171B),
)

// ----------------------------------------------------------------- dark ramp
/*
 * Authored separately, not derived. The dark theme is not a filter over the
 * light one: the surfaces that read as "quiet grey" on white read as "muddy"
 * inverted, and every accent is lifted in lightness and dropped in saturation
 * or it vibrates against a dark background. Same reasoning, same numbers, as
 * the note at the top of globals.css.
 */
private val DarkColors = darkColorScheme(
    primary = Color(0xFF5298FF),
    onPrimary = Color(0xFF0B1012),
    primaryContainer = Color(0xFF142742),
    onPrimaryContainer = Color(0xFF8AB8FF),
    secondary = Color(0xFF78AFFF),
    onSecondary = Color(0xFF0B1012),
    secondaryContainer = Color(0xFF142742),
    onSecondaryContainer = Color(0xFF8AB8FF),
    tertiary = Color(0xFF5EE2AD),
    onTertiary = Color(0xFF0B1012),
    tertiaryContainer = Color(0xFF0A3327),
    onTertiaryContainer = Color(0xFF5EE2AD),

    background = Color(0xFF0B1012),
    onBackground = Color(0xFFE8EFF1),
    surface = Color(0xFF12191C),
    onSurface = Color(0xFFE8EFF1),
    surfaceVariant = Color(0xFF192226),
    onSurfaceVariant = Color(0xFF9EB0B7),
    surfaceContainerLowest = Color(0xFF0B1012),
    surfaceContainerLow = Color(0xFF12191C),
    surfaceContainer = Color(0xFF192226),
    surfaceContainerHigh = Color(0xFF212C31),
    surfaceContainerHighest = Color(0xFF212C31),

    outline = Color(0xFF394A51),
    outlineVariant = Color(0xFF263237),

    error = Color(0xFFFF8A8A),
    onError = Color(0xFF0B1012),
    errorContainer = Color(0xFF3C1212),
    onErrorContainer = Color(0xFFFF8A8A),

    scrim = Color(0xFF000000),
)

/**
 * The domain's own colours, which Material has nowhere to put.
 *
 * `live`, `warn` and `danger` are the text/icon tints; the `*Container` values
 * are the tinted backing behind them. Both are needed: a coloured icon on a
 * plain surface is not enough to find while glancing at a phone in a cradle,
 * and a filled block with no icon is not enough for a driver who cannot
 * distinguish the hues.
 */
@Immutable
data class StatusColors(
    val live: Color,
    val liveContainer: Color,
    val warn: Color,
    val warnContainer: Color,
    val danger: Color,
    val dangerContainer: Color,
    /** One pixel of light along a raised edge. */
    val hairline: Color,
    val brandStart: Color,
    val brandEnd: Color,
) {
    /** The monogram's fill, the same 135° sweep the web mark uses. */
    val brandGradient: Brush get() = Brush.linearGradient(listOf(brandStart, brandEnd))
}

private val LightStatus = StatusColors(
    live = Color(0xFF057A55),           // --kh-live
    liveContainer = Color(0xFFD6F5E8),  // --kh-live-bg
    warn = Color(0xFF92400E),           // --kh-delayed
    warnContainer = Color(0xFFFDF0CD),  // --kh-delayed-bg
    danger = Color(0xFFBE1C1C),
    dangerContainer = Color(0xFFFEE9E9),
    hairline = Color(0xB3FFFFFF),
    brandStart = Color(0xFF1460C8),
    brandEnd = Color(0xFF1050AA),
)

private val DarkStatus = StatusColors(
    live = Color(0xFF5EE2AD),
    liveContainer = Color(0xFF0A3327),
    warn = Color(0xFFFACC6C),
    warnContainer = Color(0xFF3E2B08),
    danger = Color(0xFFFF8A8A),
    dangerContainer = Color(0xFF3C1212),
    hairline = Color(0x12FFFFFF),
    brandStart = Color(0xFF5298FF),
    brandEnd = Color(0xFF78AFFF),
)

private val LocalStatusColors = staticCompositionLocalOf { DarkStatus }

/** `MaterialTheme.status.live` — reads like the rest of the theme. */
val MaterialTheme.status: StatusColors
    @Composable @ReadOnlyComposable get() = LocalStatusColors.current

/**
 * Two radius families, the same split the web design makes.
 *
 * `extraSmall` and `small` are controls — chips, buttons, fields. `medium` and
 * up are containers. A 16dp radius on a 36dp chip turns it into a lozenge; a
 * 6dp radius on a full-width card makes it look like a table cell. Material's
 * defaults sit between the two and commit to neither.
 */
private val KaraHocaShapes = Shapes(
    extraSmall = RoundedCornerShape(6.dp),
    small = RoundedCornerShape(10.dp),
    medium = RoundedCornerShape(14.dp),
    large = RoundedCornerShape(18.dp),
    extraLarge = RoundedCornerShape(22.dp),
)

/**
 * Material's scale, with the headlines pulled tighter.
 *
 * Only tracking changes. Compose's default headline styles are set for reading
 * prose at arm's length; the headlines in this app are two or three words on a
 * phone in a windscreen cradle, and at that size default tracking reads as
 * loose. Everything else is left alone deliberately — this is a driver's app,
 * not a place to invent a type scale.
 */
private val KaraHocaTypography = Typography().run {
    copy(
        headlineLarge = headlineLarge.copy(letterSpacing = (-0.8).sp),
        headlineMedium = headlineMedium.copy(letterSpacing = (-0.6).sp),
        headlineSmall = headlineSmall.copy(letterSpacing = (-0.4).sp),
        titleLarge = titleLarge.copy(letterSpacing = (-0.2).sp),
    )
}

@Composable
fun KaraHocaTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    /*
     * Dynamic colour is OFF by default.
     *
     * A driver glancing at this app in a moving truck needs the same status
     * colours on every phone in the fleet, and the dispatcher on the telephone
     * needs to be looking at the same ones. Material You would recolour them
     * per device wallpaper, which is exactly wrong for a status tool — and now
     * that this palette is shared with three other surfaces, it would put one
     * of the four out of step with the rest on every handset.
     */
    dynamicColor: Boolean = false,
    content: @Composable () -> Unit,
) {
    val context = LocalContext.current
    val colors = when {
        dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ->
            if (darkTheme) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
        darkTheme -> DarkColors
        else -> LightColors
    }
    /*
     * The status colours follow the light/dark choice, not the dynamic one.
     *
     * If somebody turns dynamic colour on, the chrome may follow the wallpaper
     * but "the GPS is reporting" must not: it is the one thing on the screen
     * that means something specific.
     */
    CompositionLocalProvider(LocalStatusColors provides if (darkTheme) DarkStatus else LightStatus) {
        MaterialTheme(
            colorScheme = colors,
            shapes = KaraHocaShapes,
            typography = KaraHocaTypography,
            content = content,
        )
    }
}
