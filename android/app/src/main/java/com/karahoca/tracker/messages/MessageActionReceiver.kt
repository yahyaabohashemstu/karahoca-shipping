package com.karahoca.tracker.messages

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * The "read" button on a message notification.
 *
 * A broadcast rather than an activity, unlike Stop and Update: marking a
 * message read needs no question and no system dialog, and a driver who has
 * read the whole thing in the shade should not be thrown into the app to say
 * so. The read is saved before the receipt is attempted, so the timeout only
 * ever costs the receipt's timing, never the read itself.
 */
@AndroidEntryPoint
class MessageActionReceiver : BroadcastReceiver() {

    @Inject lateinit var messages: MessageRepository

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_READ) return
        val id = intent.getStringExtra(EXTRA_MESSAGE_ID) ?: return

        val pending = goAsync()
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            try {
                // Inside the ten seconds a receiver is given; the receipt that
                // misses it is sent by the next upload.
                withTimeoutOrNull(8_000) { messages.markReadNow(id) }
            } catch (e: Exception) {
                Log.e("KH/Messages", "Read from the notification failed", e)
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        const val ACTION_READ = "com.karahoca.tracker.message.READ"
        const val EXTRA_MESSAGE_ID = "message_id"
    }
}
