package com.karahoca.tracker.sync

import android.content.Context
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import dagger.hilt.android.qualifiers.ApplicationContext
import java.util.concurrent.TimeUnit
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Owns every WorkManager enqueue in the app.
 *
 * Two complementary jobs:
 *
 *  • **Periodic (15 min)** — the floor. WorkManager's minimum interval. This is
 *    what keeps draining the buffer when our service has been killed and the
 *    watchdog has not fired yet. Survives reboots because WorkManager persists
 *    it and reschedules on BOOT_COMPLETED itself.
 *
 *  • **One-time expedited** — the ceiling. Fired when the pump notices we are
 *    back online, when the driver taps "sync now", and after boot. Expedited
 *    work runs almost immediately even in Doze, using the app's foreground-
 *    service quota, with a graceful fallback when that quota is exhausted.
 *
 * Both use `NetworkType.CONNECTED`, so neither ever runs — and neither ever
 * wakes the radio — while the truck is out of coverage. This is what makes
 * offline buffering cheap: we do not poll.
 */
@Singleton
class SyncScheduler @Inject constructor(
    @ApplicationContext private val context: Context,
) {

    companion object {
        private const val TAG = "KH/SyncScheduler"
        private const val PERIODIC_WORK = "karahoca-sync-periodic"
        private const val ONESHOT_WORK = "karahoca-sync-now"
    }

    private val workManager get() = WorkManager.getInstance(context)

    private val constraints = Constraints.Builder()
        .setRequiredNetworkType(NetworkType.CONNECTED)
        // Deliberately NOT requiring battery-not-low: a truck at 12% battery is
        // exactly when a dispatcher most needs the last known positions.
        .setRequiresBatteryNotLow(false)
        .setRequiresCharging(false)
        .setRequiresStorageNotLow(false)
        .build()

    fun schedulePeriodic() {
        val request = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
            .setConstraints(constraints)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .addTag(PERIODIC_WORK)
            .build()

        workManager.enqueueUniquePeriodicWork(
            PERIODIC_WORK,
            // KEEP, not UPDATE: re-enqueuing on every service start would reset
            // the period and could starve the job on a phone that restarts the
            // service often.
            ExistingPeriodicWorkPolicy.KEEP,
            request,
        )
        Log.d(TAG, "Periodic sync scheduled")
    }

    fun syncNow(expedited: Boolean) {
        val builder = OneTimeWorkRequestBuilder<SyncWorker>()
            .setConstraints(constraints)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS)
            .addTag(ONESHOT_WORK)

        if (expedited) {
            // RUN_AS_NON_EXPEDITED_WORK_REQUEST: if the expedited quota is spent,
            // downgrade instead of throwing. Never lose the enqueue.
            builder.setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
        }

        workManager.enqueueUniqueWork(
            ONESHOT_WORK,
            // APPEND_OR_REPLACE: while a sync is running, queue exactly one more
            // behind it. Prevents a burst of enqueues from stacking twenty
            // redundant passes.
            ExistingWorkPolicy.APPEND_OR_REPLACE,
            builder.build(),
        )
        Log.d(TAG, "Immediate sync enqueued (expedited=$expedited)")
    }

    fun cancelAll() {
        workManager.cancelUniqueWork(PERIODIC_WORK)
        workManager.cancelUniqueWork(ONESHOT_WORK)
        Log.d(TAG, "All sync work cancelled")
    }
}
