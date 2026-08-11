package com.karahoca.tracker

import android.app.Application
import android.content.Context
import android.util.Log
import androidx.hilt.work.HiltWorkerFactory
import androidx.work.Configuration
import com.karahoca.tracker.data.local.SessionStore
import com.karahoca.tracker.service.LocationTrackingService
import com.karahoca.tracker.service.ServiceWatchdog
import com.karahoca.tracker.sync.NetworkMonitor
import com.karahoca.tracker.sync.SyncScheduler
import com.karahoca.tracker.util.CrashReporter
import dagger.hilt.android.HiltAndroidApp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltAndroidApp
class TrackerApplication : Application(), Configuration.Provider {

    @Inject lateinit var workerFactory: HiltWorkerFactory
    @Inject lateinit var sessionStore: SessionStore
    @Inject lateinit var syncScheduler: SyncScheduler
    @Inject lateinit var networkMonitor: NetworkMonitor

    private val appScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override val workManagerConfiguration: Configuration
        get() = Configuration.Builder()
            .setWorkerFactory(workerFactory)
            .setMinimumLoggingLevel(if (BuildConfig.DEBUG) Log.DEBUG else Log.INFO)
            .build()

    /**
     * Earliest point at which a Context exists. Installing the crash reporter
     * here — before Hilt injection in super.onCreate() — means a failure during
     * dependency-graph construction is captured too, which is exactly the class
     * of crash that otherwise leaves nothing behind but "it closed by itself".
     */
    override fun attachBaseContext(base: Context) {
        super.attachBaseContext(base)
        runCatching { CrashReporter.install(base) }
    }

    override fun onCreate() {
        super.onCreate()

        /*
         * Application.onCreate runs on EVERY process start — including the ones
         * the system triggers purely to deliver a broadcast to our watchdog or
         * boot receiver. That makes it the right place for a self-heal check:
         * if the persisted flag says we should be tracking and we are not, the
         * process has just been resurrected and something killed the service.
         */
        appScope.launch {
            /*
             * Each step is independently guarded.
             *
             * appScope is a plain CoroutineScope with no exception handler, so
             * anything thrown here reaches the platform's default handler and
             * kills the process during startup. None of this work is worth the
             * app: failing to register a network callback should degrade
             * connectivity detection, not prevent the driver from tracking.
             */
            runCatching { networkMonitor.startMonitoring() }
                .onFailure { Log.e(TAG, "Network monitoring unavailable", it) }

            // Unconditional: a buffer can hold points from a session that has
            // already ended, and they still have to reach the server.
            runCatching { syncScheduler.schedulePeriodic() }
                .onFailure { Log.e(TAG, "Could not schedule periodic sync", it) }

            runCatching {
                if (sessionStore.isTrackingActive() && sessionStore.sessionId() != null) {
                    Log.w(TAG, "Process started with an active session — restoring tracking")
                    LocationTrackingService.start(this@TrackerApplication)
                    ServiceWatchdog.schedule(this@TrackerApplication)
                }
            }.onFailure { Log.e(TAG, "Could not restore tracking", it) }
        }
    }

    companion object {
        private const val TAG = "KH/App"
    }
}
