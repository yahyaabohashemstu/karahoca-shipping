package com.karahoca.tracker.sync

import android.content.Context
import android.util.Log
import androidx.hilt.work.HiltWorker
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import com.karahoca.tracker.data.local.SessionStore
import com.karahoca.tracker.data.repository.TrackingRepository
import com.karahoca.tracker.service.LocationTrackingService
import com.karahoca.tracker.service.ServiceWatchdog
import com.karahoca.tracker.service.TrackingNotification
import dagger.assisted.Assisted
import dagger.assisted.AssistedInject
import com.karahoca.tracker.R

/**
 * ============================================================================
 *  THE SYNC WORKER
 * ============================================================================
 *
 * The safety net behind the foreground service's realtime pump.
 *
 * The pump handles the happy path: online, service alive, push every 15 s. This
 * worker handles everything else, and WorkManager gives us three guarantees the
 * pump cannot:
 *
 *  1. **It survives our process.** Enqueued work is persisted in WorkManager's
 *     own database and runs after a reboot, an app update, or a force-stop
 *     followed by any app launch.
 *
 *  2. **It is woken by connectivity.** `NetworkType.CONNECTED` means the system
 *     starts us the moment a truck rolls back into coverage — we never poll for
 *     a signal, which is what would actually flatten the battery in a dead zone.
 *
 *  3. **It backs off correctly.** `Result.retry()` applies exponential backoff
 *     managed by the OS, respecting Doze windows instead of fighting them.
 *
 * The worker never decides that data is expendable. Every non-success path ends
 * in `retry()` or `success()` with the points still in SQLite.
 */
@HiltWorker
class SyncWorker @AssistedInject constructor(
    @Assisted appContext: Context,
    @Assisted params: WorkerParameters,
    private val repository: TrackingRepository,
    private val store: SessionStore,
    private val notifications: TrackingNotification,
) : CoroutineWorker(appContext, params) {

    companion object {
        private const val TAG = "KH/SyncWorker"
        const val KEY_UPLOADED = "uploaded"
        const val KEY_REMAINING = "remaining"
        const val KEY_REASON = "reason"
    }

    override suspend fun doWork(): Result {
        val sessionId = store.sessionId()
        if (sessionId == null) {
            Log.d(TAG, "No session — nothing to sync")
            return Result.success()
        }

        Log.i(TAG, "Sync pass starting (attempt ${runAttemptCount})")

        return when (val outcome = repository.syncAll()) {
            is TrackingRepository.SyncOutcome.Drained -> {
                Log.i(TAG, "Buffer drained")
                maybeStopServiceIfFinished()
                Result.success(workDataOf(KEY_REMAINING to 0))
            }

            is TrackingRepository.SyncOutcome.Progress -> {
                /*
                 * Progress but not done — usually the MAX_CHUNKS_PER_PASS guard
                 * on a very large backlog. Retry immediately rather than waiting
                 * for the next periodic run: the truck may only have coverage
                 * for another thirty seconds.
                 */
                Log.i(TAG, "Uploaded ${outcome.uploaded}, ${outcome.remaining} remaining")
                Result.retry()
            }

            is TrackingRepository.SyncOutcome.Retry -> {
                Log.w(TAG, "Retrying later: ${outcome.reason}")
                /*
                 * No give-up threshold on transient failures. A truck can be out
                 * of coverage for a whole day; WorkManager's backoff caps at
                 * 5 hours between attempts, which is exactly the behaviour we
                 * want. The buffer is bounded by rows, not by attempts.
                 */
                Result.retry()
            }

            is TrackingRepository.SyncOutcome.SessionClosed -> {
                Log.w(TAG, "Session closed server-side: ${outcome.status}")
                handleSessionClosed(outcome.status)
                /*
                 * success(), not failure(): the session is over and there is
                 * nothing to retry. Anything still buffered was already rejected
                 * by the server and would be rejected again.
                 */
                Result.success(workDataOf(KEY_REASON to outcome.status))
            }

            is TrackingRepository.SyncOutcome.Unauthorised -> {
                Log.e(TAG, "Credentials rejected — driver must re-claim")
                notifications.alert(
                    title = applicationContext.getString(R.string.alert_session_ended_title),
                    body = applicationContext.getString(R.string.alert_session_ended_body),
                )
                store.setTrackingActive(false)
                ServiceWatchdog.cancel(applicationContext)
                LocationTrackingService.stop(applicationContext)
                Result.success(workDataOf(KEY_REASON to "UNAUTHORISED"))
            }
        }
    }

    private suspend fun handleSessionClosed(status: String) {
        notifications.alert(
            title = applicationContext.getString(R.string.alert_shipment_done_title),
            body = applicationContext.getString(R.string.alert_shipment_done_body, status),
        )
        store.setTrackingActive(false)
        ServiceWatchdog.cancel(applicationContext)
        stopServiceIfRunning()
    }

    /**
     * If the driver stopped tracking and the buffer is now empty, there is no
     * reason to keep a foreground service and its wake lock alive.
     *
     * The isServiceRunning guard is essential, not defensive.
     * `LocationTrackingService.stop()` sends its intent with `startService()`,
     * which CREATES the service if it is dead. The fresh instance handled
     * ACTION_STOP, ran a full driver-initiated shutdown, and enqueued another
     * expedited sync — which landed right back here. That loop was reachable
     * from the ordinary end-of-shipment flow (dispatcher closes the session),
     * not just from the driver tapping Stop, and it only terminated when the
     * battery did.
     */
    private suspend fun maybeStopServiceIfFinished() {
        if (store.isTrackingActive()) return
        if (!ServiceWatchdog.isServiceRunning(applicationContext)) return
        LocationTrackingService.stop(applicationContext)
    }

    /** Stop the service only when one actually exists. See above. */
    private fun stopServiceIfRunning() {
        if (ServiceWatchdog.isServiceRunning(applicationContext)) {
            LocationTrackingService.stop(applicationContext)
        }
    }
}
