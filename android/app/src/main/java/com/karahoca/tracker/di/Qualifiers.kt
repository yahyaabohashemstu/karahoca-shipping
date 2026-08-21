package com.karahoca.tracker.di

import javax.inject.Qualifier

/**
 * A CoroutineScope that outlives any single component.
 *
 * Needed because the two moments most worth recording are exactly the moments a
 * scoped CoroutineScope is being torn down:
 *
 *   - `Service.onDestroy` cancels `lifecycleScope` in its super call, so a
 *     `lifecycleScope.launch { recordLocalEvent(...) }` there is cancelled
 *     before it runs. The SERVICE_KILLED event never reaches the buffer, and
 *     the dispatcher sees an unexplained gap.
 *   - `stopSelf()` from a failed `startForeground` has the same problem.
 *
 * Work launched here is fire-and-forget diagnostics only. Anything that must
 * not be lost belongs in Room, not in a coroutine.
 */
@Qualifier
@Retention(AnnotationRetention.BINARY)
annotation class ApplicationScope

/**
 * The HTTP client for update checks and APK downloads.
 *
 * Separate from the tracking client, which is wrong for this in three ways:
 * its AuthInterceptor would attach a driver's bearer token to a request for a
 * public file, its SigningInterceptor buffers the body to HMAC it, and its
 * 180-second callTimeout — generous for a telemetry batch — would abort a
 * 24 MB download on a rural cell somewhere around the eighth megabyte.
 */
@Qualifier
@Retention(AnnotationRetention.BINARY)
annotation class UpdateClient
