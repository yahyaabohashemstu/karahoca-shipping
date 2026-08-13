import CoreLocation
import Foundation
import UIKit

// =============================================================================
//  THE WIRE CONTRACT
// =============================================================================
//
//  A line-for-line counterpart of `data/remote/Dtos.kt`. Both apps talk to the
//  same handful of endpoints and the same Postgres function behind them, so a
//  field renamed on one side and not the other is a silent data loss that only
//  shows up as a thinner route on a dispatcher's map weeks later.
//
//  Two conventions carry over from the Android client and are load-bearing:
//
//  1. NILS ARE OMITTED, NOT SENT AS null. Swift's synthesised `encode(to:)`
//     uses `encodeIfPresent` for Optionals, which gives us kotlinx's
//     `explicitNulls = false` for free — worth ~15% on a backlog upload, and a
//     backlog upload is the one that has to fit inside a 2G edge cell's
//     coverage window.
//
//  2. DECODING IS FORGIVING, WITHIN LIMITS. A newer server must never brick an
//     older build sitting in a lorry that will not be updated for months, so
//     unknown keys are ignored (Swift does this by default) and known-but-
//     missing keys fall back — except for the four claim fields the app cannot
//     function without, which stay strict. Silently defaulting an absent
//     `ingestKey` to "" would produce a session that signs every request wrong
//     and reports BAD_SIGNATURE forever.
// =============================================================================

// MARK: - Session hand-off

struct DeviceInfoDto: Encodable, Equatable {
    let deviceId: String
    var fingerprint: String?
    var manufacturer: String?
    var model: String?
    var osVersion: String?
    var appVersion: String?
    var appBuild: Int?

    /// Self-reported health, shown to the dispatcher BEFORE the truck leaves —
    /// which is what turns "why did we lose this shipment" into "don't let it
    /// leave yet".
    ///
    /// `backgroundRefreshEnabled` occupies the slot Android fills with
    /// `batteryOptimisationIgnored`. They are not the same switch, but they are
    /// the same *question*: has the driver turned off the thing that lets this
    /// app run when it is not on screen? On iOS that is Background App Refresh,
    /// and a driver who has it off will go dark the moment the screen locks —
    /// with no way for us to detect it after the fact.
    var batteryOptimisationIgnored: Bool?
    var hasBackgroundLocation: Bool?
}

extension DeviceInfoDto {
    /// Build the descriptor from what this device can tell us about itself.
    ///
    /// The two permission booleans are parameters rather than reads, because
    /// `UIApplication.shared.backgroundRefreshStatus` is main-actor state and
    /// the authorisation status belongs to the CoreLocation manager the
    /// tracking layer owns. Reaching for either from here would either hop
    /// actors on the claim path or read a stale value.
    ///
    /// `sdkInt` and `hasExactAlarm` are deliberately never sent. Both are
    /// Android-shaped: an iOS major version in an `sdkInt` column would render
    /// on the dispatcher's screen as "API 16" — Jelly Bean, 2012 — and an exact
    /// alarm has no iOS counterpart at all. Omitted beats wrong; the server
    /// marks both optional.
    @MainActor
    static func current(
        deviceId: String,
        hasBackgroundLocation: Bool,
        backgroundRefreshEnabled: Bool
    ) -> DeviceInfoDto {
        let bundle = Bundle.main.infoDictionary ?? [:]
        return DeviceInfoDto(
            deviceId: deviceId,
            fingerprint: nil,
            manufacturer: "Apple",
            // `UIDevice.model` is "iPhone" for every iPhone ever made, which is
            // useless for diagnosing "this one model loses fixes". The machine
            // identifier ("iPhone14,5") is the one that identifies hardware.
            model: hardwareIdentifier(),
            osVersion: "iOS \(UIDevice.current.systemVersion)",
            appVersion: bundle["CFBundleShortVersionString"] as? String,
            appBuild: (bundle["CFBundleVersion"] as? String).flatMap(Int.init),
            batteryOptimisationIgnored: backgroundRefreshEnabled,
            hasBackgroundLocation: hasBackgroundLocation
        )
    }

    /// "iPhone14,5". `uname` rather than a lookup table: a table goes stale the
    /// week Apple ships a phone, and a stale table reports the wrong hardware,
    /// which is worse than reporting a string the dispatcher has to look up.
    private static func hardwareIdentifier() -> String {
        var info = utsname()
        uname(&info)
        return withUnsafePointer(to: &info.machine) { pointer in
            pointer.withMemoryRebound(to: CChar.self, capacity: 1) { String(cString: $0) }
        }
    }
}

struct ClaimRequest: Encodable {
    let code: String
    let device: DeviceInfoDto
}

/// The cadence the server assigns this session.
///
/// `CodingKeys` is spelled out here and in every other type below that writes
/// its own `init(from:)`. The compiler only synthesises the enum when it is
/// also synthesising the initialiser, so a hand-written one silently loses it —
/// which is a compile error today and, worse, a trap for whoever adds the next
/// field and expects it to be picked up automatically.
struct PolicyDto: Decodable, Equatable {
    let pingIntervalSec: Int
    let idleIntervalSec: Int
    let minDistanceM: Int

    enum CodingKeys: String, CodingKey {
        case pingIntervalSec, idleIntervalSec, minDistanceM
    }

    static let fallback = PolicyDto(pingIntervalSec: 10, idleIntervalSec: 60, minDistanceM: 0)

    init(pingIntervalSec: Int, idleIntervalSec: Int, minDistanceM: Int) {
        self.pingIntervalSec = pingIntervalSec
        self.idleIntervalSec = idleIntervalSec
        self.minDistanceM = minDistanceM
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        pingIntervalSec = c.value(.pingIntervalSec, or: PolicyDto.fallback.pingIntervalSec)
        idleIntervalSec = c.value(.idleIntervalSec, or: PolicyDto.fallback.idleIntervalSec)
        minDistanceM = c.value(.minDistanceM, or: PolicyDto.fallback.minDistanceM)
    }

    /// Hand the wire values to the one type allowed to interpret them.
    ///
    /// `TrackingPolicy` clamps to the same bounds migration 0007 puts on the
    /// columns. Converting here rather than at each call site means the phone
    /// can never end up holding a cadence the server would have refused to
    /// store — including one this file decoded from a malformed response.
    var resolved: TrackingPolicy {
        TrackingPolicy(
            pingIntervalSec: TimeInterval(pingIntervalSec),
            idleIntervalSec: TimeInterval(idleIntervalSec),
            minDistanceM: Double(minDistanceM)
        )
    }
}

struct ShipmentDto: Decodable, Equatable {
    var orderNumber: String?
    var customerName: String?
    var destinationLabel: String?
    var destinationAddress: String?
    var destinationLat: Double?
    var destinationLon: Double?
    var cargoSummary: String?
    var plannedDeliveryAt: String?

    static let empty = ShipmentDto()
}

struct ClaimResponse: Decodable, ServerTimestamped {
    let sessionId: String
    let reference: String
    let accessToken: String
    let refreshToken: String
    /// Base64. Goes straight into the keychain and is never logged, never
    /// written to a file, and never leaves this device.
    let ingestKey: String
    let expiresIn: Int
    let serverTime: Int
    let policy: PolicyDto
    let shipment: ShipmentDto

    enum CodingKeys: String, CodingKey {
        case sessionId, reference, accessToken, refreshToken, ingestKey
        case expiresIn, serverTime, policy, shipment
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // Strict: without any one of these there is no session to run.
        sessionId = try c.decode(String.self, forKey: .sessionId)
        accessToken = try c.decode(String.self, forKey: .accessToken)
        refreshToken = try c.decode(String.self, forKey: .refreshToken)
        ingestKey = try c.decode(String.self, forKey: .ingestKey)
        // Forgiving: a missing reference costs the driver a label on a screen,
        // a missing shipment costs a line of context. Neither is worth
        // refusing to start tracking a lorry that is already pulling out.
        reference = c.value(.reference, or: "")
        expiresIn = c.value(.expiresIn, or: 86_400)
        serverTime = c.value(.serverTime, or: 0)
        policy = c.value(.policy, or: .fallback)
        shipment = c.value(.shipment, or: .empty)
    }
}

struct RefreshRequest: Encodable {
    let refreshToken: String
    let deviceId: String
}

struct RefreshResponse: Decodable, ServerTimestamped {
    let sessionId: String
    let reference: String
    let accessToken: String
    let expiresIn: Int
    let serverTime: Int
    let policy: PolicyDto

    enum CodingKeys: String, CodingKey {
        case sessionId, reference, accessToken, expiresIn, serverTime, policy
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        accessToken = try c.decode(String.self, forKey: .accessToken)
        sessionId = c.value(.sessionId, or: "")
        reference = c.value(.reference, or: "")
        expiresIn = c.value(.expiresIn, or: 86_400)
        serverTime = c.value(.serverTime, or: 0)
        policy = c.value(.policy, or: .fallback)
    }
}

struct SessionInfoResponse: Decodable, ServerTimestamped {
    let sessionId: String
    let reference: String
    let status: String
    var startedAt: String?
    let pointsTotal: Int
    let distanceKm: Double
    let pingIntervalSec: Int
    let idleIntervalSec: Int
    let minDistanceM: Int
    var orderNumber: String?
    var cargoSummary: String?
    var destinationLabel: String?
    var destinationAddress: String?
    var destinationLat: Double?
    var destinationLon: Double?
    var customerName: String?
    var customerPhone: String?
    let serverTime: Int

    enum CodingKeys: String, CodingKey {
        case sessionId, reference, status, startedAt, pointsTotal, distanceKm
        case pingIntervalSec, idleIntervalSec, minDistanceM
        case orderNumber, cargoSummary, destinationLabel, destinationAddress
        case destinationLat, destinationLon, customerName, customerPhone, serverTime
    }

    /// The cadence arrives flattened here rather than nested, unlike claim and
    /// ingest. Re-assembling it means callers have one shape to handle.
    var policy: PolicyDto {
        PolicyDto(
            pingIntervalSec: pingIntervalSec,
            idleIntervalSec: idleIntervalSec,
            minDistanceM: minDistanceM
        )
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = c.value(.sessionId, or: "")
        reference = c.value(.reference, or: "")
        // "" would read as "not closed" to a caller checking the lifecycle, so
        // an absent status has to be the pessimistic answer, not the blank one.
        status = c.value(.status, or: "UNKNOWN")
        startedAt = c.value(.startedAt)
        pointsTotal = c.value(.pointsTotal, or: 0)
        distanceKm = c.value(.distanceKm, or: 0)
        pingIntervalSec = c.value(.pingIntervalSec, or: PolicyDto.fallback.pingIntervalSec)
        idleIntervalSec = c.value(.idleIntervalSec, or: PolicyDto.fallback.idleIntervalSec)
        minDistanceM = c.value(.minDistanceM, or: PolicyDto.fallback.minDistanceM)
        orderNumber = c.value(.orderNumber)
        cargoSummary = c.value(.cargoSummary)
        destinationLabel = c.value(.destinationLabel)
        destinationAddress = c.value(.destinationAddress)
        destinationLat = c.value(.destinationLat)
        destinationLon = c.value(.destinationLon)
        customerName = c.value(.customerName)
        customerPhone = c.value(.customerPhone)
        serverTime = c.value(.serverTime, or: 0)
    }
}

// MARK: - Telemetry

struct LocationPointDto: Encodable, Equatable {
    /// Device-generated ULID. This is the idempotency key the server
    /// deduplicates on, which is what makes re-sending a batch free — and
    /// re-sending is the whole offline strategy.
    let id: String

    /// Epoch millis taken from the GNSS fix, not from the phone clock. A driver
    /// who changes the time zone at the Habur border crossing cannot corrupt
    /// the route (ADR-011).
    let recordedAt: Int64

    let lat: Double
    let lon: Double
    var accuracy: Double?
    var altitude: Double?
    var verticalAccuracy: Double?
    var speed: Double?
    var speedAccuracy: Double?
    var bearing: Double?

    /// Android sends `SystemClock.elapsedRealtimeNanos`. The iOS analogue is
    /// `ProcessInfo.systemUptime` scaled to nanoseconds — same purpose: a
    /// monotonic stamp the server can use to order fixes whose wall-clock
    /// timestamps disagree.
    var elapsedRealtimeNs: Int64?

    var batteryPct: Int?
    var isCharging: Bool?

    /// Never used to discard a point. A spoofed route is evidence in a dispute
    /// with a carrier, and dropping it destroys the evidence.
    var isMock: Bool?

    var satellites: Int?
    var provider: String?
    var networkType: String?
    var seq: Int64?
}

struct IngestBatchRequest: Encodable {
    /// Client-generated UUID. Sending the same one twice is safe: the points
    /// collapse on their own primary key and the batch receipt is
    /// ON CONFLICT DO NOTHING.
    let batchId: String

    /// "Is this a backlog?", not "was the radio down?". The server emits
    /// `route:backfill` instead of `position:update` for these, so a truck
    /// coming out of a dead zone does not make its own marker rewind across
    /// the dispatcher's map (ADR-006).
    let offline: Bool

    let bufferRemaining: Int
    let points: [LocationPointDto]
}

struct IngestResponse: Decodable, ServerTimestamped {
    let accepted: Int
    let duplicates: Int
    let rejected: Int
    var batchId: String?
    let serverTime: Int
    var sessionStatus: String?
    let pointsTotal: Int
    let distanceM: Double
    var policy: PolicyDto?
    /// "CONTINUE" | "PAUSE". An instruction, not something the client infers.
    var nextAction: String?

    enum CodingKeys: String, CodingKey {
        case accepted, duplicates, rejected, batchId, serverTime
        case sessionStatus, pointsTotal, distanceM, policy, nextAction
    }

    /// The lifecycle states that still accept data, mirroring the guard's list.
    /// Anything else means stop the tracker — and keep the buffer.
    static let openStatuses: Set<String> = ["CLAIMED", "ACTIVE", "PAUSED"]

    var sessionIsClosed: Bool {
        guard let sessionStatus else { return false }
        return !IngestResponse.openStatuses.contains(sessionStatus)
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        accepted = c.value(.accepted, or: 0)
        duplicates = c.value(.duplicates, or: 0)
        rejected = c.value(.rejected, or: 0)
        batchId = c.value(.batchId)
        serverTime = c.value(.serverTime, or: 0)
        sessionStatus = c.value(.sessionStatus)
        pointsTotal = c.value(.pointsTotal, or: 0)
        distanceM = c.value(.distanceM, or: 0)
        policy = c.value(.policy)
        nextAction = c.value(.nextAction)
    }
}

struct DriverEventRequest: Encodable {
    /// One of the strings `DriverEventDto` whitelists server-side. Anything
    /// else is a 400, so the caller picks from `DriverEvent`.
    let type: String
    var occurredAt: String?
    var message: String?
    var payload: [String: String]?
}

/// The event vocabulary the server accepts, so a typo is a compile error rather
/// than a 400 discovered by a driver in a dead zone.
enum DriverEvent: String {
    case started = "STARTED"
    case paused = "PAUSED"
    case resumed = "RESUMED"
    case gpsLost = "GPS_LOST"
    case gpsRecovered = "GPS_RECOVERED"
    case networkLost = "NETWORK_LOST"
    case networkRecovered = "NETWORK_RECOVERED"
    case bufferOverflow = "BUFFER_OVERFLOW"
    case permissionRevoked = "PERMISSION_REVOKED"
    case batteryLow = "BATTERY_LOW"
    /// iOS's nearest equivalent to Android's SERVICE_KILLED: the app was
    /// terminated or suspended and location updates stopped without the driver
    /// asking. There is no separate code for it server-side and inventing one
    /// would 400.
    case serviceKilled = "SERVICE_KILLED"
    case serviceRestored = "SERVICE_RESTORED"
    case note = "NOTE"
}

struct SimpleAck: Decodable, ServerTimestamped {
    let ok: Bool
    let serverTime: Int

    enum CodingKeys: String, CodingKey {
        case ok, serverTime
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = c.value(.ok, or: true)
        serverTime = c.value(.serverTime, or: 0)
    }
}

// MARK: - Clock discipline

/// Every response this API produces — success or failure — carries the server's
/// epoch seconds, precisely so a phone with a wrong clock can correct itself
/// and sign something acceptable next time (ADR-011).
///
/// Conforming here rather than reading the field at each call site means the
/// correction happens in exactly one place: `ApiClient` applies it to anything
/// that comes back.
protocol ServerTimestamped {
    var serverTime: Int { get }
}

// MARK: - Errors

struct ApiErrorBody: Decodable {
    struct Payload: Decodable {
        let code: String
        let message: String
        let details: [String: FlexibleValue]?

        enum CodingKeys: String, CodingKey {
            case code, message, details
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            code = c.value(.code, or: "UNKNOWN")
            message = c.value(.message, or: "")
            details = c.value(.details)
        }
    }

    let error: Payload?
    let serverTime: Int?

    /// How long the server asked us to wait. It knows when its own rate-limit
    /// window resets and we do not, so this beats any local ladder.
    var retryAfterSec: Int? { error?.details?["retryAfterSec"]?.intValue }

    /// Present on SESSION_CLOSED, telling the driver *why* it is over.
    var sessionStatus: String? { error?.details?["status"]?.stringValue }
}

/// One value out of the envelope's free-form `details` block.
///
/// The block is `Record<string, unknown>` server-side and really does carry
/// mixed types: `retryAfterSec` arrives as a JSON number from the rate limiter
/// and `status` as a string from the session guard. Decoding it as
/// `[String: String]` — which is what the Android client does — makes the whole
/// map fail to parse the moment a number appears, and Android then silently
/// loses the server's own retry hint. This exists so iOS does not inherit that.
enum FlexibleValue: Decodable, Equatable {
    case int(Int)
    case double(Double)
    case string(String)
    case bool(Bool)
    case null

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        // Bool before Int: JSONDecoder will happily read `true` as 1.
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Int.self) { self = .int(v) }
        else if let v = try? c.decode(Double.self) { self = .double(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else { self = .null }
    }

    var intValue: Int? {
        switch self {
        case .int(let v):    return v
        case .double(let v): return Int(v)
        case .string(let v): return Int(v)
        case .bool, .null:   return nil
        }
    }

    var stringValue: String? {
        switch self {
        case .string(let v): return v
        case .int(let v):    return String(v)
        case .double(let v): return String(v)
        case .bool(let v):   return String(v)
        case .null:          return nil
        }
    }
}

/// What the caller should DO about a failure.
///
/// A direct port of `ApiFailure` in Dtos.kt. The entire retry policy branches
/// on this, so it is modelled once rather than left as HTTP-status comparisons
/// scattered through the sync loop.
enum ApiFailure: Equatable {
    /// Refresh the token and retry the same batch.
    case tokenExpired

    /// Session is over. Stop tracking, KEEP the buffer, tell the driver.
    case sessionClosed

    /// Device was reassigned or revoked. Needs a fresh claim code, which means
    /// a phone call to the dispatcher.
    case unauthorised

    /// Back off for the advertised interval.
    case rateLimited

    /// Halve the chunk and retry.
    case batchTooLarge

    /// Server or network problem — exponential backoff, keep buffering.
    case transient

    /// The payload itself is bad. Retrying identical bytes cannot help.
    case permanent

    /// True when re-sending *the same bytes* can plausibly succeed.
    ///
    /// Deliberately false for `batchTooLarge` and `permanent` even though the
    /// sync loop retries both: it retries them with a *smaller chunk*, which is
    /// different bytes. Conflating the two is how a poisoned row becomes an
    /// infinite loop that never uploads anything again.
    var isRetryableAsIs: Bool {
        switch self {
        case .rateLimited, .transient: return true
        case .tokenExpired:            return false   // not before a refresh
        case .sessionClosed, .unauthorised, .batchTooLarge, .permanent: return false
        }
    }

    /// True when nothing this client does will ever make the call succeed.
    var isTerminal: Bool {
        self == .sessionClosed || self == .unauthorised
    }

    static func classify(status: Int, code: String?) -> ApiFailure {
        switch code {
        case "TOKEN_EXPIRED":                    return .tokenExpired
        case "SESSION_CLOSED", "SESSION_NOT_FOUND": return .sessionClosed
        case "TOKEN_REVOKED", "DEVICE_MISMATCH", "REFRESH_INVALID", "REFRESH_EXPIRED":
            return .unauthorised
        case "BATCH_TOO_LARGE":                  return .batchTooLarge
        // We resync from the `serverTime` on this very response and the next
        // attempt signs a timestamp the server accepts, so it is transient by
        // construction rather than by hope.
        case "CLOCK_SKEW":                       return .transient
        // A burned nonce means the request was already seen. The retry will
        // carry a fresh one.
        case "REPLAY_DETECTED":                  return .transient
        default: break
        }

        switch status {
        case 401: return .tokenExpired
        case 403: return .unauthorised
        case 413: return .batchTooLarge
        case 429: return .rateLimited
        case 400, 422: return .permanent
        /*
         * 409 diverges from Android, on purpose.
         *
         * Android's `ApiFailure.from` has no 409 branch, so a conflict falls
         * through to TRANSIENT and is retried on the backoff ladder forever.
         * The only thing that produces a 409 here is the exception filter
         * mapping a Postgres 23505 unique violation, and a duplicate key is
         * still a duplicate key on the tenth attempt — it burns radio and
         * battery to learn nothing. Treated as permanent so the sync loop
         * re-chunks and isolates instead of spinning.
         */
        case 409: return .permanent
        case 500...599: return .transient
        default: return .transient
        }
    }
}

/// Everything `ApiClient` can throw, in a shape the sync loop can switch on.
enum ApiError: Error {
    /// No answer at all: DNS, TLS, timeout, radio down, tunnel collapsed.
    case transport(URLError)

    /// The server answered and refused.
    case rejected(status: Int, code: String?, message: String?, retryAfterSec: Int?)

    /// A 2xx whose body we could not make sense of. Almost always a captive
    /// portal or a carrier proxy returning its own HTML with a 200.
    case malformedResponse(String)

    /// There is no session on this device. Nothing to retry; the driver has to
    /// claim a code.
    case noCredentials

    /// The request could not be serialised at all.
    ///
    /// In practice this means one non-finite `Double` in a batch — a corrupt
    /// fix with a NaN latitude — because `JSONEncoder` throws rather than
    /// emitting `NaN`, which is not valid JSON. Classified `permanent` so it
    /// lands in the sync loop's isolate-the-poisoned-row branch instead of
    /// silently blocking every upload behind one bad point forever.
    case unencodableRequest(String)

    /// The single classification the caller acts on, so a transport failure and
    /// a 503 flow through the same branch of the sync loop.
    var failure: ApiFailure {
        switch self {
        case .transport:                     return .transient
        case .malformedResponse:             return .transient
        case .noCredentials:                 return .unauthorised
        case .unencodableRequest:            return .permanent
        case .rejected(let status, let code, _, _):
            return ApiFailure.classify(status: status, code: code)
        }
    }

    /// The stable machine-readable code. The UI maps THIS to Turkish — never
    /// `message`, which is English prose written for whoever reads the logs.
    var code: String? {
        if case .rejected(_, let code, _, _) = self { return code }
        return nil
    }

    var retryAfterSec: Int? {
        if case .rejected(_, _, _, let retryAfter) = self { return retryAfter }
        return nil
    }

    var httpStatus: Int? {
        if case .rejected(let status, _, _, _) = self { return status }
        return nil
    }
}

extension ApiError: CustomStringConvertible {
    /// For the log line, not for the driver.
    var description: String {
        switch self {
        case .transport(let error):
            return "transport(\(error.code.rawValue): \(error.localizedDescription))"
        case .rejected(let status, let code, let message, let retryAfter):
            let suffix = retryAfter.map { " retryAfter=\($0)s" } ?? ""
            return "HTTP \(status) \(code ?? "-"): \(message ?? "")\(suffix)"
        case .malformedResponse(let detail):
            return "malformed response: \(detail)"
        case .noCredentials:
            return "no session credentials on this device"
        case .unencodableRequest(let detail):
            return "request could not be encoded: \(detail)"
        }
    }
}

// MARK: - Decoding helpers

extension KeyedDecodingContainer {
    /// Read a key, or fall back.
    ///
    /// Swallows a missing key, an explicit null, AND a type mismatch. That last
    /// one is the point: if a future server sends `distanceM` as a string, the
    /// synthesised decoder would throw and cost us the entire ingest
    /// acknowledgement — including the `serverTime` the phone needs to fix its
    /// clock and the `sessionStatus` telling it the delivery is over. One odd
    /// field must not take the whole response down with it.
    func value<T: Decodable>(_ key: Key, or fallback: T) -> T {
        guard let decoded = try? decodeIfPresent(T.self, forKey: key) else { return fallback }
        return decoded ?? fallback
    }

    /// Same tolerance, for a field that is genuinely optional.
    func value<T: Decodable>(_ key: Key) -> T? {
        guard let decoded = try? decodeIfPresent(T.self, forKey: key) else { return nil }
        return decoded
    }
}
