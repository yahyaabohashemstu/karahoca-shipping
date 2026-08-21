package com.karahoca.tracker.ui

import android.content.Context
import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.karahoca.tracker.data.local.SessionStore
import com.karahoca.tracker.update.UpdateRepository
import com.karahoca.tracker.update.UpdateState
import com.karahoca.tracker.data.repository.TrackingRepository
import com.karahoca.tracker.service.LocationTrackingService
import com.karahoca.tracker.sync.NetworkMonitor
import com.karahoca.tracker.util.ClaimCode
import com.karahoca.tracker.util.DeviceInfoProvider
import com.karahoca.tracker.util.ReadinessCheck
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import javax.inject.Inject
import com.karahoca.tracker.R
import dagger.hilt.android.qualifiers.ApplicationContext

data class TrackerUiState(
    val screen: Screen = Screen.CLAIM,
    val busy: Boolean = false,
    val error: String? = null,

    val codeInput: String = "",

    val reference: String? = null,
    val orderNumber: String? = null,
    val customerName: String? = null,
    val destination: String? = null,

    val trackingActive: Boolean = false,
    val online: Boolean = true,
    val pendingCount: Int = 0,
    val totalCount: Int = 0,
    val lastFixAt: Long = 0,
    /**
     * Straight-line metres to the delivery point, or null.
     *
     * Null for three orders in four, because most have no destination — and
     * when it is null the screen says nothing about distance rather than
     * showing a number it cannot stand behind.
     */
    val remainingM: Double? = null,
    /** Whether the vehicle has reached the delivery point. */
    val arrived: Boolean = false,
    val lastSyncAt: Long = 0,

    val checks: List<ReadinessCheck> = emptyList(),
) {
    enum class Screen { CLAIM, READINESS, TRACKING }

    val canStart: Boolean get() = checks.none { it.blocking && !it.satisfied }

    /** The code is complete and worth sending. */
    val canClaim: Boolean get() = codeInput.length == ClaimCode.LENGTH

    /**
     * The phone's master location switch, as of the last 2-second refresh.
     *
     * Exposed separately from [checks] because it is the one item the driver
     * can turn off *after* the checklist has passed — from the notification
     * shade, without ever reopening the app — so the tracking screen has to
     * watch it too. Absent (no checks loaded yet) counts as fine: showing an
     * alarm during the first render would cry wolf on every cold start.
     */
    val locationServicesOn: Boolean
        get() = checks.firstOrNull { it.key == "location_services" }?.satisfied ?: true
}

@HiltViewModel
class TrackerViewModel @Inject constructor(
    /*
     * The application context, purely to reach string resources.
     *
     * A ViewModel holding a Context is usually a leak waiting to happen — but
     * @ApplicationContext is the process-wide one, which outlives every
     * ViewModel by construction, so there is nothing here to leak. The
     * alternative was for this class to keep composing Turkish sentences, which
     * is what made the messages it produces untranslatable.
     */
    @ApplicationContext private val context: Context,
    private val repository: TrackingRepository,
    private val store: SessionStore,
    private val deviceInfo: DeviceInfoProvider,
    private val network: NetworkMonitor,
    private val updates: UpdateRepository,
    private val notifications: com.karahoca.tracker.service.TrackingNotification,
) : ViewModel() {

    private companion object { const val TAG = "KH/ViewModel" }

    private val _state = MutableStateFlow(TrackerUiState())
    val state: StateFlow<TrackerUiState> = _state.asStateFlow()

    /*
     * Kept out of TrackerUiState deliberately.
     *
     * That state is rebuilt wholesale by a 2-second poll; folding a download's
     * percentage into it would mean either the poll stamping over the progress
     * or the progress stamping over a stale copy of everything else. The
     * updater owns its own flow and the banner collects it directly.
     */
    val updateState: StateFlow<UpdateState> = updates.state

    /** One tap: download, verify, hand to the platform installer. */
    fun startUpdate() = updates.start()

    /**
     * Ask again now, throttle or no throttle.
     *
     * Only from the notification's Update button landing on an empty state:
     * the driver has pressed something and is owed either a banner or nothing
     * at all, not a six-hour wait.
     */
    fun recheckForUpdate() {
        viewModelScope.launch { runCatching { updates.check(force = true) } }
    }

    /**
     * Opening the app is a deliberate act, so it always asks.
     *
     * The background timer exists to protect a driver's data allowance from a
     * poll they did not ask for. A driver with the app in front of them is not
     * that case, and treating them as if they were is what made a release
     * invisible for the rest of the day to the one person watching for it.
     */
    private fun checkForUpdateNow() {
        viewModelScope.launch {
            runCatching { updates.check(force = true) }
                .onFailure { Log.d(TAG, "Update check on open failed", it) }
        }
    }

    fun onReturnedFromInstallSettings() = updates.onReturnedFromSettings()

    fun unknownSourcesIntent() = updates.unknownSourcesIntent()

    fun updateNotes(manifest: com.karahoca.tracker.update.UpdateManifest) =
        updates.notesFor(manifest)

    /*
     * A deep link can arrive before we know what session this phone is already
     * carrying, and acting on it early is how a driver loses a shift.
     *
     * MainActivity hands us the code from its first composition, microseconds
     * after onCreate. restore() is a suspend read of DataStore that has not
     * finished by then, so `trackingActive` is still its default false — and
     * the guard in consumeDeepLink(), whose entire job is to refuse a new code
     * mid-shift, would wave it through. The code is therefore parked until
     * restore() has run.
     *
     * Both fields are touched only from viewModelScope (Dispatchers.Main
     * .immediate) and from the UI thread, so no synchronisation is needed.
     */
    private var restored = false
    private var pendingDeepLink: String? = null

    init {
        viewModelScope.launch {
            /*
             * Both calls are guarded because viewModelScope has no exception
             * handler: anything thrown inside reaches the platform's default
             * uncaught handler and kills the process. A UI that cannot read the
             * buffer count should show a stale count, not close the app in the
             * driver's hand two seconds after they opened it.
             */
            runCatching { restore() }
                .onFailure { Log.e(TAG, "restore() failed", it); reportSoftFailure(it) }

            // Outside the runCatching on purpose: if restore() threw we still
            // have to release a parked deep link, or a failed DataStore read
            // strands the driver on a claim screen that ignores their scan.
            restored = true
            consumeDeepLink()

            /*
             * Did the desk restart this shipment while the app was closed?
             *
             * Checked here rather than in TrackerApplication so it costs the
             * boot path nothing: this runs when a driver actually opens the
             * app, and SyncWorker covers the case where they do not. Guarded
             * like everything else in this scope — a failed lookup must degrade
             * to "no", never to a crash on the screen the driver just opened.
             */
            runCatching {
                if (repository.dispatcherResumedTracking()) resumeFromDispatcher()
            }.onFailure { Log.e(TAG, "Remote resume check failed", it) }

            checkForUpdateNow()

            // 2 s poll instead of a bound service: the UI is open for seconds at
            // a time and a poll cannot leak a binding when the driver pockets
            // the phone mid-screen.
            while (isActive) {
                runCatching { refreshRuntimeState() }
                    .onFailure { Log.e(TAG, "refreshRuntimeState() failed", it); reportSoftFailure(it) }
                delay(2_000)
            }
        }
    }

    /** Surface a background failure in the UI instead of dying silently. */
    private fun reportSoftFailure(t: Throwable) {
        _state.update {
            it.copy(error = "Background error: ${t.javaClass.simpleName}: ${t.message ?: "-"}")
        }
    }

    private suspend fun restore() {
        val status = store.status()
        _state.update {
            it.copy(
                screen = when {
                    status.sessionId == null -> TrackerUiState.Screen.CLAIM
                    status.trackingActive -> TrackerUiState.Screen.TRACKING
                    else -> TrackerUiState.Screen.READINESS
                },
                reference = status.reference,
                orderNumber = status.orderNumber,
                customerName = status.customerName,
                destination = status.destination,
                trackingActive = status.trackingActive,
                checks = deviceInfo.readinessChecks(),
            )
        }
    }

    private suspend fun refreshRuntimeState() {
        val snapshot = repository.snapshot()
        val status = store.status()
        _state.update {
            it.copy(
                online = snapshot.online,
                pendingCount = snapshot.pendingCount,
                totalCount = snapshot.totalCount,
                lastFixAt = snapshot.lastFixAt,
                lastSyncAt = snapshot.lastSyncAt,
                // Written by the tracking service on the notification's own
                // cadence, so this follows the lorry without polling anything.
                remainingM = status.remainingM,
                arrived = status.arrived,
                trackingActive = status.trackingActive,
                checks = deviceInfo.readinessChecks(),
                screen = when {
                    status.sessionId == null -> TrackerUiState.Screen.CLAIM
                    status.trackingActive -> TrackerUiState.Screen.TRACKING
                    it.screen == TrackerUiState.Screen.CLAIM -> TrackerUiState.Screen.READINESS
                    else -> it.screen
                },
            )
        }
    }

    /**
     * Every keystroke goes through the canonical normaliser.
     *
     * The field shows `XXXX-XXXX` via ClaimCodeTransformation, but what is
     * stored here never contains the dash — so a driver who types or pastes one
     * anyway (they did, which is why the dash is now automatic) does not end up
     * with a code the server rejects.
     */
    fun onCodeChanged(value: String) {
        _state.update { it.copy(codeInput = ClaimCode.normalise(value), error = null) }
    }

    /**
     * A QR scan or hand-off link arrived. Park it, then act as soon as we know
     * what session this phone already holds.
     */
    fun onDeepLinkCode(code: String) {
        val normalised = ClaimCode.normalise(code)
        if (normalised.isEmpty()) return
        pendingDeepLink = normalised
        if (restored) consumeDeepLink()
    }

    /**
     * Fill the field and, when it is safe, claim without making the driver
     * press anything.
     *
     * "When it is safe" excludes an active shift. A verified App Link opens
     * this app for *any* /t/ URL on the host, so a driver who scans a
     * colleague's dispatch note mid-route would otherwise silently reassign
     * their own phone to the wrong shipment and abandon the one it is carrying.
     */
    private fun consumeDeepLink() {
        val code = pendingDeepLink ?: return
        pendingDeepLink = null

        if (_state.value.trackingActive) {
            _state.update {
                it.copy(error = context.getString(R.string.error_tracking_in_progress))
            }
            return
        }

        _state.update { it.copy(codeInput = code, error = null) }
        if (code.length == ClaimCode.LENGTH) claim()
    }

    fun claim() {
        val code = ClaimCode.normalise(_state.value.codeInput)
        if (code.length != ClaimCode.LENGTH) {
            _state.update {
                it.copy(error = context.getString(R.string.error_code_length, ClaimCode.LENGTH.toString()))
            }
            return
        }
        _state.update { it.copy(busy = true, error = null) }

        viewModelScope.launch {
            repository.claimSession(code)
                .onSuccess {
                    val status = store.status()
                    _state.update { s ->
                        s.copy(
                            busy = false,
                            screen = TrackerUiState.Screen.READINESS,
                            reference = status.reference,
                            orderNumber = status.orderNumber,
                            customerName = status.customerName,
                            destination = status.destination,
                            checks = deviceInfo.readinessChecks(),
                        )
                    }
                }
                .onFailure { err ->
                    _state.update {
                        it.copy(busy = false, error = err.message ?: context.getString(R.string.error_claim_failed))
                    }
                }
        }
    }

    fun startTracking(context: Context) {
        if (!_state.value.canStart) {
            _state.update { it.copy(error = context.getString(R.string.error_permissions_first)) }
            return
        }
        viewModelScope.launch {
            store.setTrackingActive(true)
            LocationTrackingService.start(context)
            _state.update { it.copy(screen = TrackerUiState.Screen.TRACKING, error = null) }
        }
    }

    fun stopTracking(context: Context) {
        viewModelScope.launch {
            // Clear the flag HERE, not only inside the service.
            //
            // The service used to be the sole writer, so if it had already been
            // killed the flag stayed true and the watchdog kept resurrecting a
            // session the driver had explicitly stopped. The UI knows the
            // driver's intent; the service only knows its own lifecycle.
            store.setTrackingActive(false)
            LocationTrackingService.stop(context)
            // Persisted, because it is what lets the phone tell a dispatcher's
            // Resume apart from a stop that never reached the server. See
            // TrackingRepository.dispatcherResumedTracking.
            store.setStopAcked(repository.notifyStop())
            _state.update { it.copy(screen = TrackerUiState.Screen.READINESS) }
        }
    }

    /**
     * Put tracking back on because somebody at a desk said so.
     *
     * The alert matters as much as the restart. A driver who stopped by
     * accident does not know they did; one whose phone silently started
     * tracking again would have no idea why the notification came back, and the
     * obvious next move for them is to stop it a second time.
     */
    private suspend fun resumeFromDispatcher() {
        Log.w(TAG, "Dispatcher resumed the session — restarting tracking")
        store.setTrackingActive(true)
        store.setStopAcked(false)
        repository.recordLocalEvent(
            type = "RESUMED",
            message = "Resumed from the dashboard",
        )
        LocationTrackingService.start(context)
        notifications.alert(
            title = context.getString(com.karahoca.tracker.R.string.resume_alert_title),
            body = context.getString(com.karahoca.tracker.R.string.resume_alert_body),
        )
        _state.update { it.copy(screen = TrackerUiState.Screen.TRACKING) }
    }

    fun syncNow(context: Context) {
        LocationTrackingService.syncNow(context)
    }

    fun refreshChecks() {
        _state.update { it.copy(checks = deviceInfo.readinessChecks()) }
    }

    /**
     * End the session on this device.
     *
     * Clears credentials but NEVER the Room buffer: unsynced points from the
     * finished session must still reach the server, and WorkManager keeps
     * trying after this screen is gone.
     */
    fun endSession(context: Context) {
        viewModelScope.launch {
            LocationTrackingService.stop(context)
            repository.notifyStop()
            store.clearSession()
            _state.update {
                TrackerUiState(checks = deviceInfo.readinessChecks())
            }
        }
    }
}
