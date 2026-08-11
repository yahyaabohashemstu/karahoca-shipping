package com.karahoca.tracker.data.remote

import com.karahoca.tracker.data.local.SessionStore
import kotlinx.coroutines.runBlocking
import okhttp3.Interceptor
import okhttp3.MediaType
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.Response
import okio.Buffer
import okio.BufferedSink
import okio.GzipSink
import okio.buffer
import java.security.SecureRandom
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Attach the driver's bearer token.
 *
 * Endpoints that mint credentials (`claim`, `token/refresh`) are skipped —
 * they authenticate against secrets in the body instead.
 */
@Singleton
class AuthInterceptor @Inject constructor(
    private val store: SessionStore,
) : Interceptor {

    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        val path = request.url.encodedPath
        if (path.endsWith("/driver/claim") || path.endsWith("/driver/token/refresh")) {
            return chain.proceed(request)
        }
        val token = runBlocking { store.accessToken() } ?: return chain.proceed(request)
        return chain.proceed(
            request.newBuilder().header("Authorization", "Bearer $token").build(),
        )
    }
}

/**
 * Gzip the request body when the call is annotated `Content-Encoding: gzip`.
 *
 * Compression is the single highest-leverage thing the app does on a bad
 * connection: a 5,000-point backlog is ~1.4 MB of JSON and ~140 KB gzipped.
 * On a 2G edge cell that is the difference between an upload that completes in
 * the 40 seconds of coverage the truck has and one that does not.
 *
 * MUST run AFTER [SigningInterceptor] in the chain: the HMAC covers the
 * uncompressed JSON, which is what the server hashes after its own preParsing
 * decompression. See the ordering note in AppModule.okHttpClient.
 */
@Singleton
class GzipRequestInterceptor @Inject constructor() : Interceptor {

    override fun intercept(chain: Interceptor.Chain): Response {
        val original = chain.request()
        val body = original.body
        if (body == null || original.header("Content-Encoding") != "gzip") {
            return chain.proceed(original)
        }
        // Tiny bodies (a single ping) cost more in CPU and headers than they save.
        if (body.contentLength() in 0..512) {
            return chain.proceed(original.newBuilder().removeHeader("Content-Encoding").build())
        }
        return chain.proceed(
            original.newBuilder()
                .method(original.method, gzip(body))
                .build(),
        )
    }

    private fun gzip(body: RequestBody): RequestBody = object : RequestBody() {
        override fun contentType(): MediaType? = body.contentType()

        /**
         * -1 means "unknown", which forces chunked transfer encoding. We instead
         * compress once into a buffer so Content-Length is exact: some mobile
         * carrier proxies mishandle chunked POSTs, and a truck in a rural cell
         * is exactly where that bites.
         */
        private val compressed: Buffer by lazy {
            Buffer().also { buffer ->
                GzipSink(buffer).buffer().use { gzipSink -> body.writeTo(gzipSink) }
            }
        }

        override fun contentLength(): Long = compressed.size

        override fun writeTo(sink: BufferedSink) {
            sink.write(compressed.clone(), compressed.size)
        }
    }
}

/**
 * Per-request HMAC (ADR-009).
 *
 *     X-KH-Timestamp : clock-corrected epoch seconds
 *     X-KH-Nonce     : 16 random bytes, hex
 *     X-KH-Signature : HMAC-SHA256(ingestKey, "ts.nonce.sha256hex(body)")
 *
 * The signature binds the *uncompressed body bytes*, so a captured bearer token
 * alone cannot be replayed with different coordinates, and the nonce +
 * timestamp mean the same body cannot be replayed either. Because it covers the
 * payload rather than the wire encoding, gzip is applied afterwards and remains
 * a pure transport concern.
 *
 * `runBlocking` is acceptable here: OkHttp interceptors run on the dispatcher's
 * background thread pool, never on the main thread, and the reads are from a
 * warm in-memory DataStore.
 */
@Singleton
class SigningInterceptor @Inject constructor(
    private val store: SessionStore,
) : Interceptor {

    private val random = SecureRandom()

    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        val path = request.url.encodedPath
        if (path.endsWith("/driver/claim") || path.endsWith("/driver/token/refresh")) {
            return chain.proceed(request)
        }

        val key = runBlocking { store.ingestKey() } ?: return chain.proceed(request)

        val bodyBytes = request.body?.let { body ->
            Buffer().also { body.writeTo(it) }.readByteArray()
        } ?: ByteArray(0)

        // Corrected clock: a driver's phone that is two hours off still signs
        // something the server accepts.
        val timestamp = (runBlocking { store.correctedNowMs() } / 1000).toString()
        val nonce = ByteArray(16).also(random::nextBytes).toHex()
        val bodyHash = sha256(bodyBytes).toHex()

        val signature = hmacSha256(key, "$timestamp.$nonce.$bodyHash").toHex()

        return chain.proceed(
            request.newBuilder()
                .header("X-KH-Timestamp", timestamp)
                .header("X-KH-Nonce", nonce)
                .header("X-KH-Signature", signature)
                .build(),
        )
    }

    private fun sha256(bytes: ByteArray): ByteArray =
        java.security.MessageDigest.getInstance("SHA-256").digest(bytes)

    private fun hmacSha256(key: ByteArray, message: String): ByteArray =
        Mac.getInstance("HmacSHA256").apply {
            init(SecretKeySpec(key, "HmacSHA256"))
        }.doFinal(message.toByteArray(Charsets.UTF_8))
}

private const val HEX = "0123456789abcdef"

private fun ByteArray.toHex(): String {
    val out = CharArray(size * 2)
    for (i in indices) {
        val v = this[i].toInt() and 0xFF
        out[i * 2] = HEX[v ushr 4]
        out[i * 2 + 1] = HEX[v and 0x0F]
    }
    return String(out)
}

/**
 * Retry once on a connection-level failure.
 *
 * OkHttp's own `retryOnConnectionFailure` does not cover the case that matters
 * here: the radio waking from Doze and dropping the first TCP handshake. One
 * cheap retry converts a large fraction of "no coverage" errors into successes.
 */
@Singleton
class RadioWakeRetryInterceptor @Inject constructor() : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request: Request = chain.request()
        return try {
            chain.proceed(request)
        } catch (e: java.io.IOException) {
            if (chain.call().isCanceled()) throw e
            Thread.sleep(1_200)
            chain.proceed(request)
        }
    }
}
