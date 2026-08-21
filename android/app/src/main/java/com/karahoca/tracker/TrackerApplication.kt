package com.karahoca.tracker

import android.app.Application
import android.content.Context
import android.content.res.Resources
import android.util.Log
import androidx.hilt.work.HiltWorkerFactory
import androidx.work.Configuration
import com.karahoca.tracker.data.local.SessionStore
import com.karahoca.tracker.service.LocationTrackingService
import com.karahoca.tracker.service.ServiceWatchdog
import com.karahoca.tracker.sync.NetworkMonitor
import com.karahoca.tracker.sync.SyncScheduler
import com.karahoca.tracker.update.UpdateRepository
import com.karahoca.tracker.util.AppLocale
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

    /**
     * Lazy, so building it stays off the main thread.
     *
     * Hilt injects fields eagerly in super.onCreate(), and this one pulls in
     * TrackingNotification — three createNotificationChannel round trips into
     * the system server. On the BOOT_COMPLETED path that is main-thread time
     * spent inside the ten seconds the tracking service has to reach
     * startForeground, which is a deadline this app has already missed once.
     * dagger.Lazy defers the whole graph to the IO coroutine below.
     */
    @Inject lateinit var updates: dagger.Lazy<UpdateRepository>

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

    /*
     * The driver's language, for everything Hilt hands an @ApplicationContext.
     *
     * That is not a small set. TrackerViewModel builds four claim errors from
     * it, and DeviceInfoProvider builds the entire pre-flight checklist — so a
     * driver who chose Arabic, then mistyped a code, was answered in Turkish on
     * the very screen the language picker sits on.
     *
     * attachBaseContext is deliberately NOT wrapped here. createConfigurationContext
     * snapshots the whole Configuration, and freezing the application context's
     * would pin font scale, dark mode and orientation for the life of the
     * process. Overriding getResources() instead re-derives from the live base
     * configuration on every call, so only the locale is ours and everything
     * else keeps following the phone.
     *
     * Cached by tag: this is called on essentially every resource lookup in the
     * process. The fallback covers the window before a base context exists,
     * during which Hilt and the crash reporter are already running.
     */
    private var localeTag: String? = null
    private var localeResources: Resources? = null

    override fun getResources(): Resources = runCatching {
        val base = baseContext!!
        val tag = AppLocale.current(base)
        localeResources?.takeIf { tag == localeTag } ?: run {
            localeTag = tag
            AppLocale.wrap(base).resources.also { localeResources = it }
        }
    }.getOrElse { super.getResources() }

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

            /*
             * Every process start is a chance to notice a new release — and on
             * a fleet with no app store, chances are scarce. Throttled to once
             * every six hours inside check(), so a phone whose service is
             * restarted repeatedly by an aggressive OEM does not re-ask on
             * every resurrection.
             */
            runCatching { updates.get().check() }
                .onFailure { Log.e(TAG, "Update check failed", it) }

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
