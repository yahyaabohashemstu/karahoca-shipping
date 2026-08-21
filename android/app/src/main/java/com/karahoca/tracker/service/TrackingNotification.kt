package com.karahoca.tracker.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.annotation.StringRes
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.getSystemService
import com.karahoca.tracker.R
import com.karahoca.tracker.ui.MainActivity
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

/**
 * The persistent notification.
 *
 * Not decoration — it is the contract that keeps the process alive, and it is
 * also the driver's only feedback that tracking is working. It deliberately
 * shows the buffer depth: when a truck is in a dead zone the driver sees
 * "142 waiting to send" instead of assuming the app has broken, which is what
 * stops them from force-stopping it.
 *
 * IMPORTANCE_LOW: visible and un-dismissable, but silent. A notification that
 * beeps every 10 seconds gets the app uninstalled by lunchtime.
 */
@Singleton
class TrackingNotification @Inject constructor(
    @ApplicationContext private val context: Context,
) {

    companion object {
        const val CHANNEL_ID = "karahoca_tracking"
        private const val CHANNEL_ID_ALERTS = "karahoca_alerts"
        private const val CHANNEL_ID_UPDATE = "karahoca_update"

        /** The update prompt. 4711 is the tracking service's. */
        private const val UPDATE_ID = 4712
        private const val CONFIRM_INSTALL_ID = 4713
    }

    private val manager = NotificationManagerCompat.from(context)

    init {
        createChannels()
    }

    private fun createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = context.getSystemService<NotificationManager>() ?: return

        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                context.getString(R.string.channel_tracking),
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = context.getString(R.string.channel_tracking_desc)
                setShowBadge(false)
                enableVibration(false)
                setSound(null, null)
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            },
        )

        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID_ALERTS,
                context.getString(R.string.channel_alerts),
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = context.getString(R.string.channel_alerts_desc)
                enableVibration(true)
            },
        )

        /*
         * DEFAULT importance so it sits above the tracking notification in the
         * shade and keeps a status-bar icon, but silent: this one re-posts
         * every six hours until the driver takes it, and a chime twice a shift
         * for a fortnight is how an app gets its notifications turned off.
         */
        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID_UPDATE,
                context.getString(R.string.update_channel),
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply {
                description = context.getString(R.string.update_channel_desc)
                setShowBadge(true)
                enableVibration(false)
                setSound(null, null)
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            },
        )
    }

    /*
     * The three PendingIntents are structurally identical on every build(), so
     * they are created once. Previously each notification post made three
     * round trips into ActivityManagerService with FLAG_UPDATE_CURRENT,
     * rewriting an AMS record with the bytes it already held.
     */
    private val openApp: PendingIntent by lazy {
        PendingIntent.getActivity(
            context,
            0,
            Intent(context, MainActivity::class.java)
                .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private val stopAction: PendingIntent by lazy {
        PendingIntent.getBroadcast(
            context,
            1,
            Intent(context, NotificationActionReceiver::class.java)
                .setAction(NotificationActionReceiver.ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    /**
     * Opens the app and starts the download in one tap.
     *
     * getActivity, not getBroadcast, and that is the whole reason the flow is
     * shaped this way. The install has to end at a system confirmation dialog,
     * and an app may only launch an activity while it is visible — so a
     * receiver that tried to start the download in the background would be
     * unable to finish it. Routing the notification through the activity means
     * the app is in front for the part that needs it, which is also what the
     * yard asked for: the driver presses one button, inside the app.
     */
    private val startUpdate: PendingIntent by lazy {
        PendingIntent.getActivity(
            context,
            3,
            Intent(context, MainActivity::class.java)
                .putExtra(MainActivity.EXTRA_START_UPDATE, true)
                .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private val syncAction: PendingIntent by lazy {
        PendingIntent.getBroadcast(
            context,
            2,
            Intent(context, NotificationActionReceiver::class.java)
                .setAction(NotificationActionReceiver.ACTION_SYNC),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    fun build(
        title: String,
        body: String,
        buffered: Int,
        ongoing: Boolean,
    ): Notification {
        return NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_tracking)
            /*
             * The brand accent, so the one line of this product a driver sees
             * most — the persistent notification, present for the whole run —
             * is tinted the same colour as everything else they were shown.
             *
             * Left unset, Android supplies its own accent, which on a Samsung
             * or an Oppo is whatever the manufacturer chose. It resolves from
             * res/values, so it follows the night qualifier on its own.
             */
            .setColor(ContextCompat.getColor(context, R.color.brand_primary))
            .setColorized(false)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(openApp)
            .setOngoing(ongoing)
            .setSilent(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .apply {
                if (buffered > 0) {
                    setSubText(context.getString(R.string.notification_buffered, buffered))
                    addAction(0, context.getString(R.string.action_sync_now), syncAction)
                }
                addAction(0, context.getString(R.string.action_stop), stopAction)
            }
            .build()
    }

    @Suppress("MissingPermission") // POST_NOTIFICATIONS is requested at onboarding
    fun update(id: Int, notification: Notification) {
        runCatching { manager.notify(id, notification) }
    }

    // =========================================================================
    // The update prompt
    // =========================================================================

    /*
     * Ongoing, and re-posted by every six-hourly check.
     *
     * "Semi-permanent" was the requirement, and it needs both halves. setOngoing
     * keeps it out of a careless swipe on Android 13 and below; on 14 and above
     * the platform lets any notification be dismissed, so the thing that
     * actually makes it persistent is that the next check puts it back. A driver
     * can clear it to see their lock screen and it returns that evening.
     *
     * It is not auto-cancelling either: tapping it opens the app, and if the
     * driver then backs out without updating, the prompt should still be there.
     */
    @Suppress("MissingPermission")
    fun updateAvailable(versionName: String) {
        val notification = updateBuilder()
            .setContentTitle(context.getString(R.string.update_available_title, versionName))
            .setContentText(context.getString(R.string.update_available_body))
            .setStyle(
                NotificationCompat.BigTextStyle()
                    .bigText(context.getString(R.string.update_available_body)),
            )
            .addAction(0, context.getString(R.string.update_action), startUpdate)
            .build()
        runCatching { manager.notify(UPDATE_ID, notification) }
    }

    @Suppress("MissingPermission")
    fun updateProgress(versionName: String, percent: Int) {
        val notification = updateBuilder()
            .setContentTitle(context.getString(R.string.update_banner_title, versionName))
            .setContentText(context.getString(R.string.update_downloading, percent))
            .setProgress(100, percent, false)
            // The driver cannot act on it while it runs, and an action button
            // that re-enters a download already in flight is a trap.
            .build()
        runCatching { manager.notify(UPDATE_ID, notification) }
    }

    @Suppress("MissingPermission")
    fun updateVerifying() = postUpdateStatus(R.string.update_verifying)

    @Suppress("MissingPermission")
    fun updateInstalling() = postUpdateStatus(R.string.update_installing)

    private fun postUpdateStatus(@StringRes text: Int) {
        val notification = updateBuilder()
            .setContentTitle(context.getString(text))
            .setProgress(0, 0, true)
            .build()
        runCatching { manager.notify(UPDATE_ID, notification) }
    }

    @Suppress("MissingPermission")
    fun updateFailed(versionName: String) {
        val notification = updateBuilder()
            .setContentTitle(context.getString(R.string.update_banner_title, versionName))
            .setContentText(context.getString(R.string.update_retry))
            .addAction(0, context.getString(R.string.update_retry), startUpdate)
            .build()
        runCatching { manager.notify(UPDATE_ID, notification) }
    }

    /**
     * The platform installer refused, after the driver had already accepted.
     *
     * Separate from [updateFailed] because the reason comes from the system and
     * is not translated — better a short English word next to a translated
     * heading than nothing at all, since this is the only diagnostic anybody
     * will ever get from a phone eight hundred kilometres away.
     */
    @Suppress("MissingPermission")
    fun updateInstallFailed(reason: String?) {
        if (reason == null) return // the driver pressed Cancel; that is not a fault
        val notification = updateBuilder()
            .setContentTitle(context.getString(R.string.update_failed, reason))
            .addAction(0, context.getString(R.string.update_retry), startUpdate)
            .build()
        runCatching { manager.notify(UPDATE_ID, notification) }
    }

    /**
     * The system's own confirmation dialog, as something tappable.
     *
     * Used when the download finished while the app was not visible, so the
     * dialog could not simply be shown. Wrapping the platform's intent in our
     * PendingIntent is what lets the driver's tap launch it under our identity.
     */
    @Suppress("MissingPermission")
    fun updateConfirmInstall(confirm: Intent) {
        val notification = updateBuilder()
            .setContentTitle(context.getString(R.string.update_installing))
            .setContentText(context.getString(R.string.update_action))
            .setContentIntent(
                PendingIntent.getActivity(
                    context,
                    4,
                    confirm,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                ),
            )
            .setAutoCancel(true)
            .build()
        runCatching { manager.notify(CONFIRM_INSTALL_ID, notification) }
    }

    fun clearUpdate() {
        runCatching { manager.cancel(UPDATE_ID) }
        runCatching { manager.cancel(CONFIRM_INSTALL_ID) }
    }

    private fun updateBuilder(): NotificationCompat.Builder =
        NotificationCompat.Builder(context, CHANNEL_ID_UPDATE)
            .setSmallIcon(R.drawable.ic_tracking)
            .setColor(ContextCompat.getColor(context, R.color.brand_primary))
            .setOngoing(true)
            .setAutoCancel(false)
            .setSilent(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setCategory(NotificationCompat.CATEGORY_RECOMMENDATION)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setContentIntent(openApp)

    /** High-importance alert. Used when the session is revoked or ends remotely. */
    @Suppress("MissingPermission")
    fun alert(title: String, body: String) {
        val notification = NotificationCompat.Builder(context, CHANNEL_ID_ALERTS)
            .setSmallIcon(R.drawable.ic_tracking)
            .setColor(ContextCompat.getColor(context, R.color.brand_primary))
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()
        runCatching { manager.notify(System.currentTimeMillis().toInt() % 100_000, notification) }
    }
}

/** Notification buttons, so the driver never has to open the app. */
class NotificationActionReceiver : BroadcastReceiver() {

    companion object {
        const val ACTION_STOP = "com.karahoca.tracker.notif.STOP"
        const val ACTION_SYNC = "com.karahoca.tracker.notif.SYNC"
    }

    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            ACTION_STOP -> LocationTrackingService.stop(context)
            ACTION_SYNC -> LocationTrackingService.syncNow(context)
        }
    }
}
