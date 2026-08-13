import Compression
import Foundation

// =============================================================================
//  GZIP
// =============================================================================

/// Real gzip, built by hand on top of the Compression framework.
///
/// It has to be by hand. `compression_encode_buffer(…, COMPRESSION_ZLIB)`
/// produces **raw DEFLATE** (RFC 1951) — no gzip header, no zlib header, no
/// checksum. Sending those bytes under `Content-Encoding: gzip` makes Node's
/// `createGunzip` fail on the missing magic number, and under
/// `Content-Encoding: deflate` its `createInflate` fails on the missing zlib
/// header. Either way the server rejects the request before the guard even
/// sees it. So the 10-byte header and the 8-byte trailer are assembled here,
/// which costs one CRC-32 pass and removes any need for a dependency.
///
/// WHY BOTHER AT ALL. A truck out of a 12-hour dead zone uploads ~8,600 points,
/// about 2.4 MB of JSON, which gzips to roughly 250 kB. On a 2 G edge cell that
/// is a 9-second upload instead of a 90-second one — the difference between
/// finishing inside the coverage window and losing the whole backlog again.
enum Gzip {

    /// ID1, ID2, CM=deflate, FLG=0, MTIME=0, XFL=0, OS=unknown.
    ///
    /// MTIME is deliberately zero rather than the current time: identical
    /// payloads then compress to identical bytes, which makes the whole path
    /// reproducible in a test, and nothing about the driver's clock leaks into
    /// a header the server never reads.
    private static let header: [UInt8] = [0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0x00, 0xff]

    /// Returns nil when compression is not worth doing — an empty body, an
    /// incompressible one, or a result no smaller than the input. The caller
    /// then sends the payload as it stands, with no `Content-Encoding` header.
    static func compress(_ data: Data) -> Data? {
        guard !data.isEmpty, let deflated = deflate(data) else { return nil }

        var out = Data(capacity: header.count + deflated.count + 8)
        out.append(contentsOf: header)
        out.append(deflated)
        append(crc32(data), to: &out)
        // ISIZE is the input size modulo 2^32, by the format's definition, so
        // truncation here is the spec and not a shortcut.
        append(UInt32(truncatingIfNeeded: data.count), to: &out)

        return out.count < data.count ? out : nil
    }

    private static func append(_ value: UInt32, to data: inout Data) {
        var littleEndian = value.littleEndian
        withUnsafeBytes(of: &littleEndian) { data.append(contentsOf: $0) }
    }

    /// Destination sized at the input length: if DEFLATE cannot get under the
    /// original size, `compression_encode_buffer` returns 0 and we conclude the
    /// payload is not compressible. That is the intended use of the return
    /// value, not an error case to work around.
    private static func deflate(_ data: Data) -> Data? {
        let capacity = data.count
        var destination = [UInt8](repeating: 0, count: capacity)

        let written = data.withUnsafeBytes { source -> Int in
            guard let sourceBase = source.bindMemory(to: UInt8.self).baseAddress else { return 0 }
            return destination.withUnsafeMutableBufferPointer { out -> Int in
                guard let outBase = out.baseAddress else { return 0 }
                return compression_encode_buffer(
                    outBase, capacity, sourceBase, data.count, nil, COMPRESSION_ZLIB
                )
            }
        }

        guard written > 0 else { return nil }
        return Data(destination[0..<written])
    }

    // MARK: - CRC-32

    private static let table: [UInt32] = (0..<256).map { index -> UInt32 in
        var value = UInt32(index)
        for _ in 0..<8 {
            value = (value & 1) != 0 ? (0xEDB8_8320 ^ (value >> 1)) : (value >> 1)
        }
        return value
    }

    /// Standard CRC-32 (polynomial 0xEDB88320), the checksum the gzip trailer
    /// carries and the receiver verifies.
    static func crc32(_ data: Data) -> UInt32 {
        var crc: UInt32 = 0xFFFF_FFFF
        data.withUnsafeBytes { raw in
            for byte in raw {
                crc = table[Int((crc ^ UInt32(byte)) & 0xFF)] ^ (crc >> 8)
            }
        }
        return crc ^ 0xFFFF_FFFF
    }
}

// =============================================================================
//  REQUEST CONSTRUCTION
// =============================================================================

/// Turns the pieces of a call into a signed, optionally compressed URLRequest.
///
/// Split out of `ApiClient` and made pure so it can be tested without a
/// network, a keychain or a clock — because the one mistake that matters here
/// is invisible until it is deployed, and then it is total.
enum SignedRequest {

    /// Below this, gzip costs more in CPU and header bytes than it saves.
    /// Mirrors the same floor in Android's `GzipRequestInterceptor`.
    static let compressionFloorBytes = 512

    struct Inputs {
        let baseURL: URL
        /// Relative, no leading slash. See the note in `build`.
        let path: String
        let method: String
        /// The JSON to send, before any content encoding. `nil` for a GET.
        let body: Data?
        /// Absent on `driver/claim` and `driver/token/refresh`, which have no
        /// credential yet and authenticate against secrets in the body.
        let bearer: String?
        let ingestKey: Data?
        let deviceId: String
        /// Clock-corrected. See `CredentialStore.correctedNow`.
        let now: Date
        let nonce: String
        let allowCompression: Bool
    }

    static func build(_ inputs: Inputs) -> URLRequest {
        /*
         * Relative resolution, matching Retrofit's `baseUrl` semantics exactly.
         *
         * The TRAILING SLASH on the base URL is load-bearing and it is the same
         * trap Retrofit has: with "…/api/v1" (no slash) and a path of
         * "ingest/batch", RFC 3986 resolution replaces the last segment and
         * produces "…/api/ingest/batch" — every call 404s, and it looks like
         * the server is down.
         */
        let url = URL(string: inputs.path, relativeTo: inputs.baseURL)?.absoluteURL
            ?? inputs.baseURL
        var request = URLRequest(url: url)
        request.httpMethod = inputs.method

        // A captive portal on a truck-stop wifi will happily hand back a 200
        // with its own login page and a Set-Cookie. Caching that response, or
        // replaying that cookie against the real API later, are both worse than
        // the round trip they save.
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.httpShouldHandleCookies = false

        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(inputs.deviceId, forHTTPHeaderField: HmacSigner.deviceIdHeader)

        // Deliberately NOT setting Accept-Encoding. URLSession sets it itself
        // and transparently inflates the response; the moment you set it by
        // hand it stops doing that and hands you compressed bytes to decode.

        if let bearer = inputs.bearer {
            request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
        }

        let payload = inputs.body ?? Data()

        /*
         * ======================================================================
         *  SIGN FIRST. COMPRESS SECOND. NEVER THE OTHER WAY ROUND.
         * ======================================================================
         *
         * The signature covers sha256 of the UNCOMPRESSED body, because the
         * server decompresses in a Fastify `preParsing` hook before the raw
         * body is captured and hashes the plain JSON. Compression is therefore
         * a pure transport concern and a proxy that re-encodes the request
         * cannot break authentication.
         *
         * Sign the gzipped bytes instead and every single upload returns
         * BAD_SIGNATURE — not intermittently, not on some carriers: all of
         * them, on every phone, from the first batch. On Android this ordering
         * lives in the interceptor chain in `AppModule.okHttpClient`; here it
         * is these fifteen lines, which is why they are the only place in the
         * app that touches both.
         */
        if let key = inputs.ingestKey {
            let signature = HmacSigner.sign(
                body: payload, key: key, now: inputs.now, nonce: inputs.nonce
            )
            request.setValue(signature.timestamp, forHTTPHeaderField: HmacSigner.timestampHeader)
            request.setValue(signature.nonce, forHTTPHeaderField: HmacSigner.nonceHeader)
            request.setValue(signature.signature, forHTTPHeaderField: HmacSigner.signatureHeader)
        }

        guard inputs.body != nil else { return request }
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        if inputs.allowCompression,
           payload.count > compressionFloorBytes,
           let gzipped = Gzip.compress(payload) {
            request.setValue("gzip", forHTTPHeaderField: "Content-Encoding")
            request.httpBody = gzipped
        } else {
            request.httpBody = payload
        }

        return request
    }
}

// =============================================================================
//  THE CLIENT
// =============================================================================

/// Every call the driver app makes, and the only place that talks to the API.
///
/// An actor, for one reason that is not "concurrency hygiene": the token
/// refresh has to be single-flight, and that requires shared mutable state
/// guarded against a location wake-up and a user tap arriving together.
actor ApiClient {

    /// Baked in so a driver never types a URL.
    ///
    /// The optional Info.plist override exists so a debug build can point at a
    /// laptop without a code change; when the key is absent — which is the case
    /// in the shipping build — the constant wins. Note the trailing slash: see
    /// `SignedRequest.build`.
    static let defaultBaseURL: URL = {
        if let raw = Bundle.main.object(forInfoDictionaryKey: "KHApiBaseURL") as? String,
           let url = URL(string: raw) {
            return url
        }
        return URL(string: "https://track.karahoca.com/api/v1/")!
    }()

    /// Generous timeouts, on purpose.
    ///
    /// A truck on a 2 G edge cell pushing a 250 kB gzipped backlog needs the
    /// time; failing at 10 seconds would mean it can never catch up, and every
    /// failure costs another radio wake-up out of a battery that has to last a
    /// fourteen-hour shift.
    static func makeSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 60
        config.timeoutIntervalForResource = 180

        /*
         * waitsForConnectivity = false, which looks backwards for an app whose
         * whole problem is bad coverage.
         *
         * It is not. With it on, a call made in a dead zone parks for up to the
         * resource timeout — and the sync loop is holding a batch marked
         * in-flight the entire time, so nothing else can upload it. Failing
         * fast hands control back to `UploadBackoff`, which is the component
         * that actually knows when to try again.
         */
        config.waitsForConnectivity = false

        // Low Data Mode and roaming restrictions are switches a driver flips
        // when crossing into Iraq to avoid a bill. Neither may silently stop a
        // shipment reporting its position; the payload is a few hundred bytes.
        config.allowsConstrainedNetworkAccess = true
        config.allowsExpensiveNetworkAccess = true

        // Keep-alive across the pump interval avoids a TLS handshake per ping.
        config.httpMaximumConnectionsPerHost = 2
        config.httpShouldSetCookies = false
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: config)
    }

    private let baseURL: URL
    private let store: CredentialStore
    private let session: URLSession
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    /// The one in-flight refresh. See `refreshAccessToken`.
    private var refreshInFlight: Task<Void, Error>?

    init(
        credentials: CredentialStore,
        baseURL: URL = ApiClient.defaultBaseURL,
        session: URLSession = ApiClient.makeSession()
    ) {
        self.store = credentials
        self.baseURL = baseURL
        self.session = session
        // Default output formatting on purpose: compact, insertion-ordered
        // keys. `.prettyPrinted` would inflate a 2.4 MB backlog by a third and
        // `.sortedKeys` would sort ten thousand point objects for no gain — the
        // signature covers whatever bytes we produce, so nothing depends on
        // key order.
    }

    // MARK: - Endpoints

    /// Exchange a claim code for a session-scoped credential set.
    ///
    /// Persisting is done here rather than by the caller because this is the
    /// only moment the ingest key exists in memory, and a caller that forgot to
    /// store it would produce a session that cannot sign anything.
    func claim(code: String, device: DeviceInfoDto) async throws -> ClaimResponse {
        // Normalised again even though the UI already did it. A code is
        // single-use: a stray dash reaching the server costs the driver the
        // code and a phone call to the dispatcher.
        let request = ClaimRequest(code: ClaimCode.normalise(code), device: device)
        let response: ClaimResponse = try await send(
            "driver/claim", method: "POST", body: try encode(request), signed: false
        )

        do {
            try await store.save(claim: response)
        } catch CredentialStoreError.malformedIngestKey {
            // No key means no signed request will ever verify. Fail the claim.
            throw ApiError.malformedResponse("ingestKey was not valid base64")
        } catch {
            /*
             * A keychain write failed. Do NOT fail the claim.
             *
             * The code has already been consumed server-side and the session is
             * bound to this device; throwing here would leave the driver
             * holding a dead code with no way to start the delivery. The
             * in-memory credentials are live for as long as the process is, and
             * `CredentialStore` keeps them — a shift that works until the app is
             * killed beats a shift that never starts.
             */
        }
        return response
    }

    /// Confirms the session is still open and — crucially — returns
    /// `serverTime`, which is how a phone with a wrong clock gets itself into a
    /// state where it can sign anything at all (ADR-011).
    func currentSession() async throws -> SessionInfoResponse {
        try await authenticated("driver/session", method: "GET")
    }

    /// The workhorse. The only call that compresses.
    func ingest(_ batch: IngestBatchRequest) async throws -> IngestResponse {
        try await authenticated(
            "ingest/batch", body: try encode(batch), allowCompression: true
        )
    }

    /// Lifecycle and diagnostics. Buffered by the caller, because the events
    /// worth having — SERVICE_KILLED, BUFFER_OVERFLOW — are generated exactly
    /// when there is no network.
    func post(event: DriverEventRequest) async throws -> SimpleAck {
        try await authenticated("driver/events", body: try encode(event))
    }

    /// Driver-initiated stop. Parks the session; it does not complete the
    /// order — only a dispatcher does that.
    func stop() async throws -> SimpleAck {
        // The handler returns the transition result rather than `{ok, …}`, so
        // `SimpleAck`'s forgiving decoder is doing real work here: what matters
        // is that the call returned 2xx.
        try await authenticated("driver/stop", body: Data("{}".utf8))
    }

    // MARK: - Authenticated calls

    private func authenticated<Response: Decodable>(
        _ path: String,
        method: String = "POST",
        body: Data? = nil,
        allowCompression: Bool = false
    ) async throws -> Response {
        // Refresh ahead of expiry so a truck about to enter a dead zone carries
        // a fresh token into it. Best-effort: if the refresh fails the existing
        // token may still be good, and the 401 path below is the real backstop.
        if await store.needsRefresh {
            try? await refreshAccessToken()
        }

        do {
            return try await send(
                path, method: method, body: body,
                signed: true, allowCompression: allowCompression
            )
        } catch let error as ApiError where error.failure == .tokenExpired {
            try await refreshAccessToken()
            /*
             * Exactly one retry, and it is a fresh `send` rather than a replay
             * of the first request. That matters for more than the new bearer
             * token: the first attempt's nonce is already claimed in the
             * server's replay cache for 2 × the skew window, so re-sending the
             * identical request would convert a token problem into
             * REPLAY_DETECTED and the driver would never get past it.
             */
            return try await send(
                path, method: method, body: body,
                signed: true, allowCompression: allowCompression
            )
        }
    }

    /// Single-flight token refresh.
    ///
    /// Several calls can 401 in the same instant — the pump's upload, a queued
    /// event, a session poll — and each one wants a new token. Letting all of
    /// them refresh independently costs three ways: it burns the
    /// sixty-per-minute rate limit on `driver/token/refresh` at exactly the
    /// moment the app cannot afford to be locked out, it writes
    /// `last_seen_at` three times for one event, and — the reason this is
    /// non-negotiable rather than merely tidy — the day the server starts
    /// rotating refresh tokens, N concurrent presentations of the same one are
    /// indistinguishable from a stolen-token replay and the correct response is
    /// to revoke the whole family. Mid-delivery, that means a driver in a dead
    /// zone with a session he cannot recover.
    ///
    /// So: one task, shared by every waiter. The task is unstructured on
    /// purpose — it must not inherit cancellation from whichever caller
    /// happened to create it, or one cancelled upload would fail the refresh
    /// for everyone waiting on it.
    private func refreshAccessToken() async throws {
        if let inFlight = refreshInFlight {
            return try await inFlight.value
        }

        let task = Task<Void, Error> { [self] in
            guard let credentials = await store.credentials() else {
                throw ApiError.noCredentials
            }
            let request = RefreshRequest(
                refreshToken: credentials.refreshToken,
                deviceId: await store.deviceId()
            )
            let response: RefreshResponse = try await self.send(
                "driver/token/refresh", method: "POST",
                body: try self.encode(request), signed: false
            )
            try await store.apply(refresh: response)
        }

        refreshInFlight = task
        defer { refreshInFlight = nil }
        try await task.value
    }

    // MARK: - Transport

    private func send<Response: Decodable>(
        _ path: String,
        method: String,
        body: Data?,
        signed: Bool,
        allowCompression: Bool = false
    ) async throws -> Response {
        /*
         * GETs are signed too, even though the guard skips HMAC verification
         * for them. It costs one SHA-256 over zero bytes, it matches the
         * Android client, and it means the day someone tightens the guard,
         * every phone in the field already complies instead of every phone in
         * the field going dark.
         */
        let material: CredentialStore.SigningMaterial?
        if signed {
            guard let resolved = await store.signingMaterial() else {
                throw ApiError.noCredentials
            }
            material = resolved
        } else {
            material = nil
        }

        let request = SignedRequest.build(SignedRequest.Inputs(
            baseURL: baseURL,
            path: path,
            method: method,
            body: body,
            bearer: material?.bearer,
            ingestKey: material?.ingestKey,
            deviceId: await store.deviceId(),
            now: await store.correctedNow(),
            nonce: HmacSigner.randomNonce(),
            allowCompression: allowCompression
        ))

        let data: Data
        let http: HTTPURLResponse
        do {
            let (received, response) = try await session.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else {
                throw ApiError.malformedResponse("response was not HTTP")
            }
            data = received
            http = httpResponse
        } catch let error as URLError {
            /*
             * Cancellation is not a network failure and must not be reported as
             * one: the sync loop counts an `ApiError` as a failed attempt and
             * advances the backoff ladder, so a task cancelled because the app
             * was suspended would make the *next* wake-up wait 30 seconds
             * before trying. URLSession surfaces cancellation as
             * URLError.cancelled, so it is translated back here.
             */
            if error.code == .cancelled { throw CancellationError() }
            throw ApiError.transport(error)
        }

        guard (200..<300).contains(http.statusCode) else {
            let error = await rejection(status: http.statusCode, data: data, response: http)
            throw error
        }

        // A 2xx with no body is legitimate for an ack. Every response type in
        // this file decodes `{}` into its defaults, so substituting one keeps a
        // successful call from being reported as a malformed response.
        let payload = data.isEmpty ? Data("{}".utf8) : data

        let decoded: Response
        do {
            decoded = try decoder.decode(Response.self, from: payload)
        } catch {
            throw ApiError.malformedResponse(
                "HTTP \(http.statusCode), \(payload.count) bytes: \(error)"
            )
        }

        if let stamped = decoded as? ServerTimestamped {
            await store.recordServerTime(stamped.serverTime)
        }
        return decoded
    }

    /// Turn a non-2xx into something the sync loop can branch on.
    ///
    /// The `serverTime` is harvested from the *error* body too, and that is the
    /// whole mechanism behind clock recovery: a phone two hours off gets
    /// CLOCK_SKEW, learns the real time from the rejection it caused, and the
    /// next attempt succeeds.
    private func rejection(status: Int, data: Data, response: HTTPURLResponse) async -> ApiError {
        let body = try? decoder.decode(ApiErrorBody.self, from: data)
        if let serverTime = body?.serverTime {
            await store.recordServerTime(serverTime)
        }

        // Prefer the standard header, which a CDN or proxy in front of the API
        // may add; fall back to the envelope, which is what this API actually
        // populates.
        let header = response.value(forHTTPHeaderField: "Retry-After").flatMap(Int.init)

        return .rejected(
            status: status,
            code: body?.error?.code,
            message: body?.error?.message,
            retryAfterSec: header ?? body?.retryAfterSec
        )
    }

    /// Encoding failures become `ApiError` so the caller has one error type to
    /// switch on. See `ApiError.unencodableRequest` for what actually causes
    /// them.
    private func encode<T: Encodable>(_ value: T) throws -> Data {
        do {
            return try encoder.encode(value)
        } catch {
            throw ApiError.unencodableRequest("\(T.self): \(error)")
        }
    }
}
