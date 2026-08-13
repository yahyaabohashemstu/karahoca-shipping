import Foundation
import CoreLocation
import os

/// ============================================================================
///  PERSISTENT SESSION STATE
/// ============================================================================
///
/// Everything the app needs in order to know, on a cold launch with no UI and
/// no memory of five minutes ago, that a delivery is in progress and what its
/// cadence should be.
///
/// That cold launch is not hypothetical on iOS. It is the normal case: the
/// system terminates a backgrounded app and then relaunches it straight into
/// the background when a significant-location-change or a monitored region
/// fires. The relaunched process gets a `CLLocationManager` delegate callback
/// and nothing else — no view model, no navigation state, no idea whether the
/// driver is halfway to Mardin or finished yesterday. This table is the only
/// thing that answers.
///
/// ## What lives here, and what does not
///
/// Here: session identity, the shipment summary shown to the driver, the
/// cadence policy, the tracking intent, the device sequence number, and the
/// clock offset.
///
/// **Not here: secrets.** The access token, the refresh token and the HMAC
/// ingest key belong in the Keychain, which is a different mechanism with
/// different guarantees — hardware-backed, and with its own accessibility class
/// that must be set to survive the phone being locked in a cradle. A SQLite row
/// in the app container is the wrong home for a bearer token, and half-securing
/// it here would be worse than not pretending. On Android the equivalent values
/// live in the same DataStore but sealed with a Keystore key; on iOS the
/// Keychain *is* that store, so they move out of this type entirely.
final class SessionStore: @unchecked Sendable {

    /// Posted on the main queue after any mutation, so a SwiftUI view model can
    /// refresh without polling. Deliberately a bare notification rather than a
    /// published property: this type is not main-actor-isolated (the location
    /// engine writes to it from a CoreLocation callback) and pretending
    /// otherwise would put an `await` on the hot path.
    static let didChangeNotification = Notification.Name("com.karahoca.tracker.sessionStoreDidChange")

    private static let log = Logger(subsystem: "com.karahoca.tracker", category: "session")

    private let database: SQLiteDatabase

    /// The snapshot the UI reads, kept in memory.
    ///
    /// SwiftUI evaluates a body far more often than anything changes, and the
    /// status screen reads six of these values. Caching turns each of those
    /// reads into a struct copy instead of a query, which is what makes it
    /// defensible for the main thread to block on this type at all.
    /// Mutated only inside `database.sync`, which is what makes it safe.
    private var cache: Snapshot

    init(database: SQLiteDatabase) {
        self.database = database
        self.cache = database.sync { SessionStore.load(from: database) }
    }

    // -------------------------------------------------------------------------
    // Snapshot
    // -------------------------------------------------------------------------

    struct Shipment: Equatable, Sendable {
        var orderNumber: String?
        var customerName: String?
        var destination: String?
        var cargoSummary: String?

        static let empty = Shipment()

        var isEmpty: Bool {
            orderNumber == nil && customerName == nil && destination == nil && cargoSummary == nil
        }
    }

    struct Snapshot: Equatable, Sendable {
        var deviceId: String
        var sessionId: String?
        var reference: String?
        var shipment: Shipment
        var policy: TrackingPolicy

        /// The driver's decision. See `setTrackingIntent`.
        var trackingIntent: Bool
        /// What the location engine last reported about itself. Diagnostic only.
        var engineRunning: Bool

        var startedAt: Date?
        var lastFixAt: Date?
        var lastSyncAt: Date?

        /// Cumulative points dropped by the buffer cap, for the whole install.
        var evictedTotal: Int
        var evictedLastAt: Date?

        static let empty = Snapshot(
            deviceId: "", sessionId: nil, reference: nil,
            shipment: .empty, policy: .default,
            trackingIntent: false, engineRunning: false,
            startedAt: nil, lastFixAt: nil, lastSyncAt: nil,
            evictedTotal: 0, evictedLastAt: nil
        )

        /// The one question a cold background launch asks.
        ///
        /// Both halves matter: an intent with no session is a driver who pressed
        /// start before the claim completed, and a session with no intent is a
        /// delivery that was claimed and then stopped.
        var shouldBeTracking: Bool { trackingIntent && sessionId != nil }
    }

    func snapshot() -> Snapshot { database.sync { cache } }

    // -------------------------------------------------------------------------
    // Identity
    // -------------------------------------------------------------------------

    /// Stable per-install id, generated once.
    ///
    /// Not `identifierForVendor`, not the advertising id, not anything derived
    /// from hardware — for the same reason Android refuses `ANDROID_ID`. This
    /// app tracks lorries, and an identifier that follows the *person* carrying
    /// the phone between installs is both a privacy liability and a thing the
    /// platform will eventually take away. A UUID in our own store dies with the
    /// app, which is the correct lifetime.
    var deviceId: String {
        database.sync {
            if !cache.deviceId.isEmpty { return cache.deviceId }
            let generated = UUID().uuidString
            write { $0[Key.deviceId] = generated }
            return generated
        }
    }

    // -------------------------------------------------------------------------
    // Session lifecycle
    // -------------------------------------------------------------------------

    /// Record a freshly claimed session. Does **not** start tracking — claiming
    /// a code and pressing start are two separate decisions, and conflating them
    /// would begin streaming location the instant a driver scanned a QR out of
    /// curiosity.
    func saveSession(
        sessionId: String,
        reference: String,
        policy: TrackingPolicy,
        shipment: Shipment
    ) {
        write {
            $0[Key.sessionId] = sessionId
            $0[Key.reference] = reference
            $0[Key.pingIntervalSec] = String(policy.pingIntervalSec)
            $0[Key.idleIntervalSec] = String(policy.idleIntervalSec)
            $0[Key.minDistanceM] = String(policy.minDistanceM)
            $0[Key.orderNumber] = shipment.orderNumber
            $0[Key.customerName] = shipment.customerName
            $0[Key.destination] = shipment.destination
            $0[Key.cargoSummary] = shipment.cargoSummary
        }
    }

    var sessionId: String? { database.sync { cache.sessionId } }
    var reference: String? { database.sync { cache.reference } }
    var policy: TrackingPolicy { database.sync { cache.policy } }

    /// The server owns the cadence and re-states it on every ingest response.
    func savePolicy(_ policy: TrackingPolicy) {
        write {
            $0[Key.pingIntervalSec] = String(policy.pingIntervalSec)
            $0[Key.idleIntervalSec] = String(policy.idleIntervalSec)
            $0[Key.minDistanceM] = String(policy.minDistanceM)
        }
    }

    func saveShipment(_ shipment: Shipment) {
        write {
            $0[Key.orderNumber] = shipment.orderNumber
            $0[Key.customerName] = shipment.customerName
            $0[Key.destination] = shipment.destination
            $0[Key.cargoSummary] = shipment.cargoSummary
        }
    }

    /// End of session: forget who we were, keep everything that must outlive it.
    ///
    /// Kept on purpose: the device id (so re-claiming on the same phone is
    /// recognised), the device sequence number (reusing numbers would corrupt
    /// the dispatcher's gap detection), the clock offset, and the eviction
    /// tally. Untouched on purpose: the point buffer. Points from the session
    /// that just ended carry their own `session_id` and still have to be
    /// uploaded — the driver pressing "finish" is not permission to delete a
    /// route the server has never seen.
    ///
    /// Not `@MainActor`, unlike `setTrackingIntent`, because the sync layer must
    /// be able to call it from a background upload when the server answers that
    /// the session is closed. Clearing the intent is inherent to tearing the
    /// session down, and the invariant the isolation protects — that the
    /// *location engine* can never assert an intent the driver did not express —
    /// is untouched by clearing it.
    func clearSession() {
        write {
            $0[Key.sessionId] = nil
            $0[Key.reference] = nil
            $0[Key.orderNumber] = nil
            $0[Key.customerName] = nil
            $0[Key.destination] = nil
            $0[Key.cargoSummary] = nil
            $0[Key.startedAt] = nil
            $0[Key.trackingIntent] = "0"
            $0[Key.engineRunning] = "0"
        }
    }

    // -------------------------------------------------------------------------
    // Tracking intent vs. engine state
    // -------------------------------------------------------------------------

    /// **The driver's decision, and only the driver's.**
    ///
    /// Android learned this one expensively. There, a single `tracking_active`
    /// flag was written by the foreground service — the service set it true when
    /// it started and false when it stopped cleanly. When an OEM battery manager
    /// killed the service instead, the flag was left true, and the watchdog
    /// faithfully resurrected a session the driver had already ended: a phone
    /// streaming a stranger's evening commute to a dispatcher, hours after the
    /// lorry was unloaded.
    ///
    /// The fix is not a more careful service. It is to make the mistake
    /// unrepresentable by splitting the flag in two. This one records *what the
    /// driver asked for* and is written only from the UI layer; `engineRunning`
    /// records what the location stack is actually doing and is written only by
    /// the engine. Resumption keys off intent (`Snapshot.shouldBeTracking`), so a
    /// process death can never manufacture consent.
    ///
    /// `@MainActor` is the enforcement, not the documentation. The engine's
    /// writes arrive on a CoreLocation callback; reaching this method from there
    /// requires an explicit hop that a reviewer will see.
    @MainActor
    func setTrackingIntent(_ active: Bool) {
        write {
            $0[Key.trackingIntent] = active ? "1" : "0"
            if active {
                if $0[Key.startedAt] == nil {
                    $0[Key.startedAt] = String(Self.millis(Date()))
                }
            } else {
                $0[Key.startedAt] = nil
            }
        }
    }

    var trackingIntent: Bool { database.sync { cache.trackingIntent } }

    /// Observation, not authority. Written by the location engine so the UI can
    /// show "the driver asked for tracking but iOS is not delivering updates" —
    /// which on this platform is a real and common state, and the single most
    /// useful thing a support call can be told.
    func setEngineRunning(_ running: Bool) {
        write { $0[Key.engineRunning] = running ? "1" : "0" }
    }

    // -------------------------------------------------------------------------
    // Activity timestamps
    // -------------------------------------------------------------------------

    func markFix(at date: Date) { write { $0[Key.lastFixAt] = String(Self.millis(date)) } }
    func markSynced(at date: Date = Date()) { write { $0[Key.lastSyncAt] = String(Self.millis(date)) } }

    // -------------------------------------------------------------------------
    // Clock discipline
    // -------------------------------------------------------------------------

    /// `serverTime` minus our wall clock, at the last successful call.
    ///
    /// The ingest HMAC is signed over a timestamp and the server rejects a
    /// signature more than a few minutes out. Cheap phones drift, and drivers
    /// set the clock by hand; a phone two hours off would fail every upload with
    /// CLOCK_SKEW and buffer until it hit the cap. Storing the delta and signing
    /// with the corrected value keeps a wrong clock from becoming a lost shift.
    ///
    /// It is deliberately *not* used for `recorded_at` — that comes from the GPS
    /// fix, which carries satellite time and is immune to the phone's clock
    /// entirely.
    func recordServerTime(_ serverTimeSec: Int64) {
        let offset = serverTimeSec * 1000 - Self.millis(Date())
        write { $0[Key.clockOffsetMs] = String(offset) }
    }

    var clockOffsetMs: Int64 {
        database.sync { Int64(read(Key.clockOffsetMs) ?? "") ?? 0 }
    }

    func correctedNow() -> Date {
        Date(timeIntervalSince1970: Double(Self.millis(Date()) + clockOffsetMs) / 1000)
    }

    // -------------------------------------------------------------------------
    // Device sequence — used by PointBuffer, inside its insert transaction
    // -------------------------------------------------------------------------

    /// Last sequence number handed out.
    ///
    /// Read at open, then advanced one statement at a time inside the same
    /// transaction as the point it belongs to. Android reserves a window of a
    /// hundred and persists the ceiling, because each of its writes costs an
    /// fsync of the whole preferences file; that trade buys cheapness at the
    /// price of skipping numbers after a kill. Sharing a transaction with the
    /// insert costs nothing and skips nothing.
    var deviceSeq: Int64 {
        database.sync { Int64(read(Key.deviceSeq) ?? "") ?? 0 }
    }

    /// Must be called inside the caller's transaction. See `PointBuffer.append`.
    ///
    /// Bypasses `write` on purpose. This runs once per fix, and `write`
    /// re-reads the whole state table to refresh the UI cache — pointless here,
    /// since the sequence number is not part of the snapshot. It also means the
    /// cache cannot end up holding a value from a transaction the caller later
    /// rolls back.
    func setDeviceSeq(_ value: Int64) throws {
        try database.run(
            "INSERT INTO session_state (key, value) VALUES (?, ?) "
                + "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [.text(Key.deviceSeq), .text(String(value))]
        )
    }

    // -------------------------------------------------------------------------
    // Buffer overflow bookkeeping
    // -------------------------------------------------------------------------

    /// A buffer that quietly drops the beginning of a route is worse than one
    /// that admits it, so the fact is persisted rather than only logged. The
    /// running total survives the session that caused it, because the question
    /// it answers — "why does this shipment's trace start outside Gaziantep?" —
    /// is asked days later.
    ///
    /// Called by `PointBuffer` *after* its insert transaction has committed, so
    /// the tally can never count an eviction that was rolled back.
    @discardableResult
    func recordEviction(count: Int, at date: Date) -> Int {
        database.sync {
            let total = cache.evictedTotal + count
            write(notify: false) {
                $0[Key.evictedTotal] = String(total)
                $0[Key.evictedLastAt] = String(Self.millis(date))
                if $0[Key.evictedFirstAt] == nil {
                    $0[Key.evictedFirstAt] = String(Self.millis(date))
                }
            }
            return total
        }
    }

    // -------------------------------------------------------------------------
    // Storage plumbing
    // -------------------------------------------------------------------------

    private enum Key {
        static let deviceId = "device_id"
        static let sessionId = "session_id"
        static let reference = "reference"
        static let orderNumber = "order_number"
        static let customerName = "customer_name"
        static let destination = "destination_label"
        static let cargoSummary = "cargo_summary"
        static let trackingIntent = "tracking_intent"
        static let engineRunning = "engine_running"
        static let pingIntervalSec = "ping_interval_sec"
        static let idleIntervalSec = "idle_interval_sec"
        static let minDistanceM = "min_distance_m"
        static let startedAt = "started_at"
        static let lastFixAt = "last_fix_at"
        static let lastSyncAt = "last_sync_at"
        static let clockOffsetMs = "clock_offset_ms"
        static let deviceSeq = "device_seq"
        static let evictedTotal = "buffer_evicted_total"
        static let evictedFirstAt = "buffer_evicted_first_at"
        static let evictedLastAt = "buffer_evicted_last_at"
    }

    /// A tiny write-through accessor handed to every mutator.
    ///
    /// Setting a key to `nil` deletes the row, so "no order number" and "an
    /// order number that is the empty string" stay distinguishable — the
    /// dashboard renders those differently.
    struct Writer {
        fileprivate var changes: [String: String?] = [:]
        fileprivate let existing: (String) -> String?

        subscript(key: String) -> String? {
            get { changes[key] ?? existing(key) }
            set { changes[key] = newValue }
        }
    }

    /// Apply a mutation, refresh the cache, and tell the UI.
    ///
    /// Everything runs inside one `database.sync`, so a reader can never observe
    /// the row written and the cache not yet updated. `notify: false` is for the
    /// two writers that fire on the per-fix hot path — the sequence number and
    /// the eviction tally — which would otherwise post a notification every ten
    /// seconds to redraw a screen nobody is looking at.
    private func write(notify: Bool = true, _ body: (inout Writer) -> Void) {
        database.sync {
            var writer = Writer(existing: { key in self.read(key) })
            body(&writer)
            guard !writer.changes.isEmpty else { return }

            do {
                try database.transaction { () -> Void in
                    for (key, value) in writer.changes {
                        if let value {
                            try database.run(
                                "INSERT INTO session_state (key, value) VALUES (?, ?) "
                                    + "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                                [.text(key), .text(value)]
                            )
                        } else {
                            try database.run("DELETE FROM session_state WHERE key = ?", [.text(key)])
                        }
                    }
                }
            } catch {
                /*
                 * Never throw out of a session write.
                 *
                 * These are called from the location callback and from SwiftUI
                 * actions. A disk-full phone must degrade to "the app forgets
                 * the shipment name" and keep tracking, not to a crash dialog
                 * halfway to the Habur border crossing.
                 */
                Self.log.error("session_state write failed: \(String(describing: error), privacy: .public)")
                return
            }

            cache = Self.load(from: database)
            if notify {
                let name = Self.didChangeNotification
                DispatchQueue.main.async { NotificationCenter.default.post(name: name, object: nil) }
            }
        }
    }

    private func read(_ key: String) -> String? {
        (try? database.first("SELECT value FROM session_state WHERE key = ?", [.text(key)]) {
            $0.textOrNil(0)
        }) ?? nil
    }

    private static func load(from database: SQLiteDatabase) -> Snapshot {
        var values: [String: String] = [:]
        do {
            // Bound to a local first: a trailing closure inside a `for … in`
            // expression is a parser ambiguity, not a style preference.
            let rows = try database.query("SELECT key, value FROM session_state") {
                ($0.text(0), $0.text(1))
            }
            for (key, value) in rows { values[key] = value }
        } catch {
            // An unreadable state table means we cannot prove tracking was
            // wanted. Defaulting to "not tracking" is the safe direction: the
            // driver can press start again, whereas a phantom session streams
            // location nobody asked for.
            log.error("session_state read failed: \(String(describing: error), privacy: .public)")
            return .empty
        }

        func date(_ key: String) -> Date? {
            guard let raw = values[key], let millis = Int64(raw) else { return nil }
            return Date(timeIntervalSince1970: Double(millis) / 1000)
        }

        return Snapshot(
            deviceId: values[Key.deviceId] ?? "",
            sessionId: values[Key.sessionId],
            reference: values[Key.reference],
            shipment: Shipment(
                orderNumber: values[Key.orderNumber],
                customerName: values[Key.customerName],
                destination: values[Key.destination],
                cargoSummary: values[Key.cargoSummary]
            ),
            // Rebuilt through TrackingPolicy's initialiser, so a value that was
            // somehow stored out of range is re-clamped on the way out and the
            // phone can never hold a policy the server would have refused.
            policy: TrackingPolicy(
                pingIntervalSec: Double(values[Key.pingIntervalSec] ?? "") ?? TrackingPolicy.default.pingIntervalSec,
                idleIntervalSec: Double(values[Key.idleIntervalSec] ?? "") ?? TrackingPolicy.default.idleIntervalSec,
                minDistanceM: Double(values[Key.minDistanceM] ?? "") ?? TrackingPolicy.default.minDistanceM
            ),
            trackingIntent: values[Key.trackingIntent] == "1",
            engineRunning: values[Key.engineRunning] == "1",
            startedAt: date(Key.startedAt),
            lastFixAt: date(Key.lastFixAt),
            lastSyncAt: date(Key.lastSyncAt),
            evictedTotal: Int(values[Key.evictedTotal] ?? "") ?? 0,
            evictedLastAt: date(Key.evictedLastAt)
        )
    }

    private static func millis(_ date: Date) -> Int64 {
        Int64((date.timeIntervalSince1970 * 1000).rounded())
    }
}
