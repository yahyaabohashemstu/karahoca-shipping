package com.karahoca.tracker.update

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import dagger.hilt.android.qualifiers.ApplicationContext
import java.io.File
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Hand a downloaded APK to the platform installer.
 *
 * Uses the PackageInstaller session API rather than the older
 * `ACTION_VIEW` + `application/vnd.android.package-archive` intent, for three
 * reasons that all matter on a phone we cannot reach:
 *
 *  - no FileProvider and no content URI grant to get wrong;
 *  - the result comes back on a callback, so a refused or failed install is
 *    something the app can tell the driver about rather than a dialog that
 *    silently closed;
 *  - `setAppPackageName` lets the platform reject a mismatched package before
 *    the driver is ever shown a confirmation.
 *
 * Nothing here can install a *different* app. Android requires the new APK to
 * be signed by the same key as the installed one, so the worst a tampered
 * manifest can achieve is a failed install — see the sha256 check in
 * [UpdateRepository] for the layer above that.
 */
@Singleton
class UpdateInstaller @Inject constructor(
    @ApplicationContext private val context: Context,
) {

    /**
     * Android 8 made "install unknown apps" a per-app permission.
     *
     * Declaring REQUEST_INSTALL_PACKAGES is not enough — the driver has to
     * grant it once, in Settings, and there is no in-app dialog for it. The
     * only thing the app can do is send them to the right screen, which is
     * what [unknownSourcesIntent] is for.
     */
    fun canInstall(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.O ||
            context.packageManager.canRequestPackageInstalls()

    fun unknownSourcesIntent(): Intent =
        Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES)
            .setData(Uri.parse("package:${context.packageName}"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    /**
     * Stream the APK into a session and commit it.
     *
     * Throws rather than returning a result: every caller is already inside a
     * runCatching that turns a failure into a message on the banner, and an
     * ignored Boolean here would be a silent no-op on the one path the driver
     * is actively waiting on.
     */
    fun install(apk: File) {
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(
            PackageInstaller.SessionParams.MODE_FULL_INSTALL,
        ).apply {
            setAppPackageName(context.packageName)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED)
            }
        }

        val sessionId = installer.createSession(params)
        try {
            installer.openSession(sessionId).use { session ->
                // The length is passed so the platform can pre-allocate and can
                // detect a short write; -1 would work but loses that check.
                session.openWrite(APK_NAME, 0, apk.length()).use { out ->
                    apk.inputStream().use { it.copyTo(out, DEFAULT_BUFFER_SIZE) }
                    session.fsync(out)
                }
                session.commit(statusIntentSender(sessionId))
            }
            Log.i(TAG, "Install session $sessionId committed")
        } catch (e: Exception) {
            // An abandoned session frees its staged copy of the APK. Leaked
            // sessions survive reboots and each one holds 24 MB.
            runCatching { installer.abandonSession(sessionId) }
            throw e
        }
    }

    /**
     * Where the platform reports back to.
     *
     * FLAG_MUTABLE from API 31: the system fills the confirmation intent into
     * this PendingIntent, so an immutable one arrives empty and the install
     * stalls at "waiting for user action" with nothing to show the user.
     */
    private fun statusIntentSender(sessionId: Int): android.content.IntentSender {
        val intent = Intent(context, UpdateInstallReceiver::class.java)
            .setAction(UpdateInstallReceiver.ACTION_STATUS)
        var flags = PendingIntent.FLAG_UPDATE_CURRENT
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            flags = flags or PendingIntent.FLAG_MUTABLE
        }
        return PendingIntent.getBroadcast(context, sessionId, intent, flags).intentSender
    }

    private companion object {
        const val TAG = "KH/Installer"
        const val APK_NAME = "base.apk"
    }
}
