package com.karahoca.tracker.util

import android.content.Context
import android.content.Intent
import android.provider.Settings
import com.google.android.gms.common.api.ResolvableApiException
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.LocationSettingsRequest
import com.google.android.gms.location.Priority

/**
 * Turning the phone's location switch back on.
 *
 * This is a different failure from a missing permission, and the app used to
 * conflate them. A driver can grant every location permission we ask for and
 * still have the master toggle off — from the quick-settings tile, from a
 * battery-saver profile, or because the phone shipped that way. When that
 * happens FusedLocationProviderClient does not throw and does not fail its
 * Task: it simply never delivers a fix. The service runs, the notification says
 * "Takip aktif", the buffer stays at zero, and the truck is invisible for the
 * whole shift.
 *
 * Two ways to fix it, in order of how much they ask of the driver:
 *
 *  1. [requestEnable] — Play Services' own dialog, shown *over this app*. One
 *     tap, location on, no navigation. This is the path a driver in a hurry
 *     will actually complete.
 *  2. [openSettings] — the system location screen. Needed when Play Services
 *     is missing (Huawei, de-Googled phones) or when the resolution intent
 *     cannot be shown.
 */
object LocationSettingsHelper {

    /**
     * Ask Play Services whether our location requirements are met and, if not,
     * hand the caller a resolution to launch.
     *
     * [onResolution] receives an intent sender that must go through an
     * ActivityResultLauncher — starting it directly from a Context loses the
     * result and the checklist never learns the driver said yes.
     *
     * [onUnavailable] fires when the request cannot be resolved in place: no
     * Play Services, or a device where the setting is locked down. Callers
     * route it to [openSettings].
     */
    fun requestEnable(
        context: Context,
        onResolution: (ResolvableApiException) -> Unit,
        onUnavailable: () -> Unit,
    ) {
        val request = LocationSettingsRequest.Builder()
            .addLocationRequest(
                // Interval is irrelevant here — the request only describes the
                // *class* of fix we need so the dialog can say "high accuracy".
                // HIGH_ACCURACY is what the tracking service actually uses, so
                // asking for anything weaker would let the driver satisfy this
                // dialog with battery-saving mode and still produce no GPS.
                LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 10_000L).build(),
            )
            // Suppress the "never" button. A driver who dismisses this
            // permanently has no way back to it from inside the app.
            .setAlwaysShow(true)
            .build()

        runCatching {
            LocationServices.getSettingsClient(context)
                .checkLocationSettings(request)
                .addOnFailureListener { error ->
                    if (error is ResolvableApiException) onResolution(error) else onUnavailable()
                }
        }.onFailure { onUnavailable() }
    }

    /** The system location screen — the fallback, and the manual route. */
    fun openSettings(context: Context): Boolean = runCatching {
        context.startActivity(
            Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
        true
    }.getOrDefault(false)
}
