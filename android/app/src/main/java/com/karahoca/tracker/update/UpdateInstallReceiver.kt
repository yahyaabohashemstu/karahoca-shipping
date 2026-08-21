package com.karahoca.tracker.update

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.util.Log
import com.karahoca.tracker.service.TrackingNotification
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject

/**
 * What the platform installer says back.
 *
 * The interesting case is the first one. `commit()` does not install anything —
 * it asks the system, which comes back with STATUS_PENDING_USER_ACTION and an
 * Intent for the confirmation dialog that only we can launch. Miss it and the
 * update stalls forever with no error anywhere, which is exactly how a
 * self-updater ends up being reported as "the button does nothing".
 */
@AndroidEntryPoint
class UpdateInstallReceiver : BroadcastReceiver() {

    @Inject lateinit var notifications: TrackingNotification

    companion object {
        const val ACTION_STATUS = "com.karahoca.tracker.INSTALL_STATUS"
        private const val TAG = "KH/Installer"
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_STATUS) return

        val status = intent.getIntExtra(
            PackageInstaller.EXTRA_STATUS,
            PackageInstaller.STATUS_FAILURE,
        )
        val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)

        when (status) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                val confirm = confirmIntent(intent)
                if (confirm == null) {
                    Log.e(TAG, "Pending user action with no intent to show")
                    return
                }
                confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                /*
                 * Try to show it now, and fall back to a notification.
                 *
                 * Starting an activity from a receiver is only permitted while
                 * the app is visible. When the driver presses Update and stays
                 * on the screen, that holds and the dialog appears instantly.
                 * When they lock the phone and pocket it — which on a 24 MB
                 * download over a rural cell is the normal case — it does not,
                 * and the throw is silent. The notification turns the dialog
                 * into something they can reach whenever they next look.
                 */
                val shown = runCatching { context.startActivity(confirm) }.isSuccess
                if (!shown) {
                    Log.i(TAG, "Not visible — offering the install dialog as a notification")
                    notifications.updateConfirmInstall(confirm)
                }
            }

            PackageInstaller.STATUS_SUCCESS -> {
                // Rarely observed: replacing the package kills this process, so
                // the broadcast usually never lands. The new process clears the
                // notification from UpdateRepository.check() instead.
                Log.i(TAG, "Install reported success")
                notifications.clearUpdate()
            }

            else -> {
                Log.e(TAG, "Install failed: status=$status ${message.orEmpty()}")
                notifications.updateInstallFailed(describe(status, message))
            }
        }
    }

    @Suppress("DEPRECATION") // the typed overload is API 33+
    private fun confirmIntent(intent: Intent): Intent? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
        } else {
            intent.getParcelableExtra(Intent.EXTRA_INTENT)
        }

    /**
     * Something short enough for a notification and specific enough to act on.
     *
     * STATUS_FAILURE_ABORTED is the driver pressing Cancel, which is a choice
     * rather than a fault — saying "failed" at them for it would be wrong.
     */
    private fun describe(status: Int, message: String?): String? = when (status) {
        PackageInstaller.STATUS_FAILURE_ABORTED -> null
        PackageInstaller.STATUS_FAILURE_STORAGE -> "storage"
        PackageInstaller.STATUS_FAILURE_INCOMPATIBLE -> "incompatible"
        PackageInstaller.STATUS_FAILURE_CONFLICT -> "signature"
        PackageInstaller.STATUS_FAILURE_INVALID -> "invalid apk"
        PackageInstaller.STATUS_FAILURE_BLOCKED -> "blocked"
        else -> message?.take(80) ?: "status $status"
    }
}
