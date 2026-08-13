import Foundation

/// When the next upload attempt is allowed.
///
/// A port of `sync/UploadBackoff.kt`, arithmetic for arithmetic, including its
/// tests. Seconds rather than milliseconds because every other time value on
/// this side of the app is a `TimeInterval` — `CadenceGate` already takes
/// seconds, and two units in one codebase is how a 15-second backoff becomes a
/// four-hour one.
///
/// THE PROBLEM IT SOLVES. Android's realtime pump fired every 15 seconds and
/// attempted an upload on every tick regardless of how the previous one had
/// failed. A server returning 429 or 503 therefore received 240 requests an
/// hour from every truck in the fleet, each one dragging the modem out of idle
/// and back through the tail timer for nothing — worst precisely when the
/// server is already struggling.
///
/// iOS makes this *more* important, not less. Here the app is only awake when
/// CoreLocation hands it a fix, and the CPU time that comes with that wake-up
/// is the only budget there is. Spending it on a request the server has already
/// refused means the wake-up produced nothing at all, and there is no
/// foreground service to make up for it later.
///
/// A struct with mutating methods, matching `CadenceGate`. Not thread-safe by
/// construction; the caller holds the upload lock.
struct UploadBackoff {

    /// One tick of the realtime pump. The first failure therefore costs nothing
    /// extra, so a single dropped packet does not delay a moving truck.
    private let base: TimeInterval

    /// Doubling reaches the cap after five consecutive failures, which is also
    /// the interval a genuinely unreachable server settles at — roughly one
    /// attempt per five minutes instead of twenty.
    private let cap: TimeInterval

    /// Monotonic uptime, never the wall clock. An NTP correction mid-shift — or
    /// a driver changing the time zone at a border — must not skip a backoff or
    /// extend it by hours. Android uses `SystemClock.elapsedRealtime`; here it
    /// is `ProcessInfo.systemUptime`, the same choice `CadenceGate` makes.
    ///
    /// Note that `systemUptime` excludes time the device spent asleep, which
    /// only ever makes the wait *shorter* in real terms. That is the safe
    /// direction: a truck that has been parked overnight should retry
    /// immediately, not sit out a backoff that expired hours ago.
    private let clock: () -> TimeInterval

    /// 0..<1. Injectable so tests are deterministic.
    private let random: () -> Double

    private var until: TimeInterval = 0
    private var failures: Int = 0

    init(
        base: TimeInterval = 15,
        cap: TimeInterval = 300,
        clock: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
        random: @escaping () -> Double = { Double.random(in: 0..<1) }
    ) {
        self.base = base
        self.cap = cap
        self.clock = clock
        self.random = random
    }

    /// Consecutive failures since the last success. Exposed for the log line.
    var failureCount: Int { failures }

    /// True when an attempt should be skipped without touching the radio.
    var shouldWait: Bool { clock() < until }

    /// Seconds remaining. Zero when clear to send.
    var remaining: TimeInterval { max(until - clock(), 0) }

    /// Record a failed attempt.
    ///
    /// - Parameter retryAfterSec: what the server asked for, if it said. It
    ///   wins over the local schedule in both directions: it is the only party
    ///   that knows when its own rate-limit window resets, guessing shorter
    ///   just burns the allowance again immediately, and guessing longer leaves
    ///   a truck invisible for no reason.
    mutating func onFailure(retryAfterSec: Int? = nil) {
        // Cap the shift count before shifting, not after.
        //
        // Swift's `<<` is a "smart shift": `1 << 64` returns 0 rather than
        // wrapping the way Kotlin's `shl` does. Different mechanism, identical
        // catastrophe — a zero base clears the backoff entirely after enough
        // failures, which is the exact opposite of what a long outage should
        // produce.
        failures = min(failures + 1, UploadBackoff.maxShifts)

        let interval: TimeInterval
        if let retryAfterSec, retryAfterSec > 0 {
            interval = TimeInterval(retryAfterSec)
        } else {
            interval = min(base * TimeInterval(1 << (failures - 1)), cap)
        }

        /*
         * Jitter is not decoration. Forty trucks that hit the same 429 in the
         * same second would otherwise retry in lockstep forever, reconstructing
         * the burst that caused the limit. Up to +20%, never negative — waiting
         * less than the server asked for is the one direction that must not
         * happen.
         */
        let jitter = interval * UploadBackoff.jitterFraction * random()
        until = clock() + interval + jitter
    }

    /// A successful upload clears everything.
    mutating func onSuccess() {
        failures = 0
        until = 0
    }

    /// 2^8 × 15 s already exceeds the 5-minute cap; beyond this the shift is
    /// pointless at best.
    private static let maxShifts = 8
    private static let jitterFraction = 0.2
}
