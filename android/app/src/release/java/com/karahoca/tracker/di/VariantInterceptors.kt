package com.karahoca.tracker.di

import okhttp3.Interceptor

/**
 * Release variant: no extra interceptors.
 *
 * Deliberately empty. The debug counterpart in `src/debug` adds HTTP logging;
 * keeping that dependency out of the release source set means the shipped APK
 * cannot log request bodies containing a driver's positions, and R8 has nothing
 * to strip.
 *
 * Must keep the same package and object name as the debug copy — Android merges
 * `main + <variant>`, and `main` code binds to whichever one is present.
 */
object VariantInterceptors {

    fun create(): List<Interceptor> = emptyList()
}
