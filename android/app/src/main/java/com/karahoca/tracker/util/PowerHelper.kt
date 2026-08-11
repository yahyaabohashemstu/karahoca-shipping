package com.karahoca.tracker.util

import android.app.AlarmManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.core.content.getSystemService

/**
 * ============================================================================
 *  FIGHTING OEM POWER MANAGEMENT
 * ============================================================================
 *
 * Stock Android is well-behaved: a location-type foreground service with a
 * battery-optimisation exemption keeps running. Several Chinese OEM skins are
 * not, and they are extremely common in Turkish commercial vehicle fleets.
 *
 * MIUI (Xiaomi/Redmi/POCO), EMUI/HarmonyOS (Huawei/Honor), ColorOS (Oppo/
 * Realme), FuntouchOS (Vivo) and, to a lesser degree, One UI (Samsung) each ship
 * a proprietary killer that terminates background *and foreground* services
 * regardless of the AOSP rules — unless the app is explicitly whitelisted in a
 * settings screen that has no public API.
 *
 * There is no programmatic fix. The only working strategy is:
 *
 *   1. Ask for the AOSP battery-optimisation exemption (works everywhere).
 *   2. Deep-link the driver straight into the OEM's autostart screen, because
 *      no driver will ever find it themselves.
 *   3. Have the watchdog resurrect us when they get killed anyway.
 *
 * The Intents below are undocumented and can disappear in any OEM update, hence
 * the resolveActivity guard and the graceful fallback to app settings.
 */
object PowerHelper {

    // ---- 1. AOSP battery optimisation ---------------------------------------

    fun isIgnoringBatteryOptimizations(context: Context): Boolean {
        val pm = context.getSystemService<PowerManager>() ?: return false
        return pm.isIgnoringBatteryOptimizations(context.packageName)
    }

    /**
     * Direct request dialog. Requires REQUEST_IGNORE_BATTERY_OPTIMIZATIONS.
     *
     * Beyond exempting us from Doze deferral, being on this list is one of the
     * documented conditions under which an app may start a foreground service
     * from the background on Android 12+ — which is exactly what the watchdog
     * and the boot receiver must do.
     */
    @Suppress("BatteryLife")
    fun requestIgnoreBatteryOptimizations(context: Context): Boolean {
        if (isIgnoringBatteryOptimizations(context)) return true
        val intent = Intent(
            Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
            Uri.parse("package:${context.packageName}"),
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return launch(context, intent) || openBatteryOptimizationList(context)
    }

    private fun openBatteryOptimizationList(context: Context): Boolean = launch(
        context,
        Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
    )

    // ---- 2. Exact alarms (Android 12+) --------------------------------------

    fun canScheduleExactAlarms(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
        return context.getSystemService<AlarmManager>()?.canScheduleExactAlarms() ?: false
    }

    fun requestExactAlarmPermission(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
        return launch(
            context,
            Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM)
                .setData(Uri.parse("package:${context.packageName}"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
    }

    // ---- 3. OEM autostart / protected apps ----------------------------------

    /**
     * True when this device ships a known proprietary killer, so the UI can show
     * the extra onboarding step only where it is actually needed.
     */
    fun hasAggressiveOem(): Boolean = oemKey() != null

    fun oemLabel(): String = when (oemKey()) {
        "xiaomi" -> "Xiaomi / Redmi / POCO (MIUI)"
        "huawei" -> "Huawei / Honor (EMUI)"
        "oppo" -> "Oppo / Realme (ColorOS)"
        "vivo" -> "Vivo (FuntouchOS)"
        "samsung" -> "Samsung (One UI)"
        "oneplus" -> "OnePlus (OxygenOS)"
        "asus" -> "ASUS (ZenUI)"
        "letv" -> "LeEco"
        "meizu" -> "Meizu"
        "nokia" -> "Nokia"
        else -> Build.MANUFACTURER
    }

    private fun oemKey(): String? {
        val manufacturer = Build.MANUFACTURER.lowercase()
        return when {
            manufacturer.contains("xiaomi") || manufacturer.contains("redmi") ||
                manufacturer.contains("poco") -> "xiaomi"
            manufacturer.contains("huawei") || manufacturer.contains("honor") -> "huawei"
            manufacturer.contains("oppo") || manufacturer.contains("realme") -> "oppo"
            manufacturer.contains("vivo") -> "vivo"
            manufacturer.contains("samsung") -> "samsung"
            manufacturer.contains("oneplus") -> "oneplus"
            manufacturer.contains("asus") -> "asus"
            manufacturer.contains("letv") -> "letv"
            manufacturer.contains("meizu") -> "meizu"
            manufacturer.contains("nokia") -> "nokia"
            else -> null
        }
    }

    /**
     * Open the OEM's autostart screen.
     *
     * Every entry here is an undocumented component name harvested from the
     * respective ROMs. They break. That is why the watchdog exists and why this
     * returns a boolean the UI uses to fall back to written instructions.
     */
    fun openAutostartSettings(context: Context): Boolean {
        val candidates: List<Intent> = when (oemKey()) {
            "xiaomi" -> listOf(
                component("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity"),
                component("com.miui.securitycenter", "com.miui.powercenter.PowerSettings"),
            )
            "huawei" -> listOf(
                component("com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"),
                component("com.huawei.systemmanager", "com.huawei.systemmanager.optimize.process.ProtectActivity"),
                component("com.huawei.systemmanager", "com.huawei.systemmanager.appcontrol.activity.StartupAppControlActivity"),
            )
            "oppo" -> listOf(
                component("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity"),
                component("com.coloros.safecenter", "com.coloros.safecenter.startupapp.StartupAppListActivity"),
                component("com.oppo.safe", "com.oppo.safe.permission.startup.StartupAppListActivity"),
            )
            "vivo" -> listOf(
                component("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"),
                component("com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager"),
            )
            "samsung" -> listOf(
                component("com.samsung.android.lool", "com.samsung.android.sm.ui.battery.BatteryActivity"),
                component("com.samsung.android.sm_cn", "com.samsung.android.sm.ui.battery.BatteryActivity"),
            )
            "oneplus" -> listOf(
                component("com.oneplus.security", "com.oneplus.security.chainlaunch.view.ChainLaunchAppListActivity"),
            )
            "asus" -> listOf(
                component("com.asus.mobilemanager", "com.asus.mobilemanager.autostart.AutoStartActivity"),
            )
            "letv" -> listOf(
                component("com.letv.android.letvsafe", "com.letv.android.letvsafe.AutobootManageActivity"),
            )
            "meizu" -> listOf(
                component("com.meizu.safe", "com.meizu.safe.security.SHOW_APPSEC"),
            )
            "nokia" -> listOf(
                component("com.evenwell.powersaving.g3", "com.evenwell.powersaving.g3.exception.PowerSaverExceptionActivity"),
            )
            else -> emptyList()
        }

        for (intent in candidates) {
            if (launch(context, intent)) return true
        }
        // Last resort: the standard app-info screen, which every ROM has.
        return launch(
            context,
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                .setData(Uri.parse("package:${context.packageName}"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
    }

    private fun component(pkg: String, cls: String): Intent =
        Intent().setComponent(ComponentName(pkg, cls)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    /**
     * These component names are undocumented and vary by ROM build, so every
     * failure mode is expected and none of them may crash the app: a missing
     * activity, a SecurityException from a locked-down vendor package, or a
     * ROM that throws something else entirely. Returning false lets the caller
     * fall through to the next candidate and finally to app-info.
     */
    private fun launch(context: Context, intent: Intent): Boolean = runCatching {
        if (intent.resolveActivity(context.packageManager) != null) {
            context.startActivity(intent)
            true
        } else {
            false
        }
    }.getOrDefault(false)
}
