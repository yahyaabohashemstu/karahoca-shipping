import Foundation
import CoreLocation

/// When a fix is worth keeping.
///
/// The server hands every session a cadence policy — `pingIntervalSec`,
/// `idleIntervalSec`, `minDistanceM` — and both apps must interpret it
/// identically, or the same shipment produces a different trace depending on
/// which phone the driver happened to be carrying. This mirrors
/// `LocationTrackingService.shouldStore` on Android exactly.
///
/// Pure and clock-injected on purpose: this is the one piece of the location
/// stack that can be tested without a device, a simulator, or a GPS fix, and it
/// is also the piece where a mistake is invisible — too strict and the map goes
/// sparse, too loose and the phone dies at noon.
struct TrackingPolicy: Equatable {
    /// Sampling floor while moving.
    let pingIntervalSec: TimeInterval
    /// Heartbeat while stationary. Never tighter than `pingIntervalSec` — the
    /// database enforces that in `ck_session_intervals`, and a parked truck
    /// sampled more often than a driving one is backwards.
    let idleIntervalSec: TimeInterval
    /// 0 = time-triggered. Non-zero = store every N metres travelled, with
    /// `pingIntervalSec` as the floor and `idleIntervalSec` as the heartbeat.
    let minDistanceM: CLLocationDistance

    static let `default` = TrackingPolicy(
        pingIntervalSec: 10, idleIntervalSec: 60, minDistanceM: 0
    )

    /// Defensive, because this arrives over the wire.
    ///
    /// A malformed policy is not a crash and not a rejection: it is a session
    /// that silently records nothing, or one that flattens the battery in two
    /// hours. Clamped to the same bounds migration 0007 puts on the column, so
    /// the phone can never hold a policy the server would refuse to store.
    init(pingIntervalSec: TimeInterval, idleIntervalSec: TimeInterval, minDistanceM: CLLocationDistance) {
        let ping = min(max(pingIntervalSec, 2), 3600)
        self.pingIntervalSec = ping
        self.idleIntervalSec = min(max(idleIntervalSec, ping), 14400)
        self.minDistanceM = min(max(minDistanceM, 0), 20000)
    }
}

/// Decides whether an incoming fix is stored, given what was stored last.
struct CadenceGate {
    private var lastStored: CLLocation?
    private var lastStoredAt: TimeInterval?

    /// `now` is monotonic uptime, not wall-clock.
    ///
    /// A phone that corrects its clock over NTP mid-shift — or a driver who
    /// changes the time zone at a border — would otherwise appear to jump
    /// forwards or backwards, and a backwards jump stops the gate opening at
    /// all until real time catches up. On Android this is
    /// `SystemClock.elapsedRealtime`; here it is `ProcessInfo.systemUptime`.
    mutating func shouldStore(
        _ location: CLLocation,
        policy: TrackingPolicy,
        now: TimeInterval
    ) -> Bool {
        let store = storeDecision(location, policy: policy, now: now)
        if store {
            lastStored = location
            lastStoredAt = now
        }
        return store
    }

    private func storeDecision(
        _ location: CLLocation,
        policy: TrackingPolicy,
        now: TimeInterval
    ) -> Bool {
        // Nothing stored yet: the first fix is always the start of the route.
        guard let last = lastStored, let at = lastStoredAt else { return true }

        let elapsed = now - at

        if policy.minDistanceM <= 0 {
            // Time-triggered. iOS delivers fixes on its own schedule and often
            // faster than asked, so the gate is what enforces the cadence.
            return elapsed >= policy.pingIntervalSec
        }

        // Distance-triggered, with two escapes.
        if location.distance(from: last) >= policy.minDistanceM { return true }

        // The heartbeat. A parked truck must keep proving it is parked rather
        // than going silent — silence is indistinguishable from a dead phone,
        // and the dispatcher's silence detector will raise a CRITICAL alert for
        // a lorry that is simply waiting at a customs gate.
        return elapsed >= policy.idleIntervalSec
    }

    /// Forget the last fix, so the next one is stored unconditionally.
    /// Used when tracking resumes after a pause: the first fix on the far side
    /// of a four-hour overnight stop is a new start, not a continuation.
    mutating func reset() {
        lastStored = nil
        lastStoredAt = nil
    }
}

/// Fixes that must never enter the buffer.
///
/// The server's `kh.ingest_points` rejects these too, but rejecting them here
/// saves the upload — and on a 2G edge cell out of a dead zone, the bytes are
/// the scarce thing. Mirrors the accuracy and teleport filters in migration
/// 0004.
enum FixFilter {
    /// Worse than this and the fix says nothing useful about which road the
    /// lorry is on. Cell-tower fallbacks land in the kilometres.
    static let maxAccuracyM: CLLocationAccuracy = 200

    /// 250 km/h. No lorry does this; a fix that implies it is a GPS glitch or a
    /// jump between a cell estimate and a satellite lock, and drawing it puts a
    /// straight line across a country on the dispatcher's map.
    static let maxSpeedMps: CLLocationSpeed = 69.4

    static func isPlausible(_ location: CLLocation, after previous: CLLocation?) -> Bool {
        // A negative accuracy means the fix is invalid, per CoreLocation.
        guard location.horizontalAccuracy >= 0,
              location.horizontalAccuracy <= maxAccuracyM else { return false }

        guard let previous else { return true }

        let seconds = location.timestamp.timeIntervalSince(previous.timestamp)
        // Same timestamp or earlier: out of order, and dividing by it would be
        // a division by zero or a negative speed.
        guard seconds > 0 else { return false }

        return location.distance(from: previous) / seconds <= maxSpeedMps
    }
}
