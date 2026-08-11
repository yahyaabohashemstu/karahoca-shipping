package com.karahoca.tracker.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
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

    /** High-importance alert. Used when the session is revoked or ends remotely. */
    @Suppress("MissingPermission")
    fun alert(title: String, body: String) {
        val notification = NotificationCompat.Builder(context, CHANNEL_ID_ALERTS)
            .setSmallIcon(R.drawable.ic_tracking)
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
