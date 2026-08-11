package com.karahoca.tracker.sync

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.util.Log
import androidx.core.content.getSystemService
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Connectivity state, and the trigger that turns "back in coverage" into
 * "upload the backlog now" without any polling.
 *
 * Uses NET_CAPABILITY_VALIDATED, not merely "a network exists": a Turkish
 * highway is full of captive-portal Wi-Fi at service stations that associates
 * happily and routes nowhere. Treating those as online would burn the expedited
 * work quota on uploads that cannot succeed.
 */
@Singleton
class NetworkMonitor @Inject constructor(
    @ApplicationContext private val context: Context,
    private val syncScheduler: SyncScheduler,
) {

    companion object {
        private const val TAG = "KH/Network"
    }

    private val connectivity get() = context.getSystemService<ConnectivityManager>()

    private var registered = false
    private var wasOnline = false

    fun isOnline(): Boolean {
        val cm = connectivity ?: return false
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
            caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    }

    /** Recorded per point: makes "did we lose it on 2G or on Wi-Fi?" answerable. */
    fun currentType(): String {
        val cm = connectivity ?: return "none"
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return "none"
        return when {
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) ->
                if (caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)) {
                    "cellular-unmetered"
                } else {
                    "cellular"
                }
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            else -> "other"
        }
    }

    /**
     * Register the "coverage returned" trigger.
     *
     * WorkManager's own NetworkType.CONNECTED constraint already reacts to this,
     * but its scheduling can lag by tens of seconds. On a highway where coverage
     * comes back for ninety seconds between hills, those seconds are the whole
     * opportunity — so we enqueue an expedited pass the instant the callback
     * fires.
     */
    @Synchronized
    fun startMonitoring() {
        if (registered) return
        val cm = connectivity ?: return

        val request = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .addCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
            .build()

        runCatching {
            cm.registerNetworkCallback(
                request,
                object : ConnectivityManager.NetworkCallback() {
                    override fun onAvailable(network: Network) {
                        if (!wasOnline) {
                            wasOnline = true
                            Log.i(TAG, "Connectivity restored — flushing buffer")
                            syncScheduler.syncNow(expedited = true)
                        }
                    }

                    override fun onLost(network: Network) {
                        wasOnline = false
                        Log.w(TAG, "Connectivity lost — buffering locally")
                    }
                },
            )
            registered = true
            wasOnline = isOnline()
            Log.d(TAG, "Network monitoring started (online=$wasOnline)")
        }.onFailure { Log.e(TAG, "Failed to register network callback", it) }
    }

    /** Flow for the UI's connection indicator. */
    val onlineFlow: Flow<Boolean> = callbackFlow {
        val cm = connectivity
        if (cm == null) {
            trySend(false)
            awaitClose { }
            return@callbackFlow
        }
        trySend(isOnline())
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) { trySend(true) }
            override fun onLost(network: Network) { trySend(isOnline()) }
            override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                trySend(caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED))
            }
        }
        val request = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()
        cm.registerNetworkCallback(request, callback)
        awaitClose { runCatching { cm.unregisterNetworkCallback(callback) } }
    }.distinctUntilChanged()
}
