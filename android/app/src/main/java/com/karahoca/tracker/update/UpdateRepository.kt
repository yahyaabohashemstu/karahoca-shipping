package com.karahoca.tracker.update

import android.content.Context
import android.util.Log
import com.karahoca.tracker.BuildConfig
import com.karahoca.tracker.R
import com.karahoca.tracker.di.ApplicationScope
import com.karahoca.tracker.di.UpdateClient
import com.karahoca.tracker.service.TrackingNotification
import com.karahoca.tracker.util.AppLocale
import dagger.hilt.android.qualifiers.ApplicationContext
import java.io.File
import java.security.MessageDigest
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request

/**
 * Getting a new build onto a phone that has no app store.
 *
 * The fleet is sideloaded: no Play Store, no update channel, no way to push
 * anything. Before this existed, a fixed bug reached a driver only when
 * somebody telephoned them and talked them through re-downloading the APK, and
 * three releases in a row failed to reach anybody at all.
 *
 * The design is deliberately conservative about the one resource a driver is
 * paying for on a road in northern Iraq:
 *
 *  - the check is a few hundred bytes of JSON, throttled to once every six
 *    hours, and piggybacks on work that was already going to run;
 *  - **nothing is downloaded until the driver presses the button.** 24 MB on a
 *    roaming mobile plan is not a decision the app gets to make for them, which
 *    is also why the banner shows the size before they commit;
 *  - the download resumes nothing and retries nothing on its own. A failed
 *    attempt leaves the partial file behind for the next press.
 *
 * The notification is re-posted on every check rather than remembered as
 * dismissed. That is the "semi-permanent" behaviour the yard asked for: a
 * driver can swipe it away and get on with the run, and it comes back.
 */
@Singleton
class UpdateRepository @Inject constructor(
    @ApplicationContext private val context: Context,
    @UpdateClient private val client: OkHttpClient,
    @ApplicationScope private val appScope: CoroutineScope,
    private val json: Json,
    private val notifications: TrackingNotification,
    private val installer: UpdateInstaller,
) {

    private val _state = MutableStateFlow<UpdateState>(UpdateState.Idle)
    val state: StateFlow<UpdateState> = _state.asStateFlow()

    /** One download at a time; a second press while one runs is ignored. */
    private var job: Job? = null

    private val prefs by lazy { context.getSharedPreferences(PREFS, Context.MODE_PRIVATE) }

    init {
        /*
         * On the application scope, not here on the calling thread.
         *
         * This singleton is built wherever Hilt first needs it, and since the
         * updater became a dependency of TrackingRepository that is the main
         * thread, while an activity is being created. Reading a preferences
         * file for the first time there is a disk hit on the frame the driver
         * is waiting for.
         *
         * The cost of deferring it is that state() reads Idle for a moment
         * after process start. Nothing depends on it being instant: the banner
         * appears a frame later, and the notification path already re-checks
         * when it finds Idle.
         */
        appScope.launch { restorePendingRelease() }
    }

    private suspend fun restorePendingRelease() = withContext(Dispatchers.IO) {
        /*
         * A pending release has to survive process death, and on this app the
         * process dies constantly — an OEM kill, a low-memory kill, a reboot.
         *
         * Without this the state started Idle on every restart and the check
         * that would refill it is throttled to six hours, so the banner
         * vanished for the rest of the day and the notification's Update button
         * did nothing at all: it opens the activity, which asks the repository
         * what to install, and the repository had forgotten.
         */
        runCatching {
            val pending = prefs.getString(KEY_PENDING, null)
                ?.let { json.decodeFromString(UpdateManifest.serializer(), it) }
            when {
                pending == null -> Unit
                pending.isNewerThanInstalled -> _state.value = UpdateState.Available(pending)
                /*
                 * This process IS the release the last one was told about — so
                 * the update either just installed itself or the driver did it
                 * by hand from the website. Either way the note is spent, and
                 * leaving it would mean the next check reads a manifest it has
                 * already acted on.
                 */
                else -> {
                    prefs.edit().remove(KEY_PENDING).apply()
                    notifications.clearUpdate()
                }
            }
        }
    }

    // =========================================================================
    // Checking
    // =========================================================================

    /**
     * Ask the server what the newest build is.
     *
     * Silent about failures by design. This runs from process start and from
     * the sync worker, on a phone that is offline for hours at a time; a driver
     * does not need to be told that a version check could not reach the server
     * while they are in a tunnel.
     *
     * @param force skip the six-hour throttle. Used when the driver has the app
     *   open and is looking at the banner.
     */
    suspend fun check(force: Boolean = false) = withContext(Dispatchers.IO) {
        /*
         * The whole body on IO, not just the request.
         *
         * It used to be called only from background scopes, so the
         * SharedPreferences reads and the notification post inherited a worker
         * thread for free. Then the app-open path started calling it from
         * viewModelScope — Dispatchers.Main.immediate — and quietly moved a
         * first-touch preferences load and a binder call onto the thread
         * drawing the screen the driver had just opened.
         */
        if (!force && !dueForCheck()) return@withContext
        val manifest = runCatching { fetchManifest() }
            .onFailure { Log.d(TAG, "Version check failed: ${it.javaClass.simpleName}") }
            .getOrNull() ?: return@withContext

        prefs.edit().putLong(KEY_LAST_CHECK, System.currentTimeMillis()).apply()

        if (!manifest.isNewerThanInstalled) {
            /*
             * Covers the moment after a successful self-update: the new process
             * checks, finds itself current, and clears the notification the old
             * one left on screen.
             */
            if (_state.value !is UpdateState.Idle) _state.value = UpdateState.Idle
            prefs.edit().remove(KEY_PENDING).apply()
            notifications.clearUpdate()
            return@withContext
        }

        // Never interrupt a download or an install with a fresh "available".
        when (_state.value) {
            is UpdateState.Downloading, is UpdateState.Verifying, is UpdateState.Installing ->
                return@withContext
            else -> Unit
        }

        Log.i(TAG, "Update available: ${manifest.versionName} (${manifest.versionCode})")
        runCatching {
            prefs.edit()
                .putString(KEY_PENDING, json.encodeToString(UpdateManifest.serializer(), manifest))
                .apply()
        }
        _state.value = UpdateState.Available(manifest)
        notifications.updateAvailable(manifest.versionName)
    }

    /**
     * The server, on a telemetry response, mentioning a build newer than ours.
     *
     * Self-limiting by design, and it has to be: a tracking phone posts every
     * ten seconds, so anything that fetched the manifest on each hint would
     * make one release into several thousand requests per driver per shift.
     * Once the check has produced a state — Available, or a download in flight,
     * or a failure the driver is looking at — further hints are ignored, and
     * the one fetch this triggers is the same one the six-hourly timer would
     * have done later.
     */
    suspend fun onServerHint(releasedBuild: Int?) {
        if (releasedBuild == null || releasedBuild <= BuildConfig.VERSION_CODE) return
        if (_state.value !is UpdateState.Idle) return
        Log.i(TAG, "Server mentioned build $releasedBuild — checking now")
        check(force = true)
    }

    private fun dueForCheck(): Boolean =
        System.currentTimeMillis() - prefs.getLong(KEY_LAST_CHECK, 0L) > CHECK_INTERVAL_MS

    private suspend fun fetchManifest(): UpdateManifest = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url(BuildConfig.UPDATE_MANIFEST_URL)
            /*
             * Who is asking.
             *
             * The server keeps the last few of these so a dispatcher who has
             * just pressed the release button can see whether any phone
             * actually came to look. Without it the question is unanswerable
             * from the outside: the API logs nothing per request, and the one
             * time it was asked in anger the answer took an hour to not find.
             */
            .header("X-KH-App-Build", BuildConfig.VERSION_CODE.toString())
            // The file is small and changes rarely; a stale cached copy would
            // hide a release for as long as the cache lived.
            .header("Cache-Control", "no-cache")
            .build()
        client.newCall(request).execute().use { response ->
            val body = response.body?.string()
            require(response.isSuccessful && body != null) { "HTTP ${response.code}" }
            json.decodeFromString(UpdateManifest.serializer(), body)
        }
    }

    // =========================================================================
    // Downloading and installing
    // =========================================================================

    /**
     * The whole update, from the driver's press to the system's dialog.
     *
     * Runs on [ApplicationScope] rather than a UI scope: the driver will lock
     * the phone and put it in the door pocket, and a download tied to the
     * composition would die with the screen. While a shipment is running the
     * foreground service is holding the process up anyway.
     */
    fun start() {
        val manifest = _state.value.manifestOrNull ?: return
        if (job?.isActive == true) return

        if (!installer.canInstall()) {
            _state.value = UpdateState.Failed(
                manifest = manifest,
                reason = context.getString(R.string.update_allow_unknown_why),
                needsUnknownSources = true,
            )
            return
        }

        job = appScope.launch {
            try {
                _state.value = UpdateState.Downloading(manifest, 0)
                val apk = download(manifest)

                _state.value = UpdateState.Verifying(manifest)
                notifications.updateVerifying()
                val digest = withContext(Dispatchers.IO) { sha256(apk) }
                if (!digest.equals(manifest.sha256, ignoreCase = true)) {
                    apk.delete()
                    throw IllegalStateException(context.getString(R.string.update_error_checksum))
                }

                _state.value = UpdateState.Installing(manifest)
                notifications.updateInstalling()
                withContext(Dispatchers.IO) { installer.install(apk) }
                // Nothing after this is ours: the platform shows its dialog and,
                // if the driver accepts, replaces this process. BootReceiver
                // picks the session back up on MY_PACKAGE_REPLACED.
            } catch (e: Exception) {
                Log.e(TAG, "Update failed", e)
                _state.value = UpdateState.Failed(manifest, e.message ?: e.javaClass.simpleName)
                notifications.updateFailed(manifest.versionName)
            }
        }
    }

    /** The Settings screen where "install unknown apps" is granted. */
    fun unknownSourcesIntent() = installer.unknownSourcesIntent()

    /** The driver has been sent to Settings; re-check the grant when they return. */
    fun onReturnedFromSettings() {
        val manifest = _state.value.manifestOrNull ?: return
        if (_state.value is UpdateState.Failed && installer.canInstall()) {
            _state.value = UpdateState.Available(manifest)
        }
    }

    private suspend fun download(manifest: UpdateManifest): File = withContext(Dispatchers.IO) {
        val dir = File(context.filesDir, DIR).apply { mkdirs() }
        val target = File(dir, "karahoca-${manifest.versionCode}.apk")

        // One release at a time on a phone that may have 2 GB free.
        dir.listFiles()?.forEach { if (it.name != target.name) it.delete() }

        // A previous attempt may already have finished the bytes and failed at
        // the install; the checksum above is what decides whether to trust it.
        if (target.isFile && target.length() > 0) return@withContext target

        val partial = File(dir, target.name + ".part")
        partial.delete()

        val request = Request.Builder().url(manifest.url).build()
        client.newCall(request).execute().use { response ->
            val body = response.body
            require(response.isSuccessful && body != null) { "HTTP ${response.code}" }

            val total = if (manifest.sizeBytes > 0) manifest.sizeBytes else body.contentLength()
            partial.outputStream().use { out ->
                body.byteStream().use { input ->
                    val buffer = ByteArray(64 * 1024)
                    var written = 0L
                    var lastPercent = -1
                    while (true) {
                        // Cancels the loop if the scope goes down mid-download
                        // instead of writing the rest of 24 MB to a file
                        // nobody will read.
                        ensureActive()
                        val read = input.read(buffer)
                        if (read < 0) break
                        out.write(buffer, 0, read)
                        written += read
                        if (total > 0) {
                            val percent = ((written * 100) / total).toInt().coerceIn(0, 100)
                            // Repainting a notification per 64 KB chunk is ~380
                            // wake-ups of SystemUI for one download.
                            if (percent != lastPercent) {
                                lastPercent = percent
                                _state.value = UpdateState.Downloading(manifest, percent)
                                notifications.updateProgress(manifest.versionName, percent)
                            }
                        }
                    }
                }
            }
        }

        check(partial.renameTo(target)) { "could not move the download into place" }
        target
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        // toInt() and 0xFF, or a byte above 0x7F sign-extends and formats as
        // "ffffffb4" — the comparison against the manifest then fails on every
        // file whose hash happens to contain a high byte, which is all of them.
        return digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xFF) }
    }

    /** Release notes in the driver's language, for the banner. */
    fun notesFor(manifest: UpdateManifest): String? =
        manifest.notesFor(AppLocale.current(context).ifEmpty { "tr" })

    private companion object {
        const val TAG = "KH/Update"
        const val PREFS = "app_update"
        const val KEY_LAST_CHECK = "last_check_at"
        const val KEY_PENDING = "pending_manifest"
        const val DIR = "updates"

        /**
         * One hour, for the background timer only.
         *
         * It was six, and six was wrong in a way that only showed up the first
         * time somebody pressed the release button and watched a phone: a
         * driver who had opened the app an hour earlier could not be told about
         * a release until the afternoon, and from the outside that is
         * indistinguishable from the button not working.
         *
         * An hour costs at most twenty-four requests a day for a few hundred
         * bytes each — about 12 KB, against the 24 MB the driver is being
         * offered. The paths that actually matter no longer wait for this timer
         * at all: opening the app forces a check, and a tracking phone is told
         * on its next telemetry response.
         */
        const val CHECK_INTERVAL_MS = 60 * 60 * 1000L
    }
}
