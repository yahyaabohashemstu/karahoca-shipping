import CryptoKit
import Foundation
import Security
import XCTest
@testable import KaraHocaTracker

// NOTE ON STYLE, because it looks like noise otherwise: every `await` in this
// file is hoisted into a `let` before it reaches an assertion. XCTest's
// assertions take `@autoclosure` arguments and those autoclosures are not
// async, so `XCTAssertEqual(await thing(), x)` does not compile at all.

// =============================================================================
//  Test doubles
// =============================================================================

/// The keychain, replaced.
///
/// A unit-test bundle with no host application gets `errSecMissingEntitlement`
/// (-34018) from `SecItemAdd` on a real device, so a test that talked to the
/// real keychain would pass in the simulator and fail the moment CI ran on
/// hardware. This is why `SecretStore` exists as a protocol at all.
private final class InMemorySecretStore: SecretStore, @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String: Data] = [:]

    /// Simulates a keychain that refuses writes — a real state on a device
    /// whose keychain is wedged, and one the claim path must survive.
    var refuseWrites = false

    func load(_ account: String) throws -> Data? {
        lock.lock(); defer { lock.unlock() }
        return items[account]
    }

    func save(_ data: Data, account: String) throws {
        if refuseWrites { throw CredentialStoreError.keychain(errSecIO) }
        lock.lock(); defer { lock.unlock() }
        items[account] = data
    }

    func remove(_ account: String) throws {
        lock.lock(); defer { lock.unlock() }
        items[account] = nil
    }
}

private final class CallCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var counts: [String: Int] = [:]

    @discardableResult
    func bump(_ key: String) -> Int {
        lock.lock(); defer { lock.unlock() }
        let next = (counts[key] ?? 0) + 1
        counts[key] = next
        return next
    }

    func value(_ key: String) -> Int {
        lock.lock(); defer { lock.unlock() }
        return counts[key] ?? 0
    }
}

/// A stub transport.
///
/// NOTE for anyone extending this: `URLProtocol` never sees `httpBody` —
/// URLSession converts it to an `httpBodyStream` before the protocol is
/// invoked. Assertions about the *body* therefore belong in
/// `SignedRequestTests`, which builds the `URLRequest` directly; this class is
/// only good for headers, URLs and call counts.
private final class MockURLProtocol: URLProtocol {

    struct Stub {
        let status: Int
        let body: Data
        var delay: TimeInterval = 0
    }

    private static let lock = NSLock()
    private static var responder: ((URLRequest) -> Stub)?
    private static var seen: [URLRequest] = []

    static func install(_ responder: @escaping (URLRequest) -> Stub) {
        lock.lock(); defer { lock.unlock() }
        self.responder = responder
        seen = []
    }

    static func reset() {
        lock.lock(); defer { lock.unlock() }
        responder = nil
        seen = []
    }

    static func requests() -> [URLRequest] {
        lock.lock(); defer { lock.unlock() }
        return seen
    }

    static func makeSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        return URLSession(configuration: config)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        MockURLProtocol.lock.lock()
        MockURLProtocol.seen.append(request)
        let responder = MockURLProtocol.responder
        MockURLProtocol.lock.unlock()

        let stub = responder?(request) ?? Stub(status: 500, body: Data())
        let deliver = { [weak self] in
            guard let self, let url = self.request.url else { return }
            let response = HTTPURLResponse(
                url: url,
                statusCode: stub.status,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            self.client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            self.client?.urlProtocol(self, didLoad: stub.body)
            self.client?.urlProtocolDidFinishLoading(self)
        }

        if stub.delay > 0 {
            DispatchQueue.global().asyncAfter(deadline: .now() + stub.delay, execute: deliver)
        } else {
            deliver()
        }
    }

    override func stopLoading() {}
}

// =============================================================================
//  Fixtures
// =============================================================================

private enum Fixture {

    /// 32 bytes, the same length the server generates.
    static let ingestKey = Data("0123456789abcdef0123456789abcdef".utf8)

    static let baseURL = URL(string: "https://example.test/api/v1/")!

    static var claimJSON: String {
        """
        {"sessionId":"11111111-1111-4111-8111-111111111111",
         "reference":"KH-2026-000042",
         "accessToken":"access-1",
         "refreshToken":"refresh-1",
         "ingestKey":"\(ingestKey.base64EncodedString())",
         "expiresIn":86400,
         "serverTime":1786531200,
         "policy":{"pingIntervalSec":10,"idleIntervalSec":60,"minDistanceM":0},
         "shipment":{"orderNumber":"SO-42","customerName":"Örnek Gıda","destinationLabel":"Erbil"}}
        """
    }

    static let refreshJSON = """
    {"sessionId":"11111111-1111-4111-8111-111111111111",
     "reference":"KH-2026-000042",
     "accessToken":"access-2",
     "expiresIn":86400,
     "serverTime":1786531200,
     "policy":{"pingIntervalSec":10,"idleIntervalSec":60,"minDistanceM":0}}
    """

    static let tokenExpiredJSON = """
    {"error":{"code":"TOKEN_EXPIRED","message":"Driver token expired"},"serverTime":1786531200}
    """

    static let ingestAcceptedJSON = """
    {"accepted":1,"duplicates":0,"rejected":0,"serverTime":1786531200,
     "sessionStatus":"ACTIVE","pointsTotal":1,"distanceM":0,"nextAction":"CONTINUE"}
    """

    static func claim() throws -> ClaimResponse {
        try JSONDecoder().decode(ClaimResponse.self, from: Data(claimJSON.utf8))
    }

    static func batch(points count: Int = 1) -> IngestBatchRequest {
        IngestBatchRequest(
            batchId: UUID().uuidString,
            offline: false,
            bufferRemaining: 0,
            points: (0..<count).map { index in
                LocationPointDto(
                    id: "01JQ8Z9K3M4N5P6Q7R8S9T0V\(index)",
                    recordedAt: 1_786_530_000_000 + Int64(index) * 1_000,
                    lat: 36.9 + Double(index) * 0.0001,
                    lon: 37.1,
                    accuracy: 8.4,
                    speed: 21.7,
                    bearing: 143.2
                )
            }
        )
    }

    /// A scratch defaults suite, so the clock offset a test writes never leaks
    /// into the next one.
    static func defaults() -> UserDefaults {
        UserDefaults(suiteName: "kh.tests.\(UUID().uuidString)")!
    }
}

// =============================================================================
//  UploadBackoff — ported case for case from UploadBackoffTest.kt
// =============================================================================

/// Pure arithmetic. No clock, no network, no CoreLocation.
///
/// The behaviour under test is the one that costs battery when it is wrong: how
/// long a truck waits before hitting a server that has already refused it.
final class UploadBackoffTests: XCTestCase {

    private var now: TimeInterval = 0

    private func backoff(jitter: Double = 0) -> UploadBackoff {
        UploadBackoff(base: 15, cap: 300, clock: { [self] in now }, random: { jitter })
    }

    override func setUp() {
        super.setUp()
        now = 0
    }

    func testAFreshBackoffNeverWaits() {
        XCTAssertFalse(backoff().shouldWait)
        XCTAssertEqual(backoff().remaining, 0)
    }

    func testTheFirstFailureWaitsExactlyOnePumpTick() {
        var b = backoff()
        b.onFailure()
        // One tick: a single dropped packet must not delay a moving truck by
        // more than the interval it was already waiting.
        XCTAssertEqual(b.remaining, 15, accuracy: 0.001)
        XCTAssertTrue(b.shouldWait)
    }

    func testConsecutiveFailuresDoubleTheWait() {
        var b = backoff()
        var waits: [TimeInterval] = []
        for _ in 1...5 {
            b.onFailure()
            waits.append(b.remaining)
        }
        XCTAssertEqual(waits, [15, 30, 60, 120, 240])
    }

    func testTheWaitIsCapped() {
        var b = backoff()
        for _ in 0..<40 { b.onFailure() }
        XCTAssertEqual(b.remaining, 300, accuracy: 0.001)
    }

    func testTheShiftCannotCollapseIntoAClearedBackoff() {
        // Swift's smart shift returns 0 past the bit width rather than wrapping
        // the way Kotlin's does; either would silently remove the backoff after
        // enough failures, which is the opposite of what a long outage needs.
        var b = backoff()
        for _ in 0..<200 { b.onFailure() }
        XCTAssertGreaterThan(b.remaining, 0, "wait must stay positive after 200 failures")
        XCTAssertEqual(b.remaining, 300, accuracy: 0.001)
    }

    func testTimePassingClearsTheWait() {
        var b = backoff()
        b.onFailure()
        now += 14.999
        XCTAssertTrue(b.shouldWait)
        now += 0.002
        XCTAssertFalse(b.shouldWait)
        XCTAssertEqual(b.remaining, 0)
    }

    func testASuccessClearsTheWaitAndResetsTheLadder() {
        var b = backoff()
        for _ in 0..<4 { b.onFailure() }
        b.onSuccess()
        XCTAssertFalse(b.shouldWait)
        XCTAssertEqual(b.failureCount, 0)

        // The next failure starts from the bottom, not from where the previous
        // run left off.
        b.onFailure()
        XCTAssertEqual(b.remaining, 15, accuracy: 0.001)
    }

    func testTheServersRetryAfterOverridesTheLocalLadder() {
        var b = backoff()
        b.onFailure()
        b.onFailure()
        // The local ladder would say 30 s here; the server said 56.
        b.onFailure(retryAfterSec: 56)
        XCTAssertEqual(b.remaining, 56, accuracy: 0.001)
    }

    func testAShorterRetryAfterIsStillHonoured() {
        var b = backoff()
        for _ in 0..<6 { b.onFailure() }
        XCTAssertEqual(b.remaining, 300, accuracy: 0.001)
        // Trusting the server downward matters too: it knows when its own
        // window resets, and waiting five minutes when it said two is five
        // minutes of a truck being invisible for nothing.
        b.onFailure(retryAfterSec: 120)
        XCTAssertEqual(b.remaining, 120, accuracy: 0.001)
    }

    func testANonsenseRetryAfterFallsBackToTheLadder() {
        var b = backoff()
        b.onFailure(retryAfterSec: 0)
        XCTAssertEqual(b.remaining, 15, accuracy: 0.001)
        b.onSuccess()
        b.onFailure(retryAfterSec: -30)
        XCTAssertEqual(b.remaining, 15, accuracy: 0.001)
    }

    func testJitterOnlyEverExtendsTheWait() {
        // Never negative: waiting less than the server asked for is the one
        // direction that must not happen.
        var full = UploadBackoff(base: 15, cap: 300, clock: { [self] in now }, random: { 1 })
        full.onFailure()
        XCTAssertEqual(full.remaining, 18, accuracy: 0.001)

        var none = backoff(jitter: 0)
        none.onFailure()
        XCTAssertEqual(none.remaining, 15, accuracy: 0.001)
    }

    func testJitterSpreadsAFleetThatFailedTogether() {
        // Forty trucks hitting the same 429 in the same second must not retry
        // in the same second, or they reconstruct the burst that caused it.
        let waits: [TimeInterval] = (0..<40).map { index in
            var b = UploadBackoff(
                base: 15, cap: 300,
                clock: { [self] in now },
                random: { Double(index) / 40.0 }
            )
            b.onFailure(retryAfterSec: 60)
            return b.remaining
        }
        XCTAssertEqual(waits.min() ?? 0, 60, accuracy: 0.001)
        XCTAssertGreaterThanOrEqual((waits.max() ?? 0) - (waits.min() ?? 0), 11)
        XCTAssertGreaterThan(Set(waits.map { Int($0 * 1000) }).count, 30)
    }
}

// =============================================================================
//  HMAC
// =============================================================================

/// The canonical string is a contract with `crypto.util.ts::ingestSignature`.
/// Anything that changes these expectations breaks every driver phone at once,
/// so they are pinned against published vectors rather than against ourselves.
final class HmacSignerTests: XCTestCase {

    func testHexIsLowercaseAndMatchesAPublishedVector() {
        // RFC 4231, test case 1. Validates both the hex encoder and that
        // CryptoKit is being driven as HMAC-SHA256 rather than anything else.
        let key = SymmetricKey(data: Data(repeating: 0x0b, count: 20))
        let mac = HMAC<SHA256>.authenticationCode(for: Data("Hi There".utf8), using: key)
        XCTAssertEqual(
            HmacSigner.hex(mac),
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
        )
    }

    func testHexHandlesTheEdgeNibbles() {
        XCTAssertEqual(HmacSigner.hex([0x00, 0x0f, 0xf0, 0xff] as [UInt8]), "000ff0ff")
        XCTAssertEqual(HmacSigner.hex([] as [UInt8]), "")
    }

    func testCanonicalStringIsExactlyWhatTheServerHashes() {
        // "{timestamp}.{nonce}.{sha256hex(body)}" — dots, that order, lowercase
        // hex, and the digest of the RAW body bytes.
        XCTAssertEqual(
            HmacSigner.canonicalString(timestamp: "1786531200", nonce: "3f9a", body: Data()),
            "1786531200.3f9a.e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        )
        XCTAssertEqual(
            HmacSigner.canonicalString(timestamp: "1", nonce: "n", body: Data("abc".utf8)),
            "1.n.ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        )
    }

    func testSignatureIsDeterministicAndBodyBound() {
        let a = HmacSigner.signature(
            key: Fixture.ingestKey, timestamp: "1786531200", nonce: "abcd", body: Data("{}".utf8)
        )
        let b = HmacSigner.signature(
            key: Fixture.ingestKey, timestamp: "1786531200", nonce: "abcd", body: Data("{}".utf8)
        )
        XCTAssertEqual(a, b)
        XCTAssertEqual(a.count, 64)
        XCTAssertEqual(a, a.lowercased())

        // Changing any of the three inputs must change the signature — that is
        // the entire anti-replay property.
        XCTAssertNotEqual(a, HmacSigner.signature(
            key: Fixture.ingestKey, timestamp: "1786531201", nonce: "abcd", body: Data("{}".utf8)
        ))
        XCTAssertNotEqual(a, HmacSigner.signature(
            key: Fixture.ingestKey, timestamp: "1786531200", nonce: "abce", body: Data("{}".utf8)
        ))
        XCTAssertNotEqual(a, HmacSigner.signature(
            key: Fixture.ingestKey, timestamp: "1786531200", nonce: "abcd", body: Data("{ }".utf8)
        ))
    }

    func testTimestampIsTruncatedNotRounded() {
        // The server parses this with parseInt; "1786531200.9" is a
        // BAD_TIMESTAMP, and rounding up would sign a second that has not
        // happened yet.
        let headers = HmacSigner.sign(
            body: Data(),
            key: Fixture.ingestKey,
            now: Date(timeIntervalSince1970: 1_786_531_200.9),
            nonce: "n"
        )
        XCTAssertEqual(headers.timestamp, "1786531200")
    }

    func testNonceIsFreshAndInsideTheServersLengthBound() {
        let nonces = (0..<200).map { _ in HmacSigner.randomNonce() }
        // 8…64 characters, per the guard.
        XCTAssertEqual(nonces[0].count, 32)
        XCTAssertEqual(Set(nonces).count, 200, "a repeated nonce is a REPLAY_DETECTED in the field")
        XCTAssertTrue(nonces.allSatisfy { nonce in
            nonce.allSatisfy { "0123456789abcdef".contains($0) }
        })
    }
}

// =============================================================================
//  gzip
// =============================================================================

/// The framing the Compression framework does not give us.
///
/// `COMPRESSION_ZLIB` emits raw DEFLATE; without the header and trailer built
/// here the server's `createGunzip` rejects the body before the guard sees it.
final class GzipTests: XCTestCase {

    private let compressible = Data(
        String(repeating: #"{"id":"01JQ8Z9K3M4N5P6Q7R8S9T0V1W","lat":36.9,"lon":37.1},"#, count: 200).utf8
    )

    func testCrc32MatchesTheStandardCheckValues() {
        XCTAssertEqual(Gzip.crc32(Data()), 0)
        XCTAssertEqual(Gzip.crc32(Data("123456789".utf8)), 0xCBF4_3926)
    }

    func testHeaderIsAGzipHeader() throws {
        let out = try XCTUnwrap(Gzip.compress(compressible))
        XCTAssertEqual(out[0], 0x1f)
        XCTAssertEqual(out[1], 0x8b)
        XCTAssertEqual(out[2], 0x08, "CM must say DEFLATE")
        XCTAssertEqual(out[3], 0x00, "no FLG bits, so no extra fields to parse")
        // MTIME zero keeps the output reproducible and leaks no clock.
        XCTAssertEqual(Array(out[4..<8]), [0, 0, 0, 0])
    }

    func testTrailerCarriesTheCrcAndSizeOfTheUNCOMPRESSEDBody() throws {
        let out = try XCTUnwrap(Gzip.compress(compressible))
        let trailer = Array(out.suffix(8))

        let crc = UInt32(trailer[0]) | UInt32(trailer[1]) << 8
            | UInt32(trailer[2]) << 16 | UInt32(trailer[3]) << 24
        let size = UInt32(trailer[4]) | UInt32(trailer[5]) << 8
            | UInt32(trailer[6]) << 16 | UInt32(trailer[7]) << 24

        XCTAssertEqual(crc, Gzip.crc32(compressible))
        XCTAssertEqual(size, UInt32(compressible.count))
    }

    func testItActuallyCompresses() throws {
        let out = try XCTUnwrap(Gzip.compress(compressible))
        // A telemetry backlog is extremely repetitive; anything worse than 4:1
        // means the encoder is not doing what we think it is.
        XCTAssertLessThan(out.count, compressible.count / 4)
    }

    func testIncompressibleAndEmptyInputsAreDeclined() {
        // Nil means "send it uncompressed", which is the correct answer for
        // both: gzip would only add 18 bytes and a CPU pass.
        XCTAssertNil(Gzip.compress(Data()))

        let random = Data((0..<4096).map { _ in UInt8.random(in: 0...255) })
        XCTAssertNil(Gzip.compress(random))
    }
}

// =============================================================================
//  Request construction — the highest-value test in this slice
// =============================================================================

final class SignedRequestTests: XCTestCase {

    private let timestamp = "1786531200"
    private let nonce = "0123456789abcdef0123456789abcdef"
    private var now: Date { Date(timeIntervalSince1970: 1_786_531_200) }

    private func build(
        path: String = "ingest/batch",
        method: String = "POST",
        body: Data?,
        bearer: String? = "access-1",
        ingestKey: Data? = Fixture.ingestKey,
        allowCompression: Bool = false
    ) -> URLRequest {
        SignedRequest.build(SignedRequest.Inputs(
            baseURL: Fixture.baseURL,
            path: path,
            method: method,
            body: body,
            bearer: bearer,
            ingestKey: ingestKey,
            deviceId: "device-1",
            now: now,
            nonce: nonce,
            allowCompression: allowCompression
        ))
    }

    /// THE regression this whole slice exists to prevent.
    ///
    /// Sign the compressed bytes and every gzipped upload comes back
    /// BAD_SIGNATURE — on every phone, from the first batch, with nothing in
    /// the client's logs to say why.
    func testSignatureCoversTheUncompressedBodyWhileTheWireCarriesGzip() throws {
        let payload = Data(
            String(repeating: #"{"id":"01JQ8Z9K3M4N5P6Q7R8S9T0V1W","lat":36.9},"#, count: 120).utf8
        )
        let request = build(body: payload, allowCompression: true)

        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Encoding"), "gzip")
        let wire = try XCTUnwrap(request.httpBody)
        XCTAssertLessThan(wire.count, payload.count / 2)

        let signature = try XCTUnwrap(request.value(forHTTPHeaderField: "X-KH-Signature"))
        XCTAssertEqual(
            signature,
            HmacSigner.signature(
                key: Fixture.ingestKey, timestamp: timestamp, nonce: nonce, body: payload
            ),
            "the signature must cover the plain JSON the server hashes after decompressing"
        )
        XCTAssertNotEqual(
            signature,
            HmacSigner.signature(
                key: Fixture.ingestKey, timestamp: timestamp, nonce: nonce, body: wire
            ),
            "if these ever match, the ordering has been reversed"
        )
    }

    func testTinyBodiesAreNotCompressed() throws {
        // Below the floor gzip costs more in CPU and headers than it saves, and
        // a single realtime ping is well below it.
        let payload = Data(#"{"batchId":"x","offline":false,"points":[]}"#.utf8)
        XCTAssertLessThan(payload.count, SignedRequest.compressionFloorBytes)

        let request = build(body: payload, allowCompression: true)
        XCTAssertNil(request.value(forHTTPHeaderField: "Content-Encoding"))
        XCTAssertEqual(request.httpBody, payload)
    }

    func testCompressionIsOptInPerCall() {
        // Only /ingest/batch asks for it. An event or a stop is a few dozen
        // bytes and would grow.
        let payload = Data(String(repeating: "a", count: 4096).utf8)
        let request = build(path: "driver/events", body: payload, allowCompression: false)
        XCTAssertNil(request.value(forHTTPHeaderField: "Content-Encoding"))
        XCTAssertEqual(request.httpBody?.count, payload.count)
    }

    func testAllFourSignatureHeadersAreAttached() throws {
        let request = build(body: Data("{}".utf8))
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer access-1")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-KH-Timestamp"), timestamp)
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-KH-Nonce"), nonce)
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-KH-Device-Id"), "device-1")
        XCTAssertNotNil(request.value(forHTTPHeaderField: "X-KH-Signature"))
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
    }

    func testAcceptEncodingIsLeftToURLSession() {
        // Setting it by hand turns off URLSession's transparent inflation and
        // hands us compressed response bytes to decode ourselves.
        let request = build(body: Data("{}".utf8))
        XCTAssertNil(request.value(forHTTPHeaderField: "Accept-Encoding"))
    }

    func testClaimAndRefreshAreUnsigned() {
        // No credential exists yet (claim) or the access token is dead
        // (refresh); both authenticate against secrets in the body.
        let request = build(
            path: "driver/claim", body: Data("{}".utf8), bearer: nil, ingestKey: nil
        )
        XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
        XCTAssertNil(request.value(forHTTPHeaderField: "X-KH-Signature"))
        XCTAssertNil(request.value(forHTTPHeaderField: "X-KH-Nonce"))
        // The device id still goes, so an unauthenticated failure is traceable.
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-KH-Device-Id"), "device-1")
    }

    func testGetIsSignedOverAnEmptyBodyAndCarriesNone() throws {
        let request = build(path: "driver/session", method: "GET", body: nil)
        XCTAssertNil(request.httpBody)
        XCTAssertNil(request.value(forHTTPHeaderField: "Content-Type"))
        // The guard skips HMAC on GET today; signing anyway means tightening it
        // does not black out the fleet.
        XCTAssertEqual(
            request.value(forHTTPHeaderField: "X-KH-Signature"),
            HmacSigner.signature(
                key: Fixture.ingestKey, timestamp: timestamp, nonce: nonce, body: Data()
            )
        )
    }

    func testPathsResolveUnderTheApiPrefix() {
        // The trailing slash on the base URL is load-bearing — the same trap
        // Retrofit has. Without it, RFC 3986 resolution eats "v1".
        XCTAssertEqual(
            build(path: "ingest/batch", body: nil).url?.absoluteString,
            "https://example.test/api/v1/ingest/batch"
        )
        XCTAssertEqual(
            build(path: "driver/token/refresh", body: nil).url?.absoluteString,
            "https://example.test/api/v1/driver/token/refresh"
        )
    }

    func testCachingAndCookiesAreOff() {
        // A truck-stop captive portal will answer 200 with its own login page
        // and a Set-Cookie. Neither may be kept.
        let request = build(body: Data("{}".utf8))
        XCTAssertEqual(request.cachePolicy, .reloadIgnoringLocalCacheData)
        XCTAssertFalse(request.httpShouldHandleCookies)
    }
}

// MARK: - Wire encoding

final class WireEncodingTests: XCTestCase {

    func testAbsentOptionalsAreOmittedRatherThanSentAsNull() throws {
        let point = LocationPointDto(id: "01JQ", recordedAt: 1_786_530_000_000, lat: 36.9, lon: 37.1)
        let json = String(decoding: try JSONEncoder().encode(point), as: UTF8.self)

        // ~15% of a backlog upload is `"field":null` if this regresses, and a
        // backlog upload is the one that has to fit inside a 2 G coverage
        // window.
        XCTAssertFalse(json.contains("null"))
        XCTAssertFalse(json.contains("satellites"))
        XCTAssertTrue(json.contains("\"recordedAt\":1786530000000"))
        XCTAssertTrue(json.contains("\"id\":\"01JQ\""))
    }

    func testClaimDecodesAndKeepsTheShipmentContext() throws {
        let claim = try Fixture.claim()
        XCTAssertEqual(claim.accessToken, "access-1")
        XCTAssertEqual(claim.ingestKey, Fixture.ingestKey.base64EncodedString())
        XCTAssertEqual(claim.shipment.orderNumber, "SO-42")
        XCTAssertEqual(claim.policy.pingIntervalSec, 10)
    }

    func testAMissingIngestKeyIsARefusalNotADefault() {
        // Defaulting it to "" would produce a session that signs every request
        // wrong and reports BAD_SIGNATURE forever, with no way to recover.
        let json = #"{"sessionId":"s","accessToken":"a","refreshToken":"r"}"#
        XCTAssertThrowsError(
            try JSONDecoder().decode(ClaimResponse.self, from: Data(json.utf8))
        )
    }

    func testOneOddFieldDoesNotCostUsTheWholeResponse() throws {
        // `distanceM` as a string and an unknown key. The serverTime and
        // sessionStatus in this body are what the phone needs most.
        let json = """
        {"accepted":5,"duplicates":1,"distanceM":"12.5","serverTime":1786531200,
         "sessionStatus":"COMPLETED","somethingNewIn2027":true}
        """
        let response = try JSONDecoder().decode(IngestResponse.self, from: Data(json.utf8))
        XCTAssertEqual(response.accepted, 5)
        XCTAssertEqual(response.duplicates, 1)
        XCTAssertEqual(response.distanceM, 0, "the odd field falls back, it does not throw")
        XCTAssertEqual(response.serverTime, 1_786_531_200)
        XCTAssertTrue(response.sessionIsClosed)
    }

    func testOpenSessionStatusesAreNotReportedAsClosed() throws {
        for status in ["CLAIMED", "ACTIVE", "PAUSED"] {
            let json = #"{"serverTime":1,"sessionStatus":"\#(status)"}"#
            let response = try JSONDecoder().decode(IngestResponse.self, from: Data(json.utf8))
            XCTAssertFalse(response.sessionIsClosed, status)
        }
        // No status at all is not a closed session either — it is a server that
        // did not say.
        let silent = try JSONDecoder().decode(IngestResponse.self, from: Data(#"{"serverTime":1}"#.utf8))
        XCTAssertFalse(silent.sessionIsClosed)
    }

    func testPolicyIsClampedOnTheWayIn() {
        // Straight through to TrackingPolicy, which clamps to migration 0007's
        // bounds. A cadence the phone holds must be one the server would store.
        let absurd = PolicyDto(pingIntervalSec: 0, idleIntervalSec: 1, minDistanceM: -50).resolved
        XCTAssertEqual(absurd.pingIntervalSec, 2)
        XCTAssertGreaterThanOrEqual(absurd.idleIntervalSec, absurd.pingIntervalSec)
        XCTAssertEqual(absurd.minDistanceM, 0)
    }
}

// =============================================================================
//  Error classification
// =============================================================================

final class ApiFailureTests: XCTestCase {

    func testTheServersCodeWinsOverTheHttpStatus() {
        // A 401 that says SESSION_CLOSED is a finished delivery, not a stale
        // token, and refreshing would be twenty pointless requests.
        XCTAssertEqual(ApiFailure.classify(status: 401, code: "SESSION_CLOSED"), .sessionClosed)
        XCTAssertEqual(ApiFailure.classify(status: 401, code: "TOKEN_EXPIRED"), .tokenExpired)
        XCTAssertEqual(ApiFailure.classify(status: 403, code: "DEVICE_MISMATCH"), .unauthorised)
        XCTAssertEqual(ApiFailure.classify(status: 401, code: "TOKEN_REVOKED"), .unauthorised)
        XCTAssertEqual(ApiFailure.classify(status: 401, code: "REFRESH_EXPIRED"), .unauthorised)
    }

    func testClockSkewAndReplayAreTransientBecauseTheRetryFixesThem() {
        // The device resyncs from the serverTime on the rejection itself, and
        // the retry carries a fresh nonce.
        XCTAssertEqual(ApiFailure.classify(status: 401, code: "CLOCK_SKEW"), .transient)
        XCTAssertEqual(ApiFailure.classify(status: 401, code: "REPLAY_DETECTED"), .transient)
    }

    func testStatusCodesWithoutABodyStillClassify() {
        // A proxy or CDN in front of the API answers with its own error page,
        // so there is no envelope to read.
        XCTAssertEqual(ApiFailure.classify(status: 401, code: nil), .tokenExpired)
        XCTAssertEqual(ApiFailure.classify(status: 403, code: nil), .unauthorised)
        XCTAssertEqual(ApiFailure.classify(status: 413, code: nil), .batchTooLarge)
        XCTAssertEqual(ApiFailure.classify(status: 429, code: nil), .rateLimited)
        XCTAssertEqual(ApiFailure.classify(status: 422, code: nil), .permanent)
        XCTAssertEqual(ApiFailure.classify(status: 400, code: nil), .permanent)
        XCTAssertEqual(ApiFailure.classify(status: 503, code: nil), .transient)
        XCTAssertEqual(ApiFailure.classify(status: 502, code: nil), .transient)
    }

    func testConflictIsNotRetriedForever() {
        // Diverges from Android, which lets 409 fall through to TRANSIENT. The
        // only source of a 409 here is a unique violation, and that is still a
        // unique violation on the tenth attempt.
        XCTAssertEqual(ApiFailure.classify(status: 409, code: nil), .permanent)
        XCTAssertFalse(ApiFailure.classify(status: 409, code: nil).isRetryableAsIs)
    }

    func testOnlyTheOutcomesAResendCanFixAreRetryableAsIs() {
        XCTAssertTrue(ApiFailure.transient.isRetryableAsIs)
        XCTAssertTrue(ApiFailure.rateLimited.isRetryableAsIs)
        // Both of these are retried by the sync loop, but only after RE-CHUNKING
        // — different bytes. Conflating the two turns one poisoned row into a
        // queue that never drains.
        XCTAssertFalse(ApiFailure.batchTooLarge.isRetryableAsIs)
        XCTAssertFalse(ApiFailure.permanent.isRetryableAsIs)
        XCTAssertFalse(ApiFailure.tokenExpired.isRetryableAsIs)
    }

    func testTerminalMeansTheDriverHasToDoSomething() {
        XCTAssertTrue(ApiFailure.sessionClosed.isTerminal)
        XCTAssertTrue(ApiFailure.unauthorised.isTerminal)
        XCTAssertFalse(ApiFailure.transient.isTerminal)
        XCTAssertFalse(ApiFailure.batchTooLarge.isTerminal)
    }

    func testTransportAndEncodingFailuresLandInTheRightBranch() {
        XCTAssertEqual(ApiError.transport(URLError(.timedOut)).failure, .transient)
        XCTAssertEqual(ApiError.transport(URLError(.notConnectedToInternet)).failure, .transient)
        XCTAssertEqual(ApiError.malformedResponse("captive portal html").failure, .transient)
        XCTAssertEqual(ApiError.noCredentials.failure, .unauthorised)
        // A NaN latitude cannot be encoded and never will be; the sync loop has
        // to isolate it, not retry it.
        XCTAssertEqual(ApiError.unencodableRequest("NaN lat").failure, .permanent)
    }
}

final class ApiErrorBodyTests: XCTestCase {

    func testRetryAfterIsReadWhenTheServerSendsItAsANumber() throws {
        // Which is what the rate limiter actually does. Android decodes
        // `details` as a string map and silently loses this.
        let json = """
        {"error":{"code":"RATE_LIMITED","message":"Too many attempts. Retry in 42s.",
         "details":{"retryAfterSec":42}},"serverTime":1786531200}
        """
        let body = try JSONDecoder().decode(ApiErrorBody.self, from: Data(json.utf8))
        XCTAssertEqual(body.error?.code, "RATE_LIMITED")
        XCTAssertEqual(body.retryAfterSec, 42)
        XCTAssertEqual(body.serverTime, 1_786_531_200)
    }

    func testRetryAfterIsAlsoReadAsAString() throws {
        let json = #"{"error":{"code":"RATE_LIMITED","message":"","details":{"retryAfterSec":"42"}}}"#
        let body = try JSONDecoder().decode(ApiErrorBody.self, from: Data(json.utf8))
        XCTAssertEqual(body.retryAfterSec, 42)
    }

    func testSessionClosedCarriesTheReasonTheDriverIsShown() throws {
        let json = """
        {"error":{"code":"SESSION_CLOSED","message":"Tracking session is COMPLETED",
         "details":{"status":"COMPLETED"}},"serverTime":1786531200}
        """
        let body = try JSONDecoder().decode(ApiErrorBody.self, from: Data(json.utf8))
        XCTAssertEqual(body.sessionStatus, "COMPLETED")
    }

    func testAnEnvelopeWithNoDetailsIsStillReadable() throws {
        let json = #"{"error":{"code":"BAD_SIGNATURE","message":"nope"},"serverTime":1}"#
        let body = try JSONDecoder().decode(ApiErrorBody.self, from: Data(json.utf8))
        XCTAssertEqual(body.error?.code, "BAD_SIGNATURE")
        XCTAssertNil(body.retryAfterSec)
    }
}

// =============================================================================
//  CredentialStore
// =============================================================================

final class CredentialStoreTests: XCTestCase {

    func testCredentialsRoundTripAsOneAtomicItem() async throws {
        let secrets = InMemorySecretStore()
        let defaults = Fixture.defaults()

        let first = CredentialStore(secrets: secrets, defaults: defaults)
        try await first.save(claim: Fixture.claim())

        // A cold start reads the same blob back — this is the app relaunching
        // mid-delivery after a jetsam kill.
        let second = CredentialStore(secrets: secrets, defaults: defaults)
        let loaded = await second.credentials()
        let restored = try XCTUnwrap(loaded)
        XCTAssertEqual(restored.accessToken, "access-1")
        XCTAssertEqual(restored.refreshToken, "refresh-1")
        XCTAssertEqual(restored.ingestKey, Fixture.ingestKey)
        XCTAssertEqual(restored.reference, "KH-2026-000042")
    }

    func testTheDeviceIdIsStableAcrossLaunches() async {
        let secrets = InMemorySecretStore()
        let first = await CredentialStore(secrets: secrets, defaults: Fixture.defaults()).deviceId()
        let second = await CredentialStore(secrets: secrets, defaults: Fixture.defaults()).deviceId()
        // A regenerated id presents as a different phone, and the guard answers
        // DEVICE_MISMATCH on the very next upload.
        XCTAssertEqual(first, second)
        XCTAssertFalse(first.isEmpty)
    }

    func testRefreshReplacesOnlyTheAccessToken() async throws {
        let store = CredentialStore(secrets: InMemorySecretStore(), defaults: Fixture.defaults())
        try await store.save(claim: Fixture.claim())

        let refresh = try JSONDecoder().decode(
            RefreshResponse.self, from: Data(Fixture.refreshJSON.utf8)
        )
        try await store.apply(refresh: refresh)

        let loaded = await store.credentials()
        let credentials = try XCTUnwrap(loaded)
        XCTAssertEqual(credentials.accessToken, "access-2")
        // Rotating either of these mid-shift would force a re-claim if a
        // response were lost, and a driver in a dead zone cannot get a code.
        XCTAssertEqual(credentials.refreshToken, "refresh-1")
        XCTAssertEqual(credentials.ingestKey, Fixture.ingestKey)
    }

    func testClearingTheSessionKeepsTheDeviceId() async throws {
        let secrets = InMemorySecretStore()
        let store = CredentialStore(secrets: secrets, defaults: Fixture.defaults())
        let deviceId = await store.deviceId()
        try await store.save(claim: Fixture.claim())

        await store.clear()

        let after = await store.credentials()
        XCTAssertNil(after)

        // Re-claiming on the same phone has to be recognised as the same phone.
        let sameStore = await store.deviceId()
        let newStore = await CredentialStore(
            secrets: secrets, defaults: Fixture.defaults()
        ).deviceId()
        XCTAssertEqual(sameStore, deviceId)
        XCTAssertEqual(newStore, deviceId)
    }

    func testAMalformedIngestKeyFailsTheClaimLoudly() async throws {
        let json = """
        {"sessionId":"s","reference":"R","accessToken":"a","refreshToken":"r",
         "ingestKey":"not base64 at all !!","expiresIn":10,"serverTime":1}
        """
        let claim = try JSONDecoder().decode(ClaimResponse.self, from: Data(json.utf8))
        let store = CredentialStore(secrets: InMemorySecretStore(), defaults: Fixture.defaults())

        do {
            try await store.save(claim: claim)
            XCTFail("a session that cannot sign is not a session")
        } catch {
            XCTAssertEqual(
                error as? CredentialStoreError,
                CredentialStoreError.malformedIngestKey
            )
        }
    }

    func testAKeychainFailureStillLeavesAUsableSession() async throws {
        let secrets = InMemorySecretStore()
        secrets.refuseWrites = true
        let store = CredentialStore(secrets: secrets, defaults: Fixture.defaults())

        // The write throws so the caller can report it...
        do {
            try await store.save(claim: Fixture.claim())
            XCTFail("the failure has to be visible")
        } catch {}

        // ...but the in-memory copy is live, because the claim code is already
        // consumed and a shift that works until the app is killed beats a shift
        // that never starts.
        let loaded = await store.credentials()
        let credentials = try XCTUnwrap(loaded)
        XCTAssertEqual(credentials.accessToken, "access-1")
    }

    func testTheClockCorrectsItselfFromTheServer() async {
        let store = CredentialStore(secrets: InMemorySecretStore(), defaults: Fixture.defaults())

        // A phone two hours slow. The HMAC timestamp would be rejected as
        // CLOCK_SKEW, and the rejection itself is what fixes it.
        let serverNow = Int(Date().timeIntervalSince1970) + 7_200
        await store.recordServerTime(serverNow)

        let corrected = await store.correctedNow().timeIntervalSince1970
        let offset = await store.clockOffsetSeconds
        XCTAssertEqual(corrected, Double(serverNow), accuracy: 2)
        XCTAssertEqual(offset, 7_200, accuracy: 2)

        // A nonsense serverTime is ignored rather than throwing the clock away.
        await store.recordServerTime(0)
        let unchanged = await store.clockOffsetSeconds
        XCTAssertEqual(unchanged, 7_200, accuracy: 2)
    }

    func testTheOffsetSurvivesARelaunch() async {
        let secrets = InMemorySecretStore()
        let defaults = Fixture.defaults()
        let serverNow = Int(Date().timeIntervalSince1970) + 3_600
        await CredentialStore(secrets: secrets, defaults: defaults).recordServerTime(serverNow)

        // The first signed request after a cold start must already be correct;
        // there may be no network to learn from.
        let reborn = CredentialStore(secrets: secrets, defaults: defaults)
        let offset = await reborn.clockOffsetSeconds
        XCTAssertEqual(offset, 3_600, accuracy: 2)
    }

    func testRefreshIsAnticipatedRatherThanWaitedFor() async throws {
        let json = """
        {"sessionId":"s","reference":"R","accessToken":"a","refreshToken":"r",
         "ingestKey":"\(Fixture.ingestKey.base64EncodedString())",
         "expiresIn":60,"serverTime":1786531200}
        """
        let claim = try JSONDecoder().decode(ClaimResponse.self, from: Data(json.utf8))
        let store = CredentialStore(secrets: InMemorySecretStore(), defaults: Fixture.defaults())
        try await store.save(claim: claim)

        // 60 s of life left is inside the two-minute lead time: a truck about to
        // enter a dead zone should carry a fresh token into it.
        let needs = await store.needsRefresh
        XCTAssertTrue(needs)

        let empty = CredentialStore(secrets: InMemorySecretStore(), defaults: Fixture.defaults())
        let noSession = await empty.needsRefresh
        XCTAssertFalse(noSession, "no session is not a session that needs refreshing")
    }
}

// =============================================================================
//  ApiClient — refresh behaviour
// =============================================================================

final class ApiClientRefreshTests: XCTestCase {

    override func tearDown() {
        MockURLProtocol.reset()
        super.tearDown()
    }

    private func makeStore() async throws -> CredentialStore {
        let store = CredentialStore(secrets: InMemorySecretStore(), defaults: Fixture.defaults())
        try await store.save(claim: Fixture.claim())
        return store
    }

    /// Five calls 401 in the same instant. Exactly one refresh may leave the
    /// phone.
    ///
    /// Independent refreshes would burn the sixty-per-minute limit on
    /// `driver/token/refresh` at the moment the app can least afford to be
    /// locked out — and the day the server starts rotating refresh tokens, N
    /// concurrent presentations of the same one are indistinguishable from a
    /// stolen-token replay.
    func testOneRefreshServesEveryConcurrentTokenExpiry() async throws {
        let store = try await makeStore()
        let counter = CallCounter()

        MockURLProtocol.install { request in
            let path = request.url?.path ?? ""
            if path.hasSuffix("/token/refresh") {
                counter.bump("refresh")
                // Long enough that every one of the five 401s has landed before
                // the refresh completes, which is the situation being tested.
                return MockURLProtocol.Stub(
                    status: 200, body: Data(Fixture.refreshJSON.utf8), delay: 0.25
                )
            }
            if counter.bump("ingest") <= 5 {
                return MockURLProtocol.Stub(
                    status: 401, body: Data(Fixture.tokenExpiredJSON.utf8)
                )
            }
            return MockURLProtocol.Stub(
                status: 202, body: Data(Fixture.ingestAcceptedJSON.utf8)
            )
        }

        let client = ApiClient(
            credentials: store,
            baseURL: Fixture.baseURL,
            session: MockURLProtocol.makeSession()
        )

        try await withThrowingTaskGroup(of: Void.self) { group in
            for _ in 0..<5 {
                group.addTask { _ = try await client.ingest(Fixture.batch()) }
            }
            try await group.waitForAll()
        }

        XCTAssertEqual(counter.value("refresh"), 1, "the refresh must be single-flight")
        XCTAssertEqual(counter.value("ingest"), 10, "five failures, five retries")

        let loaded = await store.credentials()
        let credentials = try XCTUnwrap(loaded)
        XCTAssertEqual(credentials.accessToken, "access-2")
    }

    /// Every signed request carries its own nonce, including the retry.
    ///
    /// Replaying the first attempt's nonce after a refresh turns a token
    /// problem into REPLAY_DETECTED, and the driver never gets past it.
    func testTheRetryIsResignedWithAFreshNonce() async throws {
        let store = try await makeStore()
        let counter = CallCounter()

        MockURLProtocol.install { request in
            if request.url?.path.hasSuffix("/token/refresh") == true {
                return MockURLProtocol.Stub(status: 200, body: Data(Fixture.refreshJSON.utf8))
            }
            if counter.bump("ingest") == 1 {
                return MockURLProtocol.Stub(status: 401, body: Data(Fixture.tokenExpiredJSON.utf8))
            }
            return MockURLProtocol.Stub(status: 202, body: Data(Fixture.ingestAcceptedJSON.utf8))
        }

        let client = ApiClient(
            credentials: store,
            baseURL: Fixture.baseURL,
            session: MockURLProtocol.makeSession()
        )
        let response = try await client.ingest(Fixture.batch())
        XCTAssertEqual(response.accepted, 1)

        let nonces = MockURLProtocol.requests().compactMap {
            $0.value(forHTTPHeaderField: "X-KH-Nonce")
        }
        XCTAssertEqual(nonces.count, 2, "the refresh call is unsigned and has none")
        XCTAssertEqual(Set(nonces).count, 2, "a reused nonce is REPLAY_DETECTED")

        let bearers = MockURLProtocol.requests().compactMap {
            $0.value(forHTTPHeaderField: "Authorization")
        }
        XCTAssertTrue(bearers.contains("Bearer access-1"))
        XCTAssertTrue(bearers.contains("Bearer access-2"), "the retry must use the new token")
    }

    func testATerminalRejectionIsNotRetriedAndNotRefreshed() async throws {
        let store = try await makeStore()
        let counter = CallCounter()

        MockURLProtocol.install { request in
            counter.bump(request.url?.path.hasSuffix("/token/refresh") == true ? "refresh" : "ingest")
            return MockURLProtocol.Stub(
                status: 403,
                body: Data(#"{"error":{"code":"DEVICE_MISMATCH","message":"bound elsewhere"},"serverTime":1786531200}"#.utf8)
            )
        }

        let client = ApiClient(
            credentials: store,
            baseURL: Fixture.baseURL,
            session: MockURLProtocol.makeSession()
        )

        do {
            _ = try await client.ingest(Fixture.batch())
            XCTFail("a cloned session must not be papered over")
        } catch let error as ApiError {
            XCTAssertEqual(error.failure, .unauthorised)
            XCTAssertEqual(error.code, "DEVICE_MISMATCH")
            XCTAssertTrue(error.failure.isTerminal)
        }

        XCTAssertEqual(counter.value("ingest"), 1, "no retry on a terminal rejection")
        XCTAssertEqual(counter.value("refresh"), 0, "and no refresh either")
    }

    func testRateLimitingSurfacesTheServersOwnRetryHint() async throws {
        let store = try await makeStore()

        MockURLProtocol.install { _ in
            MockURLProtocol.Stub(
                status: 429,
                body: Data("""
                {"error":{"code":"RATE_LIMITED","message":"Too many requests for this session",
                 "details":{"retryAfterSec":37}},"serverTime":1786531200}
                """.utf8)
            )
        }

        let client = ApiClient(
            credentials: store,
            baseURL: Fixture.baseURL,
            session: MockURLProtocol.makeSession()
        )

        do {
            _ = try await client.ingest(Fixture.batch())
            XCTFail("429 is a failure")
        } catch let error as ApiError {
            XCTAssertEqual(error.failure, .rateLimited)
            // Straight into UploadBackoff.onFailure(retryAfterSec:).
            XCTAssertEqual(error.retryAfterSec, 37)
        }
    }

    /// The clock recovery loop, end to end.
    func testTheClockIsCorrectedFromARejection() async throws {
        let store = try await makeStore()
        let serverNow = Int(Date().timeIntervalSince1970) + 5_400

        MockURLProtocol.install { _ in
            MockURLProtocol.Stub(
                status: 401,
                body: Data("""
                {"error":{"code":"CLOCK_SKEW","message":"Request timestamp is 5400s off server time"},
                 "serverTime":\(serverNow)}
                """.utf8)
            )
        }

        let client = ApiClient(
            credentials: store,
            baseURL: Fixture.baseURL,
            session: MockURLProtocol.makeSession()
        )

        // CLOCK_SKEW arrives with a 401, but the *code* is what classifies it,
        // so it is transient rather than a token problem — no refresh, no
        // retry, and the ladder backs off. What matters is that the rejection
        // carried the real time and the phone kept it.
        do {
            _ = try await client.ingest(Fixture.batch())
            XCTFail("the skewed request is rejected")
        } catch let error as ApiError {
            XCTAssertEqual(error.failure, .transient)
            XCTAssertEqual(error.code, "CLOCK_SKEW")
        }

        let offset = await store.clockOffsetSeconds
        XCTAssertEqual(offset, 5_400, accuracy: 5)
    }

    func testAnEmptyTwoHundredIsNotAFailure() async throws {
        let store = try await makeStore()
        MockURLProtocol.install { _ in MockURLProtocol.Stub(status: 200, body: Data()) }

        let client = ApiClient(
            credentials: store,
            baseURL: Fixture.baseURL,
            session: MockURLProtocol.makeSession()
        )
        // `driver/stop` answers with the transition result, not `{ok,…}`; what
        // matters is the 2xx.
        let ack = try await client.stop()
        XCTAssertTrue(ack.ok)
    }

    func testACaptivePortalPageIsNotDecodedAsSuccess() async throws {
        let store = try await makeStore()
        MockURLProtocol.install { _ in
            MockURLProtocol.Stub(status: 200, body: Data("<html>Sign in to WiFi</html>".utf8))
        }

        let client = ApiClient(
            credentials: store,
            baseURL: Fixture.baseURL,
            session: MockURLProtocol.makeSession()
        )

        do {
            _ = try await client.ingest(Fixture.batch())
            XCTFail("a login page is not an acknowledgement")
        } catch let error as ApiError {
            // Transient, not permanent: the truck will leave the hotel car park.
            XCTAssertEqual(error.failure, .transient)
        }
    }

    func testClaimStoresTheCredentialsItselfSoNoCallerCanForget() async throws {
        let store = CredentialStore(secrets: InMemorySecretStore(), defaults: Fixture.defaults())
        MockURLProtocol.install { _ in
            MockURLProtocol.Stub(status: 200, body: Data(Fixture.claimJSON.utf8))
        }

        let client = ApiClient(
            credentials: store,
            baseURL: Fixture.baseURL,
            session: MockURLProtocol.makeSession()
        )
        let deviceId = await store.deviceId()
        let claim = try await client.claim(
            code: "k7h2-9qx4",
            device: DeviceInfoDto(deviceId: deviceId)
        )

        XCTAssertEqual(claim.reference, "KH-2026-000042")
        let loaded = await store.credentials()
        let credentials = try XCTUnwrap(loaded)
        XCTAssertEqual(credentials.ingestKey, Fixture.ingestKey)

        // And the code went up normalised — it is single-use, so a stray dash
        // costs the driver a phone call to the dispatcher.
        let sent = try XCTUnwrap(MockURLProtocol.requests().first)
        XCTAssertEqual(sent.url?.absoluteString, "https://example.test/api/v1/driver/claim")
        XCTAssertNil(sent.value(forHTTPHeaderField: "Authorization"))
    }
}
