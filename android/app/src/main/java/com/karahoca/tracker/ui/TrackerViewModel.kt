package com.karahoca.tracker.ui

import android.content.Context
import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.karahoca.tracker.data.local.SessionStore
import com.karahoca.tracker.data.repository.TrackingRepository
import com.karahoca.tracker.service.LocationTrackingService
import com.karahoca.tracker.sync.NetworkMonitor
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
    val lastSyncAt: Long = 0,

    val checks: List<ReadinessCheck> = emptyList(),
) {
    enum class Screen { CLAIM, READINESS, TRACKING }

    val canStart: Boolean get() = checks.none { it.blocking && !it.satisfied }
}

@HiltViewModel
class TrackerViewModel @Inject constructor(
    private val repository: TrackingRepository,
    private val store: SessionStore,
    private val deviceInfo: DeviceInfoProvider,
    private val network: NetworkMonitor,
) : ViewModel() {

    private companion object { const val TAG = "KH/ViewModel" }

    private val _state = MutableStateFlow(TrackerUiState())
    val state: StateFlow<TrackerUiState> = _state.asStateFlow()

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
            it.copy(error = "Arka plan hatası: ${t.javaClass.simpleName}: ${t.message ?: "-"}")
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

    fun onCodeChanged(value: String) {
        _state.update { it.copy(codeInput = value.uppercase().take(12), error = null) }
    }

    /** Called by MainActivity when opened from a `karahoca://track?c=…` link. */
    fun onDeepLinkCode(code: String) {
        _state.update { it.copy(codeInput = code.uppercase()) }
        claim()
    }

    fun claim() {
        val code = _state.value.codeInput.trim()
        if (code.length < 6) {
            _state.update { it.copy(error = "Kod en az 6 karakter olmalıdır") }
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
                        it.copy(busy = false, error = err.message ?: "Oturum açılamadı")
                    }
                }
        }
    }

    fun startTracking(context: Context) {
        if (!_state.value.canStart) {
            _state.update { it.copy(error = "Önce zorunlu izinleri verin") }
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
            repository.notifyStop()
            _state.update { it.copy(screen = TrackerUiState.Screen.READINESS) }
        }
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
