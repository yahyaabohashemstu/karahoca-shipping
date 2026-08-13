import CryptoKit
import Foundation
import Security

/// ============================================================================
///  PER-REQUEST HMAC (ADR-009)
/// ============================================================================
///
///     X-KH-Timestamp : clock-corrected epoch seconds
///     X-KH-Nonce     : 16 random bytes, lowercase hex
///     X-KH-Signature : HMAC-SHA256(ingestKey, "ts.nonce.sha256hex(body)")
///     X-KH-Device-Id : this install's stable id
///
/// The signature binds the **uncompressed body bytes**, so a captured bearer
/// token alone cannot be replayed with different coordinates, and the nonce and
/// timestamp mean the *same* body cannot be replayed either. Because it covers
/// the payload rather than the wire encoding, gzip is applied afterwards and
/// stays a pure transport concern — see `SignedRequest.build`, and
/// `common/crypto.util.ts::ingestSignature` for the server's half.
///
/// Everything here is pure and injectable. That is not fastidiousness: the one
/// way this can go wrong is by computing the digest over bytes other than the
/// ones that go on the wire, the failure mode is a 100% authentication failure
/// rate on every driver phone at once, and the only cheap defence is a test
/// that pins the canonical string byte for byte.
enum HmacSigner {

    // MARK: - Header names

    static let timestampHeader = "X-KH-Timestamp"
    static let nonceHeader = "X-KH-Nonce"
    static let signatureHeader = "X-KH-Signature"

    /// Not read by any server handler today — the device binding that matters
    /// is the `did` claim inside the JWT, which the guard checks against the
    /// session's registered device.
    ///
    /// It is sent anyway, and it is in the API's CORS allow-list for this
    /// reason: when a request fails *before* the token is parsed — a malformed
    /// bearer, a clock so wrong the timestamp check rejects it, a proxy
    /// mangling the body — the access log has no other way to say which phone
    /// it came from. That is exactly the situation where a dispatcher is asking
    /// which truck went dark.
    static let deviceIdHeader = "X-KH-Device-Id"

    // MARK: - Signing

    struct Headers: Equatable {
        let timestamp: String
        let nonce: String
        let signature: String
    }

    /// The exact string both sides hash. Kept as its own function purely so a
    /// test can assert on it; nothing else should build this by hand.
    static func canonicalString(timestamp: String, nonce: String, body: Data) -> String {
        "\(timestamp).\(nonce).\(hex(SHA256.hash(data: body)))"
    }

    static func signature(key: Data, timestamp: String, nonce: String, body: Data) -> String {
        let canonical = canonicalString(timestamp: timestamp, nonce: nonce, body: body)
        let mac = HMAC<SHA256>.authenticationCode(
            for: Data(canonical.utf8),
            using: SymmetricKey(data: key)
        )
        return hex(mac)
    }

    /// - Parameter body: the bytes the request will carry **before** any
    ///   content encoding is applied. Passing the compressed bytes here yields
    ///   `BAD_SIGNATURE` on every gzipped upload and nothing else.
    /// - Parameter now: clock-*corrected* time, not `Date()`. Cheap phones drift
    ///   and drivers set them wrong; the server rejects anything more than
    ///   `HMAC_SKEW_SEC` off. `CredentialStore.correctedNow()` is the source.
    static func sign(
        body: Data,
        key: Data,
        now: Date,
        nonce: String = randomNonce()
    ) -> Headers {
        // Truncating rather than rounding: the server parses this with
        // parseInt, and a value like "1786531200.7" is not a finite integer to
        // it — that is a BAD_TIMESTAMP, not a skew error, and it would never
        // self-correct.
        let timestamp = String(Int(now.timeIntervalSince1970))
        return Headers(
            timestamp: timestamp,
            nonce: nonce,
            signature: signature(key: key, timestamp: timestamp, nonce: nonce, body: body)
        )
    }

    // MARK: - Nonce

    /// 16 random bytes as 32 hex characters — inside the server's 8…64 bound.
    ///
    /// The nonce needs *uniqueness*, not secrecy: its whole job is to be
    /// rejected the second time the server sees it within the replay window.
    /// So when `SecRandomCopyBytes` fails — it can, and returning a fixed
    /// string would make every request after that a REPLAY_DETECTED — the
    /// fallback is a UUID, which on Apple platforms is drawn from the same
    /// CSPRNG and carries 122 bits of entropy.
    static func randomNonce(byteCount: Int = 16) -> String {
        var bytes = [UInt8](repeating: 0, count: byteCount)
        if SecRandomCopyBytes(kSecRandomDefault, byteCount, &bytes) == errSecSuccess {
            return hex(bytes)
        }
        return hex(withUnsafeBytes(of: UUID().uuid) { Array($0) })
    }

    // MARK: - Hex

    private static let hexDigits: [UInt8] = Array("0123456789abcdef".utf8)

    /// Lowercase, matching `Buffer.toString('hex')` on the server and
    /// `ByteArray.toHex()` on Android.
    ///
    /// Hand-rolled rather than `String(format: "%02x")` for the same reason it
    /// is on Android: `%02x` goes through the locale-aware formatter, and this
    /// fleet's phones are all set to Turkish. The digits happen to be safe
    /// today, but a signature is not a place to depend on that.
    static func hex<S: Sequence>(_ bytes: S) -> String where S.Element == UInt8 {
        var out = [UInt8]()
        out.reserveCapacity(64)
        for byte in bytes {
            out.append(hexDigits[Int(byte >> 4)])
            out.append(hexDigits[Int(byte & 0x0F)])
        }
        return String(decoding: out, as: UTF8.self)
    }
}
