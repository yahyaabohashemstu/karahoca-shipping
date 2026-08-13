import Foundation
import Security

/// ============================================================================
///  WHERE THE SESSION SECRETS LIVE
/// ============================================================================
///
/// The counterpart of Android's `SessionStore` + `Keystore`, minus everything
/// that is not a secret — the tracking flag, the buffer counters and the
/// shipment labels belong to the persistence layer, not here.
///
/// THE KEYCHAIN, NOT UserDefaults. The ingest key is an HMAC secret: anyone
/// holding it can forge location points for a live shipment, which is the one
/// thing this whole system exists to make impossible. `UserDefaults` is a plist
/// in the app container — it lands in an unencrypted iTunes backup and in any
/// forensic dump of the device. That is not a threat model for a company phone;
/// it is one for a *third-party carrier's driver's personal phone*, which is
/// what this app actually runs on.
///
/// `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, and both halves matter:
///
///   AfterFirstUnlock — the phone spends fourteen hours locked in a windscreen
///   cradle and the app has to keep signing uploads the entire time.
///   `WhenUnlocked` would make every background upload fail the moment the
///   screen locked, which is to say always.
///
///   ThisDeviceOnly — the secret is excluded from backups and never migrates in
///   a device restore. A driver restoring last month's backup onto a new phone
///   must NOT resurrect a shipment's signing key; the session is bound to a
///   device id server-side and a second phone presenting the same key is
///   exactly the clone the guard's DEVICE_MISMATCH check exists to catch.
enum CredentialStoreError: Error, Equatable {
    case keychain(OSStatus)
    /// The server sent an `ingestKey` that is not base64. Nothing signed with
    /// it would ever verify, so this fails the claim loudly instead of starting
    /// a session that 401s on its first upload.
    case malformedIngestKey
}

/// The keychain, behind a seam.
///
/// This protocol exists for exactly one reason: a unit-test bundle with no host
/// application gets `errSecMissingEntitlement` (-34018) from `SecItemAdd` on a
/// real device. A test that can only pass in the simulator is a test that gets
/// deleted the first time CI runs on hardware, so the tests substitute an
/// in-memory store and the keychain path is exercised by the app itself.
protocol SecretStore: Sendable {
    func load(_ account: String) throws -> Data?
    func save(_ data: Data, account: String) throws
    func remove(_ account: String) throws
}

struct KeychainSecretStore: SecretStore {
    /// Namespaced so a future app extension sharing the container cannot
    /// collide with these accounts.
    let service: String

    init(service: String = "com.karahoca.tracker.session") {
        self.service = service
    }

    private func query(_ account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    func load(_ account: String) throws -> Data? {
        var request = query(account)
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &item)
        switch status {
        case errSecSuccess:      return item as? Data
        case errSecItemNotFound: return nil
        default:                 throw CredentialStoreError.keychain(status)
        }
    }

    /// Update-then-add, never delete-then-add.
    ///
    /// The obvious `SecItemDelete` + `SecItemAdd` leaves a window in which the
    /// item does not exist. A crash, a jetsam kill, or the OS suspending the
    /// app in that window loses the session's credentials outright, and the
    /// driver's only recovery is a new claim code — a phone call to the
    /// dispatcher from wherever the lorry happens to be.
    func save(_ data: Data, account: String) throws {
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]

        let updated = SecItemUpdate(query(account) as CFDictionary, attributes as CFDictionary)
        if updated == errSecSuccess { return }
        guard updated == errSecItemNotFound else {
            throw CredentialStoreError.keychain(updated)
        }

        var insert = query(account)
        insert.merge(attributes) { _, new in new }
        let added = SecItemAdd(insert as CFDictionary, nil)
        guard added == errSecSuccess else {
            throw CredentialStoreError.keychain(added)
        }
    }

    func remove(_ account: String) throws {
        let status = SecItemDelete(query(account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw CredentialStoreError.keychain(status)
        }
    }
}

// =============================================================================

/// Everything the network layer needs to authenticate, and nothing else.
///
/// An actor rather than a lock: the signer reads this on every request, the
/// refresh path writes it, and both can be in flight at once from a location
/// wake-up and a user tap. The whole credential set is stored as **one**
/// keychain item rather than six — six `SecItem` round trips per request would
/// be wasteful, but the real reason is atomicity: there is no such thing as
/// half a credential set, and a partial write is a session that has an access
/// token but no key to sign with.
actor CredentialStore {

    struct Credentials: Codable, Equatable {
        let sessionId: String
        let reference: String
        var accessToken: String
        /// Never rotated mid-shift, by server design: a lost refresh response
        /// would otherwise force a re-claim, and a driver in a dead zone cannot
        /// get a new code. It dies with the session.
        let refreshToken: String
        /// Raw HMAC key, already base64-decoded. Held as `Data` so no call site
        /// can accidentally sign with the base64 *text*.
        let ingestKey: Data
        /// Computed from the local clock at save time. See `needsRefresh`.
        var expiresAt: Date
    }

    /// One hop for the hot path, instead of three awaits per signed request.
    struct SigningMaterial {
        let bearer: String
        let ingestKey: Data
        let deviceId: String
    }

    private enum Account {
        static let credentials = "credentials"
        static let deviceId = "device-id"
    }

    private enum DefaultsKey {
        static let clockOffset = "kh.clockOffsetSeconds"
    }

    /// Refresh this far ahead of expiry rather than waiting for a 401. A truck
    /// that is about to enter a dead zone should carry a fresh token into it.
    private static let refreshLeadTime: TimeInterval = 120

    private let secrets: SecretStore
    private let defaults: UserDefaults

    private var cached: Credentials?
    private var loaded = false
    private var cachedDeviceId: String?
    private var clockOffset: TimeInterval

    init(secrets: SecretStore = KeychainSecretStore(), defaults: UserDefaults = .standard) {
        self.secrets = secrets
        self.defaults = defaults
        self.clockOffset = defaults.double(forKey: DefaultsKey.clockOffset)
    }

    // MARK: - Identity

    /// Stable per-install id, generated once.
    ///
    /// Never derived from `identifierForVendor` or any hardware identifier —
    /// those change on reinstall and are shared across an vendor's apps, and
    /// deriving one would make this app look like a tracker of *people* rather
    /// than of trucks, which is a conversation with App Review nobody wants.
    ///
    /// It lives in the keychain even though it is not a secret, because
    /// keychain items survive app deletion. If a driver reinstalls the app
    /// mid-delivery — which happens, usually as a fix for something else — a
    /// regenerated id would present as a different phone and the guard would
    /// answer DEVICE_MISMATCH on the very next upload.
    func deviceId() -> String {
        if let cachedDeviceId { return cachedDeviceId }

        if let stored = try? secrets.load(Account.deviceId),
           let text = String(data: stored, encoding: .utf8),
           !text.isEmpty {
            cachedDeviceId = text
            return text
        }

        let generated = UUID().uuidString
        cachedDeviceId = generated
        // A keychain failure here is not fatal for this launch: the id is
        // consistent in memory for as long as the process lives, which covers
        // the claim and everything that follows it.
        try? secrets.save(Data(generated.utf8), account: Account.deviceId)
        return generated
    }

    // MARK: - Credentials

    func credentials() -> Credentials? {
        if !loaded {
            loaded = true
            if let blob = try? secrets.load(Account.credentials) {
                cached = try? JSONDecoder().decode(Credentials.self, from: blob)
            }
        }
        return cached
    }

    func signingMaterial() -> SigningMaterial? {
        guard let credentials = credentials() else { return nil }
        return SigningMaterial(
            bearer: credentials.accessToken,
            ingestKey: credentials.ingestKey,
            deviceId: deviceId()
        )
    }

    /// True when the access token expires within the lead time, or when there
    /// is no expiry recorded at all.
    ///
    /// The expiry is derived from the *local* clock at save time, so a phone
    /// whose clock jumps mid-shift will get this wrong. That is tolerable
    /// precisely because it is not the only defence: a 401 with TOKEN_EXPIRED
    /// triggers a refresh and one retry, so the worst case is a single wasted
    /// request rather than a dead session. Using the corrected clock here
    /// instead would be worse — the correction is itself only as good as the
    /// last response, and a session that has been offline for six hours has
    /// none.
    var needsRefresh: Bool {
        guard let credentials = credentials() else { return false }
        return credentials.expiresAt.timeIntervalSinceNow < CredentialStore.refreshLeadTime
    }

    var hasSession: Bool { credentials() != nil }

    /// Persist a fresh claim.
    ///
    /// Note the ordering: the in-memory copy is set **before** the keychain
    /// write and is not rolled back if that write fails. The throw exists so
    /// the caller can report the failure, not so it can undo it — a driver
    /// halfway out of the yard is better served by a session with volatile
    /// credentials, which works until the app is killed, than by no session
    /// at all.
    func save(claim: ClaimResponse) throws {
        guard let key = Data(base64Encoded: claim.ingestKey), !key.isEmpty else {
            throw CredentialStoreError.malformedIngestKey
        }

        cached = Credentials(
            sessionId: claim.sessionId,
            reference: claim.reference,
            accessToken: claim.accessToken,
            refreshToken: claim.refreshToken,
            ingestKey: key,
            expiresAt: Date().addingTimeInterval(TimeInterval(claim.expiresIn))
        )
        loaded = true
        recordServerTime(claim.serverTime)
        try persist()
    }

    /// Apply a refreshed access token.
    ///
    /// The refresh token and the ingest key are deliberately untouched: the
    /// server does not rotate them (see `sessions.service.ts::refreshDriverToken`)
    /// and overwriting them with absent values would end the session.
    func apply(refresh: RefreshResponse) throws {
        guard var credentials = credentials() else {
            throw CredentialStoreError.keychain(errSecItemNotFound)
        }
        credentials.accessToken = refresh.accessToken
        credentials.expiresAt = Date().addingTimeInterval(TimeInterval(refresh.expiresIn))
        cached = credentials
        loaded = true
        recordServerTime(refresh.serverTime)
        try persist()
    }

    /// Wipe the session.
    ///
    /// Keeps the device id, so re-claiming on the same phone is recognised, and
    /// touches nothing in the point buffer — unsynced fixes from the session
    /// that just ended still have to reach the server.
    func clear() {
        cached = nil
        loaded = true
        try? secrets.remove(Account.credentials)
    }

    private func persist() throws {
        guard let cached else {
            try secrets.remove(Account.credentials)
            return
        }
        try secrets.save(JSONEncoder().encode(cached), account: Account.credentials)
    }

    // MARK: - Clock discipline (ADR-011)

    /// Fold the server's time into our offset.
    ///
    /// The HMAC timestamp is wall-clock and the server rejects anything more
    /// than `HMAC_SKEW_SEC` away from its own. Cheap phones drift, and drivers
    /// set the clock by hand. Every response — including every *error*
    /// response — carries `serverTime` for this reason, so a phone two hours
    /// out corrects itself from the very rejection its bad clock caused.
    func recordServerTime(_ epochSeconds: Int) {
        guard epochSeconds > 0 else { return }
        clockOffset = TimeInterval(epochSeconds) - Date().timeIntervalSince1970
        defaults.set(clockOffset, forKey: DefaultsKey.clockOffset)
    }

    func correctedNow() -> Date {
        Date().addingTimeInterval(clockOffset)
    }

    /// Seconds the local clock is behind the server's. Diagnostics only.
    var clockOffsetSeconds: TimeInterval { clockOffset }
}
