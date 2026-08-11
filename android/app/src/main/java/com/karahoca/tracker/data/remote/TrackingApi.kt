package com.karahoca.tracker.data.remote

import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.Headers
import retrofit2.http.POST

interface TrackingApi {

    // ---- Hand-off (no credential yet) ---------------------------------------

    @POST("driver/claim")
    suspend fun claim(@Body body: ClaimRequest): Response<ClaimResponse>

    @POST("driver/token/refresh")
    suspend fun refresh(@Body body: RefreshRequest): Response<RefreshResponse>

    // ---- Authenticated ------------------------------------------------------

    @GET("driver/session")
    suspend fun session(): Response<SessionInfoResponse>

    /**
     * The workhorse.
     *
     * `Content-Encoding: gzip` is a *marker*, not the real thing — GzipInterceptor
     * (see NetworkModule) sees this header and replaces the body with its gzipped
     * form. Compressing here rather than in the DTO layer keeps the HMAC over the
     * exact bytes that go on the wire.
     */
    @Headers("Content-Encoding: gzip")
    @POST("ingest/batch")
    suspend fun ingestBatch(@Body body: IngestBatchRequest): Response<IngestResponse>

    @POST("driver/events")
    suspend fun postEvent(@Body body: DriverEventRequest): Response<SimpleAck>

    @POST("driver/stop")
    suspend fun stop(): Response<SimpleAck>
}
