package com.karahoca.tracker.messages

import android.content.Context
import android.os.SystemClock
import android.util.Log
import com.karahoca.tracker.data.local.SessionStore
import com.karahoca.tracker.data.remote.MessageAckRequest
import com.karahoca.tracker.data.remote.TrackingApi
import com.karahoca.tracker.di.ApplicationScope
import com.karahoca.tracker.service.TrackingNotification
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json

/**
 * Messages from the desk to this phone's shipment.
 *
 * There is no push channel — no FCM on a sideloaded fleet, nothing listening on
 * a socket — so the phone goes and gets them. Three things send it:
 *
 *  - **the ingest hint.** Every upload's response says how many messages are
 *    waiting. A tracking phone uploads every ten to fifteen seconds, so a
 *    message reaches a moving lorry within one upload cycle.
 *  - **the sync worker**, every fifteen minutes, for a phone that is not
 *    tracking and so is not uploading anything the server could answer.
 *  - **the driver opening the app.**
 *
 * Each message is notified exactly once, shown on screen until the driver
 * presses "read", and receipted back so the dispatcher can see it arrived and
 * that it was read. The receipts are kept on disk until the server confirms
 * them, because a driver reads a message in a tunnel as readily as anywhere.
 */
@Singleton
class MessageRepository @Inject constructor(
    @ApplicationContext private val context: Context,
    private val api: TrackingApi,
    private val store: SessionStore,
    private val notifications: TrackingNotification,
    private val json: Json,
    @ApplicationScope private val appScope: CoroutineScope,
) {

    private val _messages = MutableStateFlow<List<DriverMessage>>(emptyList())

    /** Newest first, for the screen. */
    val messages: StateFlow<List<DriverMessage>> = _messages.asStateFlow()

    /*
     * Two locks, because one was a trap.
     *
     * [state] guards the copy on disk and is only ever held for a read-modify-
     * write. [network] serialises fetches and receipts, and is held across
     * HTTP calls that can take a minute on a rural cell. Under one lock, a
     * driver pressing "read" while a fetch was in flight waited for the fetch —
     * and the notification's button, which has ten seconds to finish, could
     * time out before the read was even saved.
     */
    private val state = Mutex()
    private val network = Mutex()

    /** In-memory copy of what is on disk. Touched only under [state]. */
    private var thread: StoredThread? = null

    @Volatile private var lastFetchAt = 0L
    @Volatile private var lastHintAt = 0L
    @Volatile private var receiptsOwed = false

    private val prefs by lazy { context.getSharedPreferences(PREFS, Context.MODE_PRIVATE) }

    init {
        // Off the thread that built this singleton, which can be the main one.
        appScope.launch {
            runCatching { state.withLock { store.sessionId()?.let { loadLocked(it) } } }
                .onFailure { Log.e(TAG, "Could not restore messages", it) }
        }
    }

    // =========================================================================
    // Triggers
    // =========================================================================

    /**
     * The ingest response's count of undelivered messages.
     *
     * Called on every upload, so it does nothing unless there is something to
     * do: a non-zero count, or a read receipt still waiting for the server —
     * the moment a lorry comes out of a dead zone is the moment to send it.
     * Never suspends the upload that carried it.
     */
    fun onServerHint(pending: Int?) {
        if (pending == null) return // a server that predates messages said nothing
        lastHintAt = SystemClock.elapsedRealtime()
        if (pending <= 0 && !receiptsOwed) return
        appScope.launch { runCatching { sync(minIntervalMs = HINT_MIN_INTERVAL_MS) } }
    }

    /**
     * The sync worker's fifteen-minute check.
     *
     * Skipped while the ingest hint is current. A tracking phone is told about
     * new messages on every upload, and asking again every fifteen minutes
     * would be twenty requests a day per lorry to learn nothing.
     */
    suspend fun syncIfStale() {
        val hintFresh = SystemClock.elapsedRealtime() - lastHintAt < HINT_FRESH_MS
        if (lastHintAt > 0 && hintFresh && !receiptsOwed) return
        sync()
    }

    // =========================================================================
    // The work
    // =========================================================================

    /**
     * Fetch, notify what is new, and send whatever receipts are owed.
     *
     * @param minIntervalMs skip if a fetch succeeded more recently than this.
     * @return whether the server answered.
     */
    suspend fun sync(minIntervalMs: Long = 0): Boolean = withContext(Dispatchers.IO) {
        network.withLock {
            if (minIntervalMs > 0 && SystemClock.elapsedRealtime() - lastFetchAt < minIntervalMs) {
                return@withLock true
            }
            val sessionId = store.sessionId() ?: run {
                state.withLock { clearLocked() }
                return@withLock false
            }

            val response = runCatching { api.messages() }
                .onFailure { Log.d(TAG, "Message fetch failed: ${it.javaClass.simpleName}") }
                .getOrNull()
            if (response == null || !response.isSuccessful) {
                // 401 included: the token is refreshed by the upload path, and
                // the next hint or worker run comes back here with a fresh one.
                response?.let { Log.d(TAG, "Message fetch refused: HTTP ${it.code()}") }
                return@withLock false
            }
            lastFetchAt = SystemClock.elapsedRealtime()
            val body = response.body() ?: return@withLock false
            if (body.serverTime > 0) store.recordServerTime(body.serverTime)

            val fresh = state.withLock {
                val current = loadLocked(sessionId)
                val merged = current.copy(messages = mergeMessages(current.messages, body.messages))
                saveLocked(merged)
                toAnnounce(merged.messages)
            }

            /*
             * Notified after the save, and marked after the notification. If
             * the process dies in between, the next pass finds the message
             * still un-notified and posts it then: a driver may see a message
             * announced twice in that window, but never not at all.
             */
            if (fresh.isNotEmpty()) {
                val order = runCatching { store.status().orderNumber }.getOrNull()
                fresh.forEach { notifications.driverMessage(it.id, it.body, it.sentAt, order) }
                val ids = fresh.mapTo(HashSet()) { it.id }
                state.withLock {
                    val current = loadLocked(sessionId)
                    saveLocked(
                        current.copy(
                            messages = current.messages.map {
                                if (it.id in ids) it.copy(notified = true) else it
                            },
                        ),
                    )
                }
                Log.i(TAG, "${fresh.size} new message(s) from the desk")
            }

            pushReceipts(sessionId)
            true
        }
    }

    /** The driver pressed "read", in the app. Returns at once; the receipt follows. */
    fun markRead(id: String) {
        appScope.launch { runCatching { markReadNow(id) } }
    }

    /**
     * The driver pressed "read". Saved and shown before anything touches the
     * network, so the card goes away the moment the button is pressed whatever
     * the coverage, and the receipt goes whenever it can.
     */
    suspend fun markReadNow(id: String) = withContext(Dispatchers.IO) {
        val sessionId = store.sessionId() ?: return@withContext
        val at = store.correctedNowMs()
        state.withLock {
            val current = loadLocked(sessionId)
            saveLocked(
                current.copy(
                    messages = current.messages.map {
                        if (it.id == id && !it.read) it.copy(read = true, readAt = at, notified = true) else it
                    },
                ),
            )
        }
        notifications.cancelMessage(id)
        network.withLock { pushReceipts(sessionId) }
    }

    /** The shipment is over on this phone. */
    suspend fun clear() = withContext(Dispatchers.IO) {
        state.withLock { clearLocked() }
    }

    // =========================================================================
    // Internals — the *Locked functions are called with [state] held
    // =========================================================================

    /** Send what the server has not been told. Called with [network] held. */
    private suspend fun pushReceipts(sessionId: String) {
        val owed = state.withLock { owedReceipts(loadLocked(sessionId).messages) }
        if (owed.isEmpty) return

        val response = runCatching {
            api.ackMessages(MessageAckRequest(delivered = owed.delivered, read = owed.read))
        }.getOrNull() ?: return // offline: kept on disk, sent on the next pass

        /*
         * Settled on success, and also on a refusal that retrying the same
         * bytes cannot change — a malformed id, a session that has closed.
         * Otherwise one poisoned receipt would be resent on every upload for
         * the rest of the shift.
         */
        val code = response.code()
        if (!response.isSuccessful && code !in PERMANENT_REFUSALS) {
            Log.d(TAG, "Receipts refused for now: HTTP $code")
            return
        }
        if (!response.isSuccessful) Log.w(TAG, "Receipts dropped: HTTP $code")

        // Applied to the state as it is NOW, by id: a read pressed while this
        // request was in flight is not in `owed`, and stays owed.
        state.withLock {
            val current = loadLocked(sessionId)
            saveLocked(current.copy(messages = settle(current.messages, owed)))
        }
    }

    private fun loadLocked(sessionId: String): StoredThread {
        thread?.takeIf { it.sessionId == sessionId }?.let { return it }

        val stored = runCatching {
            prefs.getString(KEY_THREAD, null)?.let { json.decodeFromString(StoredThread.serializer(), it) }
        }.onFailure { Log.w(TAG, "Discarding unreadable message store", it) }.getOrNull()

        val loaded = if (stored?.sessionId == sessionId) {
            stored
        } else {
            // Another shipment's messages: their notifications go with them.
            stored?.messages?.forEach { notifications.cancelMessage(it.id) }
            StoredThread(sessionId)
        }
        publish(loaded)
        return loaded
    }

    private fun saveLocked(updated: StoredThread) {
        runCatching {
            prefs.edit()
                .putString(KEY_THREAD, json.encodeToString(StoredThread.serializer(), updated))
                .apply()
        }.onFailure { Log.e(TAG, "Could not save messages", it) }
        publish(updated)
    }

    private fun clearLocked() {
        // From disk when nothing was loaded: the process may have been started
        // by the very tap that ends the session, with notifications still up.
        val known = thread ?: runCatching {
            prefs.getString(KEY_THREAD, null)?.let { json.decodeFromString(StoredThread.serializer(), it) }
        }.getOrNull()
        known?.messages?.forEach { notifications.cancelMessage(it.id) }
        runCatching { prefs.edit().remove(KEY_THREAD).apply() }
        thread = null
        receiptsOwed = false
        _messages.value = emptyList()
    }

    private fun publish(current: StoredThread) {
        thread = current
        receiptsOwed = !owedReceipts(current.messages).isEmpty
        _messages.value = current.messages.map { it.toUi() }
    }

    private companion object {
        const val TAG = "KH/Messages"
        const val PREFS = "driver_messages"
        const val KEY_THREAD = "thread"

        /**
         * Hints arrive every upload; a count that stays non-zero — because a
         * receipt keeps failing — must not become a fetch every ten seconds.
         */
        const val HINT_MIN_INTERVAL_MS = 10_000L

        /** A hint younger than this means the worker's own check is redundant. */
        const val HINT_FRESH_MS = 10 * 60 * 1000L

        val PERMANENT_REFUSALS = setOf(400, 403, 404, 409, 410, 422)
    }
}
