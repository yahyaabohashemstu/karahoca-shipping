package com.karahoca.tracker.di

import android.content.Context
import com.karahoca.tracker.BuildConfig
import com.karahoca.tracker.data.local.LocationPointDao
import com.karahoca.tracker.data.local.PendingEventDao
import com.karahoca.tracker.data.local.TrackerDatabase
import com.karahoca.tracker.data.remote.AuthInterceptor
import com.karahoca.tracker.data.remote.GzipRequestInterceptor
import com.karahoca.tracker.data.remote.RadioWakeRetryInterceptor
import com.karahoca.tracker.data.remote.SigningInterceptor
import com.karahoca.tracker.data.remote.TrackingApi
import com.jakewharton.retrofit2.converter.kotlinx.serialization.asConverterFactory
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import retrofit2.Retrofit
import java.util.concurrent.TimeUnit
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object AppModule {

    @Provides
    @Singleton
    @ApplicationScope
    fun applicationScope(): CoroutineScope =
        CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @Provides
    @Singleton
    fun database(@ApplicationContext context: Context): TrackerDatabase =
        TrackerDatabase.build(context)

    @Provides
    fun locationPointDao(db: TrackerDatabase): LocationPointDao = db.locationPointDao()

    @Provides
    fun pendingEventDao(db: TrackerDatabase): PendingEventDao = db.pendingEventDao()

    // SessionStore is bound by its @Inject constructor — adding a @Provides for
    // it here would be a duplicate binding and fail the Dagger build.

    @Provides
    @Singleton
    fun json(): Json = Json {
        ignoreUnknownKeys = true   // a newer server must never break an older APK
        encodeDefaults = true
        explicitNulls = false      // omit nulls: ~15% smaller payloads on backlogs
        coerceInputValues = true
    }

    @Provides
    @Singleton
    fun okHttpClient(
        auth: AuthInterceptor,
        gzip: GzipRequestInterceptor,
        signing: SigningInterceptor,
        retry: RadioWakeRetryInterceptor,
    ): OkHttpClient = OkHttpClient.Builder()
        /*
         * Interceptor ORDER IS LOAD-BEARING.
         *
         *   auth    → adds the bearer token
         *   signing → HMACs sha256 of the UNCOMPRESSED JSON body
         *   gzip    → compresses the body for transport
         *
         * The signature deliberately covers the *semantic payload*, not the
         * transmitted bytes. The server decompresses in a preParsing hook
         * before the body reaches the raw-body parser, so it hashes the
         * uncompressed JSON too — and because Content-Encoding is then purely
         * a transport concern, a proxy that re-encodes the request cannot
         * break authentication.
         *
         * Swapping these two lines makes every gzipped upload fail with
         * BAD_SIGNATURE. There is an e2e test that fails if you do.
         */
        .addInterceptor(auth)
        .addInterceptor(signing)
        .addInterceptor(gzip)
        .addInterceptor(retry)
        // Resolved per source set: logging in debug, nothing in release. See
        // VariantInterceptors — an `if (BuildConfig.DEBUG)` branch here would
        // not compile against the release classpath.
        .apply { VariantInterceptors.create().forEach(::addInterceptor) }
        /*
         * Generous timeouts. A truck on a 2G edge cell uploading a 250 KB
         * gzipped backlog needs time; failing at 10 s would mean it can never
         * catch up, and every failure costs another radio wake-up.
         */
        .connectTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(120, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .callTimeout(180, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        // Keep-alive across the 15 s pump interval avoids a TLS handshake per
        // ping — meaningful battery and latency savings over a 14-hour shift.
        .connectionPool(okhttp3.ConnectionPool(2, 5, TimeUnit.MINUTES))
        .build()

    @Provides
    @Singleton
    fun retrofit(client: OkHttpClient, json: Json): Retrofit = Retrofit.Builder()
        .baseUrl(BuildConfig.DEFAULT_API_BASE_URL)
        .client(client)
        .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
        .build()

    @Provides
    @Singleton
    fun trackingApi(retrofit: Retrofit): TrackingApi = retrofit.create(TrackingApi::class.java)
}
