package com.karahoca.tracker.service

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.SystemClock
import android.util.Log
import androidx.core.content.getSystemService
import com.karahoca.tracker.data.local.SessionStore
import com.karahoca.tracker.data.repository.TrackingRepository
import com.karahoca.tracker.util.DeviceInfoProvider
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import javax.inject.Inject
import com.karahoca.tracker.R

/**
 * The resurrection mechanism.
 *
 * Everything else in this app assumes our process is alive. This is the part
 * that assumes it is not.
 *
 * Aggressive OEM power managers — MIUI, EMUI/HarmonyOS, ColorOS, FuntouchOS,
 * One UI "Put unused apps to sleep" — kill foreground services outright, with
 * no `onDestroy`, no callback, no signal of any kind. Nothing running inside
 * the process can notice its own death. The only reliable recovery is a timer
 * held by the *system*, outside our process, that periodically asks: "is the
 * service running, and should it be?"
 *
 * `setExactAndAllowWhileIdle` is the specific API that fires during Doze. The
 * inexact variants are batched into Doze maintenance windows, which on a phone
 * in a pocket can be an hour apart — an hour of a truck being invisible.
 */
object ServiceWatchdog {

    private const val TAG = "KH/Watchdog"
    private const val REQUEST_HEARTBEAT = 9001
    private const val REQUEST_IMMEDIATE = 9002

    /** Frequent enough to bound a gap to ~5 min; rare enough to be invisible on battery. */
    private const val HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000L

    /** After a swipe-away, come back fast enough that the driver never notices. */
    private const val IMMEDIATE_RESTART_DELAY_MS = 2_000L

    fun schedule(context: Context) {
        val alarms = context.getSystemService<AlarmManager>() ?: return
        val pending = heartbeatIntent(context)
        val triggerAt = SystemClock.elapsedRealtime() + HEARTBEAT_INTERVAL_MS

        /*
         * Android 12+ gates exact alarms behind SCHEDULE_EXACT_ALARM, which the
         * user grants in Settings. If it is not granted we degrade to
         * setAndAllowWhileIdle: still Doze-piercing, but the system may delay
         * it by up to ~9 minutes. Degraded is much better than absent, and the
         * onboarding flow nags for the exact-alarm grant.
         */
        val canExact = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarms.canScheduleExactAlarms()

        runCatching {
            if (canExact) {
                alarms.setExactAndAllowWhileIdle(
                    AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pending,
                )
            } else {
                alarms.setAndAllowWhileIdle(
                    AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pending,
                )
            }
        }.onFailure { Log.e(TAG, "Failed to schedule heartbeat", it) }

        Log.d(TAG, "Heartbeat armed (+${HEARTBEAT_INTERVAL_MS / 1000}s, exact=$canExact)")
    }

    fun scheduleImmediateRestart(context: Context) {
        val alarms = context.getSystemService<AlarmManager>() ?: return
        val triggerAt = SystemClock.elapsedRealtime() + IMMEDIATE_RESTART_DELAY_MS
        val canExact = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarms.canScheduleExactAlarms()
        runCatching {
            if (canExact) {
                alarms.setExactAndAllowWhileIdle(
                    AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, immediateIntent(context),
                )
            } else {
                alarms.setAndAllowWhileIdle(
                    AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, immediateIntent(context),
                )
            }
        }.onFailure { Log.e(TAG, "Failed to schedule immediate restart", it) }
    }

    fun cancel(context: Context) {
        val alarms = context.getSystemService<AlarmManager>() ?: return
        alarms.cancel(heartbeatIntent(context))
        alarms.cancel(immediateIntent(context))
        Log.d(TAG, "Watchdog cancelled")
    }

    private fun heartbeatIntent(context: Context) = PendingIntent.getBroadcast(
        context,
        REQUEST_HEARTBEAT,
        Intent(context, WatchdogReceiver::class.java).setAction(WatchdogReceiver.ACTION_HEARTBEAT),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    /**
     * Is the service currently instantiated?
     *
     * Shared with SyncWorker, which must NOT send a stop intent to a service
     * that is not running: `LocationTrackingService.stop()` uses
     * `startService()`, which would create the very service it is trying to
     * stop.
     *
     * `getRunningServices` is deprecated for inspecting *other* apps but still
     * reports our own, and it is the only synchronous answer available to a
     * freshly recreated process.
     */
    @Suppress("DEPRECATION")
    fun isServiceRunning(context: Context): Boolean {
        val manager = context.getSystemService<android.app.ActivityManager>() ?: return false
        return manager.getRunningServices(Int.MAX_VALUE).any {
            it.service.className == LocationTrackingService::class.java.name
        }
    }

    private fun immediateIntent(context: Context) = PendingIntent.getBroadcast(
        context,
        REQUEST_IMMEDIATE,
        Intent(context, WatchdogReceiver::class.java).setAction(WatchdogReceiver.ACTION_RESTART),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
}

/**
 * Receives the watchdog alarm.
 *
 * A BroadcastReceiver runs even when our process was killed — the system
 * recreates the process just to deliver the broadcast. That is the whole trick:
 * this code runs precisely in the situation where nothing else of ours can.
 */
@AndroidEntryPoint
class WatchdogReceiver : BroadcastReceiver() {

    @Inject lateinit var store: SessionStore
    @Inject lateinit var repository: TrackingRepository
    @Inject lateinit var deviceInfo: DeviceInfoProvider
    @Inject lateinit var notifications: TrackingNotification

    companion object {
        private const val TAG = "KH/WatchdogRx"
        const val ACTION_HEARTBEAT = "com.karahoca.tracker.HEARTBEAT"
        const val ACTION_RESTART = "com.karahoca.tracker.RESTART"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val pendingResult = goAsync()
        val appContext = context.applicationContext
        Log.i(TAG, "Watchdog fired: ${intent.action}")

        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            try {
                if (!store.isTrackingActive()) {
                    Log.d(TAG, "Tracking is not active — standing down")
                    ServiceWatchdog.cancel(appContext)
                    return@launch
                }

                /*
                 * Restarting a service that provably cannot get a fix burns
                 * battery and produces nothing. This is the one failure the
                 * architecture cannot self-heal, so stop the alarm chain and
                 * tell the driver instead of looping.
                 *
                 * TRACKING_ACTIVE deliberately stays true: opening the app and
                 * re-granting resumes the session with its buffer intact.
                 */
                if (!deviceInfo.hasForegroundLocation()) {
                    Log.e(TAG, "Location permission revoked — halting the restart chain")
                    repository.recordLocalEvent(
                        type = "PERMISSION_REVOKED",
                        message = "Watchdog halted: ACCESS_FINE_LOCATION is not granted",
                    )
                    notifications.alert(
                        title = context.getString(R.string.alert_permission_revoked_title),
                        body = context.getString(R.string.alert_permission_revoked_body),
                    )
                    ServiceWatchdog.cancel(appContext)
                    return@launch
                }

                if (ServiceWatchdog.isServiceRunning(appContext)) {
                    Log.d(TAG, "Service alive — checking that it is actually producing fixes")
                    /*
                     * "The service object exists" is not "the service works".
                     * A missing background-location grant, a Play Services
                     * rejection or a wedged fused client all present as
                     * alive-and-producing-nothing. LAST_FIX_AT was already
                     * being written on every fix and never once compared to now.
                     */
                    val status = store.status()
                    val staleAfter = maxOf(store.policy().idleIntervalMs * 5, 10 * 60_000L)
                    val silentMs = System.currentTimeMillis() - status.lastFixAt
                    if (status.lastFixAt > 0 && silentMs > staleAfter) {
                        Log.e(TAG, "No fix for ${silentMs / 1000}s — forcing re-registration")
                        repository.recordLocalEvent(
                            type = "GPS_LOST",
                            message = "No fix for ${silentMs / 1000}s; re-registering the location request",
                        )
                        // RELOAD_POLICY rather than stop/start: re-registers the
                        // fused request without tearing down the service or its
                        // buffer.
                        LocationTrackingService.reloadPolicy(appContext)
                    }
                } else {
                    Log.w(TAG, "SERVICE IS DEAD — restarting")
                    // The gap is recorded from the device side so a dispatcher
                    // can see "the OEM killed us at 14:02" rather than guessing.
                    runCatching {
                        LocationTrackingService.start(appContext)
                    }.onFailure { Log.e(TAG, "Restart failed", it) }
                }

                // Always re-arm: setExactAndAllowWhileIdle is one-shot.
                ServiceWatchdog.schedule(appContext)
            } finally {
                pendingResult.finish()
            }
        }
    }

}
