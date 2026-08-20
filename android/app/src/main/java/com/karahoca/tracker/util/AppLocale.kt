package com.karahoca.tracker.util

import android.app.LocaleManager
import android.content.Context
import android.content.res.Configuration
import android.os.Build
import android.os.LocaleList
import java.util.Locale

/**
 * The driver's choice of language, and how it reaches every screen.
 *
 * This deliberately does not use AppCompatDelegate.setApplicationLocales, which
 * is the obvious API and which silently does nothing in this app. Worth writing
 * down, because it cost a day and looked like a UI bug:
 *
 *   AppCompatDelegate reaches the platform through getLocaleManagerForApplication(),
 *   which walks sActivityDelegates — the set of live delegates, populated only
 *   by AppCompatActivity. This app's only activity is a ComponentActivity, so
 *   that set is permanently empty, the lookup returns null, and both calls take
 *   their null branch: the setter becomes a no-op and the getter always answers
 *   "empty". Neither logs, neither throws, neither returns a failure. The picker
 *   rendered, highlighted "phone language" forever, and changed nothing.
 *
 * Declaring android:localeConfig is not a substitute either. It only adds an
 * entry under Settings > Apps > Language — three levels into the settings of a
 * phone whose own language the driver cannot read, which is the exact situation
 * this feature exists for — and it only exists on Android 13, while minSdk here
 * is 26.
 *
 * So the app owns the choice:
 *
 *   The store is SharedPreferences. Synchronous, so attachBaseContext can read
 *   it before a single string resolves, and present on every API level.
 *
 *   On API 33+ the choice is also written straight to the platform LocaleManager
 *   — the real one, not through AppCompat. That keeps the in-app picker and the
 *   system settings entry from disagreeing, and lets the platform apply the
 *   locale itself, which it does for a ComponentActivity perfectly well.
 *
 *   On API 26–32 there is no platform mechanism, so [wrap] is the whole of it.
 */
object AppLocale {

    /** BCP-47 tags this app ships. Empty string means "follow the phone". */
    const val SYSTEM = ""
    const val TURKISH = "tr"
    const val ARABIC = "ar"
    const val KURMANJI = "ku"

    private const val PREFS = "app_locale"
    private const val KEY_TAG = "tag"

    /**
     * The three languages, each named in its own.
     *
     * A picker that offers "Arapça" is no use to somebody who cannot read
     * Turkish, which is precisely the population the list exists for — so these
     * four labels are the one place in the app where an untranslated string is
     * correct, and they are exempt from the localisation guard for that reason.
     *
     * "Let the phone decide" is NOT one of them, and used to be: the list
     * opened with `SYSTEM to "Telefon dili"`, which is not a language name but
     * a Turkish sentence, sitting in a row with three names an Arabic reader
     * can read and one they cannot. It is a string resource now and the picker
     * prepends it — see LanguagePicker in MainActivity.
     */
    val options: List<Pair<String, String>> = listOf(
        TURKISH to "Türkçe",
        ARABIC to "العربية",
        KURMANJI to "Kurdî",
    )

    /**
     * The chosen tag, or [SYSTEM] when the phone decides.
     *
     * On API 33+ the platform is asked first and its answer wins. That is not
     * redundancy: a driver can also change this from system settings, or a
     * previous driver on a shared handset can have left a choice behind, and in
     * both cases the platform knows something the preference file does not.
     */
    fun current(context: Context): String {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val fromPlatform = runCatching {
                context.getSystemService(LocaleManager::class.java)
                    ?.applicationLocales
                    ?.takeUnless { it.isEmpty }
                    ?.get(0)
                    ?.language
            }.getOrNull()
            if (fromPlatform != null) return fromPlatform
        }
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_TAG, SYSTEM)
            ?: SYSTEM
    }

    /**
     * Change it.
     *
     * commit(), not apply(): the caller recreates the activity on the next line
     * and attachBaseContext will read this back within milliseconds, well
     * inside the window an asynchronous write can still be in flight.
     */
    fun set(context: Context, tag: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_TAG, tag)
            .commit()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            runCatching {
                context.getSystemService(LocaleManager::class.java)?.applicationLocales =
                    if (tag == SYSTEM) LocaleList.getEmptyLocaleList()
                    else LocaleList.forLanguageTags(tag)
            }
        }
    }

    /**
     * A context that resolves resources in the chosen language.
     *
     * Returning [base] untouched when nothing is chosen is deliberate, and not
     * just a shortcut: a context built by createConfigurationContext carries a
     * frozen Configuration, so wrapping unconditionally would also freeze font
     * scale, dark mode and orientation at whatever they were at attach time.
     * Following the phone means staying out of the way entirely.
     */
    fun wrap(base: Context): Context {
        val tag = current(base)
        if (tag == SYSTEM) return base

        val locale = Locale.forLanguageTag(tag)
        Locale.setDefault(locale)
        val config = Configuration(base.resources.configuration).apply {
            setLocale(locale)
            // setLocales as well, or a phone with several system languages can
            // fall through ours and resolve a string from the second one.
            setLocales(LocaleList(locale))
        }
        return base.createConfigurationContext(config)
    }
}
