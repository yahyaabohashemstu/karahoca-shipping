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
