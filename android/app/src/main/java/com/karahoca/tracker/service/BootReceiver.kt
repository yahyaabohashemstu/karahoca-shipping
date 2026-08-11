package com.karahoca.tracker.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.karahoca.tracker.data.local.SessionStore
import com.karahoca.tracker.data.repository.TrackingRepository
import com.karahoca.tracker.sync.SyncScheduler
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * Resume an interrupted session after the phone reboots or the app is updated.
 *
 * Real scenarios this covers, all observed in field logistics:
 *
 *  - Battery dies on a long haul; the driver plugs in at a service station and
 *    the phone boots. Without this receiver, tracking silently never resumes
 *    and the rest of the route is lost.
 *  - The driver reboots to fix a frozen phone.
 *  - We push an app update mid-shift (MY_PACKAGE_REPLACED); Android stops every
 *    component of a replaced package.
 *
 * In all three the buffered points are still in SQLite. Restarting the service
 * both resumes acquisition and drains that backlog.
 */
@AndroidEntryPoint
class BootReceiver : BroadcastReceiver() {

    @Inject lateinit var store: SessionStore
    @Inject lateinit var repository: TrackingRepository
    @Inject lateinit var syncScheduler: SyncScheduler

    companion object {
        private const val TAG = "KH/Boot"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        Log.i(TAG, "Received $action")

        val relevant = action in setOf(
            Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_MY_PACKAGE_REPLACED,
            "android.intent.action.QUICKBOOT_POWERON",
            "com.htc.intent.action.QUICKBOOT_POWERON",
        )
        if (!relevant) return

        val pendingResult = goAsync()
        val appContext = context.applicationContext

        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            try {
                // Points can be waiting even when tracking is over — drain first,
                // unconditionally, before deciding whether to resume acquisition.
                syncScheduler.schedulePeriodic()
                syncScheduler.syncNow(expedited = false)

                if (!store.isTrackingActive() || store.sessionId() == null) {
                    Log.i(TAG, "No active session to resume")
                    return@launch
                }

                Log.w(TAG, "Resuming tracking session ${store.reference()} after $action")
                repository.recordLocalEvent(
                    type = "SERVICE_RESTORED",
                    message = when (action) {
                        Intent.ACTION_MY_PACKAGE_REPLACED -> "Resumed after app update"
                        else -> "Resumed after device reboot"
                    },
                )

                LocationTrackingService.start(appContext)
                ServiceWatchdog.schedule(appContext)
            } catch (e: Exception) {
                Log.e(TAG, "Boot resume failed", e)
            } finally {
                pendingResult.finish()
            }
        }
    }
}
