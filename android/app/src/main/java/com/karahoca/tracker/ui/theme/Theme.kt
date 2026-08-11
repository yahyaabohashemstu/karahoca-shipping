package com.karahoca.tracker.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext

private val LightColors = lightColorScheme(
    primary = Color(0xFF1D4ED8),
    onPrimary = Color.White,
    secondary = Color(0xFF0EA5E9),
    background = Color(0xFFF8FAFC),
    surface = Color.White,
    error = Color(0xFFDC2626),
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFF60A5FA),
    onPrimary = Color(0xFF0B1220),
    secondary = Color(0xFF38BDF8),
    background = Color(0xFF0B1220),
    surface = Color(0xFF111C33),
    error = Color(0xFFF87171),
)

@Composable
fun KaraHocaTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    /*
     * Dynamic colour is OFF by default.
     *
     * A driver glancing at this app in a moving truck needs the same green/amber
     * status colours on every phone in the fleet. Material You would recolour
     * them per device wallpaper, which is exactly wrong for a status tool.
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
    MaterialTheme(colorScheme = colors, content = content)
}
