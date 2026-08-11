package com.karahoca.tracker.data.remote

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

// =============================================================================
// Session hand-off
// =============================================================================

@Serializable
data class DeviceInfoDto(
    val deviceId: String,
    val fingerprint: String? = null,
    val manufacturer: String? = null,
    val model: String? = null,
    val osVersion: String? = null,
    val sdkInt: Int? = null,
    val appVersion: String? = null,
    val appBuild: Int? = null,
    /**
     * Self-reported health. The dispatcher sees these BEFORE the truck leaves,
     * which turns "why did we lose this shipment" into "don't let it leave yet".
     */
    val batteryOptimisationIgnored: Boolean? = null,
    val hasBackgroundLocation: Boolean? = null,
    val hasExactAlarm: Boolean? = null,
)

@Serializable
data class ClaimRequest(val code: String, val device: DeviceInfoDto)

@Serializable
data class PolicyDto(
    val pingIntervalSec: Int = 10,
    val idleIntervalSec: Int = 60,
    val minDistanceM: Int = 0,
)

@Serializable
data class ShipmentDto(
    val orderNumber: String? = null,
    val customerName: String? = null,
    val destinationLabel: String? = null,
    val destinationAddress: String? = null,
    val destinationLat: Double? = null,
    val destinationLon: Double? = null,
    val cargoSummary: String? = null,
    val plannedDeliveryAt: String? = null,
)

@Serializable
data class ClaimResponse(
    val sessionId: String,
    val reference: String,
    val accessToken: String,
    val refreshToken: String,
    /** base64 HMAC key. Never leaves the Keystore-sealed store after this. */
    val ingestKey: String,
    val expiresIn: Long,
    val serverTime: Long,
    val policy: PolicyDto,
    val shipment: ShipmentDto,
)

@Serializable
data class RefreshRequest(val refreshToken: String, val deviceId: String)

@Serializable
data class RefreshResponse(
    val sessionId: String,
    val reference: String,
    val accessToken: String,
    val expiresIn: Long,
    val serverTime: Long,
    val policy: PolicyDto,
)

@Serializable
data class SessionInfoResponse(
    val sessionId: String,
    val reference: String,
    val status: String,
    val startedAt: String? = null,
    val pointsTotal: Long = 0,
    val distanceKm: Double = 0.0,
    val pingIntervalSec: Int = 10,
    val idleIntervalSec: Int = 60,
    val minDistanceM: Int = 0,
    val orderNumber: String? = null,
    val cargoSummary: String? = null,
    val destinationLabel: String? = null,
    val destinationAddress: String? = null,
    val destinationLat: Double? = null,
    val destinationLon: Double? = null,
    val customerName: String? = null,
    val customerPhone: String? = null,
    val serverTime: Long = 0,
)

// =============================================================================
// Telemetry
// =============================================================================

@Serializable
data class LocationPointDto(
    val id: String,
    /** Epoch millis from Location.getTime() — GPS UTC, not the phone clock. */
    val recordedAt: Long,
    val lat: Double,
    val lon: Double,
    val accuracy: Float? = null,
    val altitude: Double? = null,
    val verticalAccuracy: Float? = null,
    val speed: Float? = null,
    val speedAccuracy: Float? = null,
    val bearing: Float? = null,
    val elapsedRealtimeNs: Long? = null,
    val batteryPct: Int? = null,
    val isCharging: Boolean? = null,
    val isMock: Boolean? = null,
    val satellites: Int? = null,
    val provider: String? = null,
    val networkType: String? = null,
    val seq: Long? = null,
)

@Serializable
data class IngestBatchRequest(
    val batchId: String,
    /** Distinguishes a live ping from a recovered backlog on the dashboard. */
    val offline: Boolean,
    val bufferRemaining: Int,
    val points: List<LocationPointDto>,
)

@Serializable
data class IngestResponse(
    val accepted: Int = 0,
    val duplicates: Int = 0,
    val rejected: Int = 0,
    val batchId: String? = null,
    val serverTime: Long = 0,
    val sessionStatus: String? = null,
    val pointsTotal: Long = 0,
    val distanceM: Double = 0.0,
    val policy: PolicyDto? = null,
    /** "CONTINUE" | "PAUSE" — an instruction, not something the client infers. */
    val nextAction: String? = null,
)

@Serializable
data class DriverEventRequest(
    val type: String,
    val occurredAt: String? = null,
    val message: String? = null,
    val payload: Map<String, String>? = null,
)

@Serializable
data class SimpleAck(val ok: Boolean = true, val serverTime: Long = 0)

// =============================================================================
// Errors
// =============================================================================

@Serializable
data class ApiErrorBody(val error: ApiError? = null, val serverTime: Long = 0)

@Serializable
data class ApiError(
    val code: String = "UNKNOWN",
    val message: String = "",
    val details: Map<String, String>? = null,
)

/**
 * The client's whole retry policy branches on `code`, so it is modelled
 * explicitly rather than left as string comparisons scattered through the app.
 */
enum class ApiFailure {
    /** Refresh the token and retry the same batch. */
    TOKEN_EXPIRED,

    /** Session is over. Stop the service, keep the buffer, tell the driver. */
    SESSION_CLOSED,

    /** Device was reassigned or revoked. Requires a fresh claim code. */
    UNAUTHORISED,

    /** Back off for the advertised interval. */
    RATE_LIMITED,

    /** Halve the chunk size and retry. */
    BATCH_TOO_LARGE,

    /** Server or network problem — exponential backoff, keep buffering. */
    TRANSIENT,

    /** The payload itself is bad; retrying identical bytes cannot help. */
    PERMANENT,
    ;

    companion object {
        fun from(httpCode: Int, apiCode: String?): ApiFailure = when {
            apiCode == "TOKEN_EXPIRED" -> TOKEN_EXPIRED
            apiCode == "SESSION_CLOSED" -> SESSION_CLOSED
            apiCode == "SESSION_NOT_FOUND" -> SESSION_CLOSED
            apiCode == "TOKEN_REVOKED" || apiCode == "DEVICE_MISMATCH" -> UNAUTHORISED
            apiCode == "BATCH_TOO_LARGE" -> BATCH_TOO_LARGE
            apiCode == "CLOCK_SKEW" -> TRANSIENT   // we resync from serverTime and retry
            httpCode == 401 -> TOKEN_EXPIRED
            httpCode == 403 -> UNAUTHORISED
            httpCode == 413 -> BATCH_TOO_LARGE
            httpCode == 429 -> RATE_LIMITED
            httpCode in 500..599 -> TRANSIENT
            httpCode == 400 || httpCode == 422 -> PERMANENT
            else -> TRANSIENT
        }
    }
}
