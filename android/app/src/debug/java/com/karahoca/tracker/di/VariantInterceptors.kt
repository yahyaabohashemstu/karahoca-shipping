package com.karahoca.tracker.di

import okhttp3.Interceptor
import okhttp3.logging.HttpLoggingInterceptor

/**
 * Debug variant: attach HTTP logging.
 *
 * This exists as a per-source-set object rather than an `if (BuildConfig.DEBUG)`
 * branch inside AppModule because `okhttp-logging-interceptor` is a
 * `debugImplementation` dependency. `BuildConfig.DEBUG` is a *runtime* constant,
 * so a reference guarded by it still has to compile against the release
 * classpath — where the class does not exist. That failure is invisible to a
 * debug build and breaks `assembleRelease` only.
 *
 * Android merges `main + <variant>` source sets, so code in `main` referencing
 * `VariantInterceptors` binds to whichever copy belongs to the variant being
 * built. The release binary therefore contains no logging code at all — smaller,
 * and with no way to leak request logs on a driver's phone.
 */
object VariantInterceptors {

    fun create(): List<Interceptor> = listOf(
        // BASIC, not BODY: a 5,000-point batch logged in full would flood
        // logcat and make the very failures we are debugging unreadable.
        HttpLoggingInterceptor().apply { level = HttpLoggingInterceptor.Level.BASIC },
    )
}
