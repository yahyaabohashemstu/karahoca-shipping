package com.karahoca.tracker.util

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.LocationManager
import android.os.Build
import androidx.core.content.ContextCompat
import androidx.core.content.getSystemService
import androidx.core.location.LocationManagerCompat
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.karahoca.tracker.BuildConfig
import com.karahoca.tracker.data.remote.DeviceInfoDto
import dagger.hilt.android.qualifiers.ApplicationContext
import java.security.MessageDigest
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Device identity and self-reported health, sent at claim time.
 *
 * The health flags are the most valuable part. They let a dispatcher see, on
 * the session detail page BEFORE the truck leaves the yard, that this phone
 * has no battery-optimisation exemption — which turns a post-mortem ("why did
 * we lose that shipment?") into a pre-flight check ("go fix the phone first").
 *
 * Deliberately collects no persistent hardware identifier: the fingerprint is a
 * hash of *model characteristics*, not of ANDROID_ID or an IMEI. This is a
 * fleet tool, not a device-tracking tool, and third-party drivers are not our
 * employees.
 */
@Singleton
class DeviceInfoProvider @Inject constructor(
    @ApplicationContext private val context: Context,
) {

    fun toDto(deviceId: String) = DeviceInfoDto(
        deviceId = deviceId,
        fingerprint = modelFingerprint(),
        manufacturer = Build.MANUFACTURER,
        model = Build.MODEL,
        osVersion = "Android ${Build.VERSION.RELEASE}",
        sdkInt = Build.VERSION.SDK_INT,
        appVersion = BuildConfig.VERSION_NAME,
        appBuild = BuildConfig.VERSION_CODE,
        batteryOptimisationIgnored = PowerHelper.isIgnoringBatteryOptimizations(context),
        hasBackgroundLocation = hasBackgroundLocation(),
        hasExactAlarm = PowerHelper.canScheduleExactAlarms(context),
    )

    private fun modelFingerprint(): String {
        val material = listOf(
            Build.MANUFACTURER, Build.MODEL, Build.DEVICE,
            Build.BOARD, Build.VERSION.SDK_INT.toString(),
        ).joinToString("|")
        return MessageDigest.getInstance("SHA-256")
            .digest(material.toByteArray())
            .take(16)
            .joinToString("") { "%02x".format(it) }
    }

    fun hasForegroundLocation(): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    /**
     * Is the phone's master location switch on?
     *
     * Orthogonal to every permission above, and the app checked none of it
     * until now. A driver can hold ACCESS_FINE_LOCATION *and* background
     * location and still produce nothing all day, because the toggle in the
     * quick-settings shade is off — Android returns no fixes and reports no
     * error for it.
     *
     * LocationManagerCompat is the correct read: `isLocationEnabled` only
     * exists from API 28, and below that the answer is "is any provider on",
     * which the compat shim already handles.
     */
    fun isLocationEnabled(): Boolean =
        context.getSystemService<LocationManager>()
            ?.let { LocationManagerCompat.isLocationEnabled(it) }
            ?: false

    fun hasBackgroundLocation(): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.ACCESS_BACKGROUND_LOCATION,
            ) == PackageManager.PERMISSION_GRANTED
        } else {
            // Pre-Android 10 there is no separate background grant.
            hasForegroundLocation()
        }

    /**
     * Is a usable Play Services present?
     *
     * SUCCESS only. SERVICE_UPDATING or SERVICE_VERSION_UPDATE_REQUIRED mean the
     * fused provider may work later but not now, and "later" on a truck leaving
     * the yard is the same as never.
     */
    fun hasPlayServices(): Boolean =
        GoogleApiAvailability.getInstance()
            .isGooglePlayServicesAvailable(context) == ConnectionResult.SUCCESS

    fun hasNotificationPermission(): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.POST_NOTIFICATIONS,
            ) == PackageManager.PERMISSION_GRANTED
        } else {
            true
        }

    /**
     * The pre-flight checklist rendered on the app's home screen.
     *
     * `blocking = true` items make tracking impossible; the rest degrade
     * reliability. Ordered worst-first so the driver fixes what matters.
     */
    fun readinessChecks(): List<ReadinessCheck> = buildList {
        add(
            ReadinessCheck(
                key = "location_services",
                label = "Konum servisi açık",
                satisfied = isLocationEnabled(),
                /*
                 * First in the list and blocking, because it outranks every
                 * permission below it: with the master switch off, a fully
                 * permitted app still records nothing, and it does so without
                 * a single error anywhere. Everything downstream — the
                 * notification, the buffer count, the dispatcher's map —
                 * reports a healthy session with no points in it.
                 *
                 * Also the only row here whose state the driver can change
                 * from the notification shade after passing the checklist, so
                 * TrackingScreen re-checks it while a shift is running.
                 */
                blocking = true,
                detail = "Telefonun konum düğmesi kapalı. Açılmadan konum alınamaz.",
            ),
        )
        add(
            ReadinessCheck(
                key = "location",
                // Label says exactly what this row verifies. It previously read
                // "Her zaman" (Always) while only checking ACCESS_FINE_LOCATION,
                // so tapping "Allow only while using the app" satisfied a row
                // that promised the opposite.
                label = "Konum izni (uygulama açıkken)",
                satisfied = hasForegroundLocation(),
                blocking = true,
                detail = "GPS izni olmadan takip başlatılamaz.",
            ),
        )
        add(
            ReadinessCheck(
                key = "background_location",
                label = "Konum izni (her zaman)",
                satisfied = hasBackgroundLocation(),
                /*
                 * BLOCKING on API 29+, and this is the most important line in
                 * the file.
                 *
                 * Every restart path in this app — WatchdogReceiver,
                 * BootReceiver, TrackerApplication.onCreate — starts the
                 * foreground service with no UI on screen. On Android 10+ a
                 * background start gets NO location updates without this grant,
                 * and Android raises no exception: onLocationAvailability never
                 * fires, the service holds its wake lock, the notification says
                 * "Takip aktif", and nothing is recorded for the rest of the
                 * shift.
                 *
                 * The yard test still passes, because the first start comes
                 * from a visible Activity. The failure appears only after the
                 * first OEM kill — i.e. exactly when the resurrection design is
                 * supposed to save the shipment.
                 */
                blocking = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q,
                detail = "Servis yeniden başladığında ve telefon kilitliyken gereklidir.",
            ),
        )
        add(
            ReadinessCheck(
                key = "play_services",
                label = "Google Play Hizmetleri",
                // FusedLocationProviderClient is a Play Services API. On a
                // Huawei/HarmonyOS or de-Googled phone requestLocationUpdates
                // fails its Task rather than throwing, so without this row the
                // app looks healthy and produces nothing.
                satisfied = hasPlayServices(),
                blocking = true,
                detail = "Konum motoru buna bağlıdır. Bazı telefonlarda bulunmaz.",
            ),
        )
        add(
            ReadinessCheck(
                key = "notifications",
                label = "Bildirim izni",
                satisfied = hasNotificationPermission(),
                blocking = false,
                detail = "Takip bildirimi olmadan Android servisi kapatabilir.",
            ),
        )
        add(
            ReadinessCheck(
                key = "battery",
                label = "Pil optimizasyonu kapalı",
                satisfied = PowerHelper.isIgnoringBatteryOptimizations(context),
                blocking = false,
                detail = "En kritik ayar. Kapalı değilse Android uygulamayı uyutur.",
            ),
        )
        add(
            ReadinessCheck(
                key = "exact_alarm",
                label = "Tam zamanlı alarm izni",
                satisfied = PowerHelper.canScheduleExactAlarms(context),
                blocking = false,
                detail = "Servis kapanırsa otomatik yeniden başlatma için gereklidir.",
            ),
        )
        if (PowerHelper.hasAggressiveOem()) {
            add(
                ReadinessCheck(
                    key = "autostart",
                    label = "Otomatik başlatma (${PowerHelper.oemLabel()})",
                    // Unverifiable from inside the app — no OEM exposes a query
                    // API, so the driver confirms it manually.
                    satisfied = false,
                    blocking = false,
                    manualConfirm = true,
                    detail = "Bu marka telefonlarda ayrıca izin verilmesi gerekir.",
                ),
            )
        }
    }
}

data class ReadinessCheck(
    val key: String,
    val label: String,
    val satisfied: Boolean,
    val blocking: Boolean,
    val detail: String,
    val manualConfirm: Boolean = false,
)
