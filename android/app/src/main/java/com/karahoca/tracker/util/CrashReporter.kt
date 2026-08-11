package com.karahoca.tracker.util

import android.content.Context
import android.os.Build
import android.util.Log
import com.karahoca.tracker.BuildConfig
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Persists uncaught exceptions to a file on the device.
 *
 * This is not a debugging convenience — it is a field requirement. The people
 * running this app are third-party drivers with no USB cable, no adb, and no
 * reason to care. When the app dies on their phone, "it closed by itself" is
 * the entire bug report we would otherwise receive, and the process is gone
 * before it can upload anything.
 *
 * The trace is written to the app-specific external directory, which needs no
 * runtime permission and is reachable over MTP or any file manager at:
 *
 *     Android/data/com.karahoca.tracker[.debug]/files/crash/
 *
 * Writing happens on the dying thread, synchronously and with no allocation of
 * anything that could itself fail — no coroutines, no Room, no network. The
 * default handler is always invoked afterwards so the platform still records
 * the crash normally.
 */
object CrashReporter {

    private const val TAG = "KH/Crash"
    private const val DIR = "crash"
    private const val MAX_FILES = 20

    fun install(context: Context) {
        val appContext = context.applicationContext
        val previous = Thread.getDefaultUncaughtExceptionHandler()

        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            // Never let the reporter itself prevent the platform handler from
            // running — a crash inside the crash handler is an ANR-shaped
            // disaster that hides the original fault.
            runCatching { write(appContext, thread, error) }
                .onFailure { Log.e(TAG, "Could not persist the crash report", it) }
            previous?.uncaughtException(thread, error)
        }
        Log.i(TAG, "Crash reporter installed -> ${dir(appContext)?.absolutePath}")
    }

    private fun dir(context: Context): File? =
        context.getExternalFilesDir(null)?.let { File(it, DIR).apply { mkdirs() } }
            ?: File(context.filesDir, DIR).apply { mkdirs() }

    private fun write(context: Context, thread: Thread, error: Throwable) {
        val target = dir(context) ?: return
        val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())

        val trace = StringWriter().also { error.printStackTrace(PrintWriter(it)) }.toString()

        val report = buildString {
            appendLine("KaraHoca Takip — crash report")
            appendLine("time        : ${Date()}")
            appendLine("app         : ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE}) ${BuildConfig.BUILD_TYPE}")
            appendLine("applicationId: ${BuildConfig.APPLICATION_ID}")
            appendLine("api base    : ${BuildConfig.DEFAULT_API_BASE_URL}")
            appendLine("device      : ${Build.MANUFACTURER} ${Build.MODEL}")
            appendLine("android     : ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})")
            appendLine("thread      : ${thread.name}")
            appendLine()
            append(trace)
        }

        File(target, "crash-$stamp.txt").writeText(report)
        // Stable filename so support can always ask for the same thing.
        File(target, "last-crash.txt").writeText(report)

        // Keep the directory bounded; a crash loop must not fill the phone.
        target.listFiles { f -> f.name.startsWith("crash-") }
            ?.sortedByDescending { it.lastModified() }
            ?.drop(MAX_FILES)
            ?.forEach { it.delete() }

        Log.e(TAG, "Crash persisted to ${target.absolutePath}\\crash-$stamp.txt")
    }

    /** The most recent report, if any — surfaced in the UI so it can be shared. */
    fun lastReport(context: Context): String? =
        dir(context)?.let { File(it, "last-crash.txt") }
            ?.takeIf { it.exists() && it.length() > 0 }
            ?.readText()

    fun clear(context: Context) {
        dir(context)?.listFiles()?.forEach { it.delete() }
    }
}
