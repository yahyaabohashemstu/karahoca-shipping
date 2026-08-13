import Foundation
import CoreLocation
import os

/// ============================================================================
///  THE OFFLINE BUFFER
/// ============================================================================
///
/// The invariant this file exists to protect, and it is the same sentence the
/// Android app carries:
///
///     A GPS fix is deleted from the device only after the server has
///     acknowledged, by batch id, that it holds it.
///
/// Nothing else deletes a point on the sync path. Not a timeout, not a 500, not
/// a dropped connection, not the app being killed mid-upload, not a lost
/// acknowledgement. The worst outcome the protocol permits is that a batch is
/// uploaded twice, and the server collapses duplicates for free on
/// `(session_id, client_point_id, recorded_at)`. Losing a point is not
/// recoverable; sending one twice costs a few hundred bytes on a 2G edge cell.
/// **When in doubt, keep.**
///
/// The route matters because of where these lorries go. A load leaving
/// Gaziantep for Erbil is out of coverage for hours at a stretch, and the trace
/// of that stretch only exists on the phone until it reaches the server. There
/// is no second copy.
///
/// ## The protocol
///
///     claimBatch(limit:)      PENDING → IN_FLIGHT, stamped with a batch id
///     ── upload ──
///     acknowledge(batchId:)   on a 2xx that names the batch — the only delete
///     release(batchId:)       on any failure: IN_FLIGHT → PENDING, attempts+1
///     recoverOrphanedClaims() at launch: reclaim rows a dead process was holding
///
/// Every state a crash can leave behind is re-claimable:
///
///  - killed before the claim commits → rows never left PENDING
///  - killed after the claim, before the POST → rows are IN_FLIGHT, reclaimed at
///    the next launch
///  - killed after the POST, before the acknowledgement → same, and the re-send
///    is deduplicated server-side
///  - killed between `acknowledge` and anything else → the delete already
///    committed, and it committed *because* the server said it had them
///
/// ## Concurrency
///
/// Every method here is synchronous and runs inside `SQLiteDatabase`'s serial
/// queue. Writes arrive on whatever queue CoreLocation delivers the fix on; the
/// UI reads counts on the main actor; the uploader claims batches on a
/// background queue. The queue serialises all three, and because the calls
/// block rather than suspend, a fix is committed to disk before the delegate
/// method returns — which is the only version of "never lose a coordinate" that
/// survives iOS suspending the app one instruction later. See the long note in
/// `SQLiteDatabase` for why this is a queue and not an actor.
///
/// Because of that queue, the mutable state in this class — the row counters and
/// the ULID generator — needs no lock of its own. It is only ever touched from
/// inside `database.sync`.
final class PointBuffer: @unchecked Sendable {

    /// Same cap as Android.
    ///
    /// At the app's tightest cadence (one fix every two seconds) that is eleven
    /// days of continuous recording, and roughly 60 MB on disk. It is not a
    /// figure the buffer is expected to reach; it is the figure at which we stop
    /// letting a broken upload path fill a driver's phone.
    static let defaultMaxRows = 500_000

    /// `sync_state` values. Mirrors `LocationPointEntity.Companion`.
    private enum SyncState {
        static let pending: Int64 = 0
        /// Claimed by an upload that has not been acknowledged.
        static let inFlight: Int64 = 1
    }

    private static let log = Logger(subsystem: "com.karahoca.tracker", category: "buffer")

    private let database: SQLiteDatabase
    private let session: SessionStore
    private let maxRows: Int

    /// Row counters, held in memory and kept exact.
    ///
    /// Android runs `SELECT COUNT(*)` on every insert to enforce the cap, and
    /// again on every notification refresh. On a rowid table a count is a full
    /// index scan — tens of milliseconds once the buffer is large, five thousand
    /// times a shift, for a number that changes by one.
    ///
    /// Here every mutation goes through this class, on one queue, in one
    /// process, so the counters can simply be maintained: each is adjusted by
    /// the row count SQLite reports for the statement that changed it. They are
    /// seeded from disk at open and re-seeded from disk after any statement that
    /// throws, so the only way to drift is a bug we would rather find than
    /// paper over — `countsOnDisk()` exists so the tests can prove it.
    private var cachedTotal = 0
    private var cachedPending = 0

    private var sequence: Int64 = -1
    private var ulid = ULIDGenerator()

    /// Coalesces BUFFER_OVERFLOW events. See `noteOverflow`.
    private var lastOverflowEventAt: Date?
    private static let overflowEventInterval: TimeInterval = 15 * 60

    init(database: SQLiteDatabase, session: SessionStore, maxRows: Int = PointBuffer.defaultMaxRows) {
        self.database = database
        self.session = session
        self.maxRows = max(maxRows, 1)

        database.sync {
            self.resyncCounts()
            let reclaimed = self.reclaim(where: "sync_state = \(SyncState.inFlight)")
            if reclaimed > 0 {
                /*
                 * Every in-flight row at open belonged to a process that no
                 * longer exists.
                 *
                 * There is exactly one process per app on iOS and nothing else
                 * opens this file, so an IN_FLIGHT row can only have been
                 * claimed by a previous launch — one that was killed, crashed,
                 * or was force-quit mid-upload. Android waits five minutes
                 * before reclaiming because it cannot make that argument about
                 * its own process; we can, so these points go back in the queue
                 * immediately instead of sitting invisible for five minutes at
                 * the exact moment a driver has just come back into coverage.
                 *
                 * One caveat, and it is fine: a background `URLSession` upload
                 * can genuinely outlive the process and complete after relaunch.
                 * Reclaiming here means those points are sent again. That is a
                 * duplicate, which the server drops, and duplicates are the
                 * side of this trade we chose.
                 */
                Self.log.warning("Reclaimed \(reclaimed) point(s) left in flight by a previous launch")
            }
        }
    }

    // =========================================================================
    // 1. CAPTURE — called from the location callback. Fast, and never throws.
    // =========================================================================

    enum AppendResult: Equatable {
        case stored(id: String, deviceSeq: Int64, evicted: Int)
        /// The same client point id is already buffered. Not an error: the
        /// server treats the id as an idempotency key and so do we.
        case duplicate(id: String)
        /// No session is claimed, so there is nothing to attribute the fix to.
        case noSession
        /// The write failed and this fix is gone. Logged loudly; tracking goes
        /// on. See the comment below for why this is not thrown.
        case failed(reason: String)
    }

    /// Store one fix, attributing it to the currently claimed session.
    ///
    /// This is the entry point the location engine should use: taking the
    /// session id from the store rather than from the caller makes it impossible
    /// to file a fix under a session that has already ended.
    @discardableResult
    func append(
        _ location: CLLocation,
        batteryPct: Int?,
        isCharging: Bool,
        networkType: String?
    ) -> AppendResult {
        guard let sessionId = session.sessionId else { return .noSession }
        return append(BufferedPoint.Capture(
            location: location,
            sessionId: sessionId,
            batteryPct: batteryPct,
            isCharging: isCharging,
            networkType: networkType
        ))
    }

    /// Store one fix.
    ///
    /// Deliberately non-throwing. On Android the equivalent call is made from a
    /// bare `launch` with no exception handler, so a single `SQLITE_FULL` on a
    /// driver's nearly-full phone took the whole process down — the shift ended
    /// with a crash dialog instead of a degraded but working tracker. The same
    /// reasoning applies harder here, because on iOS the caller is a delegate
    /// method the system invoked: an error thrown out of it has nowhere to go.
    @discardableResult
    func append(_ capture: BufferedPoint.Capture) -> AppendResult {
        database.sync {
            let id = ulid.generate(at: capture.recordedAt)
            var sequenceNumber: Int64 = 0
            var inserted = false
            var evicted = 0

            do {
                // The closure's `Void` is spelled out because it exits early and
                // `transaction` is generic; leaving it to inference is a
                // needlessly fragile place to be clever.
                try database.transaction { () -> Void in
                    /*
                     * The sequence number and the row it belongs to commit
                     * together, or neither does.
                     *
                     * The counter only has to be monotonic — it is how the
                     * dispatcher detects a gap the server could not otherwise
                     * infer, and it is not an identity (that is the ULID).
                     * Skipping a number is harmless; *reusing* one is not,
                     * because two different fixes claiming sequence 4,102 makes
                     * gap detection lie. Android accepts skips as the price of
                     * not fsyncing a preferences file per fix. Sharing this
                     * transaction costs nothing and does neither.
                     */
                    sequenceNumber = try allocateSequence()

                    // INSERT OR IGNORE: the primary key is the client point id,
                    // so replaying the same fix is a no-op rather than a crash,
                    // exactly as it is on the server.
                    inserted = try database.run(
                        Self.insertSQL,
                        Self.bindings(id: id, sequence: sequenceNumber, capture)
                    ) > 0
                    guard inserted else { return }

                    let overflow = (cachedTotal + 1) - maxRows
                    if overflow > 0 { evicted = try evictOldestPending(overflow) }
                }
            } catch {
                Self.log.error("Buffer write failed, dropping this fix and continuing: \(String(describing: error), privacy: .public)")
                resyncCounts()
                return .failed(reason: String(describing: error))
            }

            guard inserted else { return .duplicate(id: id) }

            cachedTotal += 1 - evicted
            cachedPending += 1 - evicted
            if evicted > 0 {
                noteOverflow(evicted, sessionId: capture.sessionId, at: capture.recordedAt)
            }
            return .stored(id: id, deviceSeq: sequenceNumber, evicted: evicted)
        }
    }

    /// Next device sequence number, seeded on first use.
    ///
    /// Seeded from the maximum of the persisted counter and `MAX(device_seq)` in
    /// the table. Either alone is insufficient: the table's maximum drops as
    /// acknowledged rows are deleted, and a state table restored from an older
    /// copy could trail the rows that are actually present.
    private func allocateSequence() throws -> Int64 {
        if sequence < 0 {
            // MAX() over an empty table is one row containing NULL, not no rows.
            let highestBuffered: Int64 = try database.first(
                "SELECT MAX(device_seq) FROM location_points"
            ) { $0.int64OrNil(0) ?? 0 } ?? 0
            sequence = max(session.deviceSeq, highestBuffered)
        }
        sequence += 1
        try session.setDeviceSeq(sequence)
        return sequence
    }

    // =========================================================================
    // 2. THE CAP
    // =========================================================================

    /// Drop the oldest pending points to get back under the cap.
    ///
    /// Oldest first, because a dispatcher hunting a truck right now needs the
    /// newest fixes — the start of a route that is twelve hours old is the least
    /// costly thing to lose. In-flight rows are excluded: they are already paid
    /// for and about to be acknowledged, and yanking them out from under an
    /// upload would waste the bytes that were the scarce thing to begin with.
    ///
    /// A consequence worth naming: if every row were in flight the buffer could
    /// briefly exceed the cap. In practice in-flight is bounded by one chunk
    /// (500 rows) against a cap of half a million, so the overshoot is 0.1%.
    private func evictOldestPending(_ count: Int) throws -> Int {
        try database.run(
            """
            DELETE FROM location_points WHERE id IN (
                SELECT id FROM location_points
                 WHERE sync_state = \(SyncState.pending)
                 ORDER BY recorded_at ASC
                 LIMIT ?
            )
            """,
            [.integer(Int64(count))]
        )
    }

    /// Make the loss visible — durably, and without drowning the queue.
    ///
    /// A buffer that silently drops the start of a route is worse than one that
    /// admits it, so the count is persisted (it outlives the session, because
    /// "why does this trace start outside Gaziantep?" is asked days later) and an
    /// event is queued for the dispatcher.
    ///
    /// The event is coalesced, and that is a deliberate divergence from Android.
    /// There, once the buffer is at the cap, *every subsequent fix* evicts one
    /// row and records one event — several thousand events in a shift, each an
    /// HTTP POST, all saying the same thing, and all of them queued ahead of the
    /// one message that actually matters when a phone is in trouble. One event
    /// on entering overflow, then at most one every fifteen minutes carrying the
    /// running total, says the same thing and leaves the queue usable.
    private func noteOverflow(_ evicted: Int, sessionId: String, at date: Date) {
        let total = session.recordEviction(count: evicted, at: date)
        Self.log.error("BUFFER OVERFLOW — evicted \(evicted) oldest point(s), \(total) lost in total")

        let due = lastOverflowEventAt.map { date.timeIntervalSince($0) >= Self.overflowEventInterval } ?? true
        guard due else { return }
        lastOverflowEventAt = date

        recordEvent(
            sessionId: sessionId,
            type: "BUFFER_OVERFLOW",
            message: "Local buffer hit \(maxRows) rows; dropping the oldest points",
            payload: ["evicted": String(evicted), "evictedTotal": String(total)],
            occurredAt: date
        )
    }

    // =========================================================================
    // 3. CLAIM / ACKNOWLEDGE
    // =========================================================================

    /// A batch of points, marked as ours, waiting for an acknowledgement.
    struct Claim: Equatable {
        let batchId: String
        let points: [BufferedPoint]
        /// Points still PENDING after this claim. Sent as `bufferRemaining` so
        /// the dashboard can show how far behind a truck is.
        let pendingRemaining: Int

        /// Whether this is recovered backlog rather than a live ping.
        ///
        /// The server uses it to emit `route:backfill` instead of
        /// `position:update`, so a lorry coming out of a dead zone does not make
        /// its own marker rewind across the dispatcher's map. Computed with the
        /// same rule as Android so the two clients cannot disagree about what a
        /// backlog is.
        func isBacklog(now: Date = Date()) -> Bool {
            guard points.count > 1, let first = points.first else { return false }
            return now.timeIntervalSince(first.recordedAt) > 60
        }
    }

    /// Move up to `limit` of the oldest pending rows into IN_FLIGHT and return
    /// them, atomically.
    ///
    /// The mark and the read are one transaction on purpose: two concurrent
    /// uploaders — the realtime pump and a background drain, which do overlap —
    /// would otherwise be able to interleave between the UPDATE and the SELECT
    /// and both walk away believing they own the same rows.
    ///
    /// Oldest first, so that after a dead zone the dispatcher's map fills in
    /// chronologically and one poisoned chunk cannot block the newer points
    /// behind it.
    func claimBatch(limit: Int, now: Date = Date()) -> Claim? {
        database.sync {
            let batchId = UUID().uuidString.lowercased()
            var claimed = 0
            var points: [BufferedPoint] = []

            do {
                try database.transaction { () -> Void in
                    claimed = try database.run(
                        """
                        UPDATE location_points
                           SET sync_state = \(SyncState.inFlight), batch_id = ?, claimed_at = ?
                         WHERE id IN (
                            SELECT id FROM location_points
                             WHERE sync_state = \(SyncState.pending)
                             ORDER BY recorded_at ASC
                             LIMIT ?
                         )
                        """,
                        [.text(batchId), .millis(now), .integer(Int64(max(limit, 1)))]
                    )
                    guard claimed > 0 else { return }
                    points = try database.query(
                        "\(Self.selectColumns) FROM location_points WHERE batch_id = ? ORDER BY recorded_at ASC",
                        [.text(batchId)],
                        BufferedPoint.init(row:)
                    )
                }
            } catch {
                Self.log.error("Claim failed: \(String(describing: error), privacy: .public)")
                resyncCounts()
                return nil
            }

            guard claimed > 0 else { return nil }
            cachedPending -= claimed
            return Claim(batchId: batchId, points: points, pendingRemaining: cachedPending)
        }
    }

    /// **The only delete on the sync path in the entire app.**
    ///
    /// Call this and nothing else after a 2xx that names this batch id. Not on a
    /// timeout, not on a 5xx, not on "it probably went through", not on a 2xx
    /// for some other batch. Every other outcome is `release`.
    @discardableResult
    func acknowledge(batchId: String) -> Int {
        database.sync {
            do {
                let deleted = try database.run(
                    "DELETE FROM location_points WHERE batch_id = ?", [.text(batchId)]
                )
                // The rows were IN_FLIGHT, so only the total moves.
                cachedTotal -= deleted
                return deleted
            } catch {
                Self.log.error("Acknowledge failed: \(String(describing: error), privacy: .public)")
                resyncCounts()
                return 0
            }
        }
    }

    /// Any failure at all: hand the rows back to the queue and remember the try.
    @discardableResult
    func release(batchId: String) -> Int {
        database.sync {
            do {
                let released = try database.run(
                    """
                    UPDATE location_points
                       SET sync_state = \(SyncState.pending), batch_id = NULL,
                           claimed_at = 0, attempts = attempts + 1
                     WHERE batch_id = ?
                    """,
                    [.text(batchId)]
                )
                cachedPending += released
                return released
            } catch {
                Self.log.error("Release failed: \(String(describing: error), privacy: .public)")
                resyncCounts()
                return 0
            }
        }
    }

    /// Reclaim rows whose uploader vanished without releasing them.
    ///
    /// The constructor already reclaims *everything* in flight at launch, which
    /// covers process death. This covers the other case: a long-running process
    /// whose upload task was cancelled, abandoned, or lost to a URLSession the
    /// system tore down without calling back. Without it those points would sit
    /// IN_FLIGHT until the app was next launched cold — invisible, uncounted,
    /// and not uploaded.
    @discardableResult
    func recoverOrphanedClaims(olderThan age: TimeInterval = 300, now: Date = Date()) -> Int {
        database.sync {
            let cutoff = Int64(((now.timeIntervalSince1970 - age) * 1000).rounded())
            let recovered = reclaim(
                where: "sync_state = \(SyncState.inFlight) AND claimed_at < \(cutoff)"
            )
            if recovered > 0 {
                Self.log.warning("Recovered \(recovered) orphaned point(s) from an abandoned upload")
            }
            return recovered
        }
    }

    /// Shared body of both recovery paths. `predicate` is built from our own
    /// integer constants, never from anything that came off the wire.
    @discardableResult
    private func reclaim(where predicate: String) -> Int {
        do {
            let recovered = try database.run(
                """
                UPDATE location_points
                   SET sync_state = \(SyncState.pending), batch_id = NULL,
                       claimed_at = 0, attempts = attempts + 1
                 WHERE \(predicate)
                """
            )
            cachedPending += recovered
            return recovered
        } catch {
            Self.log.error("Reclaim failed: \(String(describing: error), privacy: .public)")
            resyncCounts()
            return 0
        }
    }

    // =========================================================================
    // 4. COUNTS AND READS
    // =========================================================================

    struct Counts: Equatable, Sendable {
        let total: Int
        let pending: Int
        let inFlight: Int
    }

    /// O(1) — served from the in-memory counters, which is what makes it safe
    /// for SwiftUI to ask on every redraw.
    var counts: Counts {
        database.sync { Counts(total: cachedTotal, pending: cachedPending, inFlight: cachedTotal - cachedPending) }
    }

    var hasUnsentWork: Bool {
        database.sync { cachedTotal > 0 || eventCount > 0 }
    }

    /// The oldest thing still waiting. Drives "çevrimdışı · 2 saattir bekliyor".
    var oldestPendingAt: Date? {
        database.sync {
            (try? database.first(
                "SELECT MIN(recorded_at) FROM location_points WHERE sync_state = \(SyncState.pending)"
            ) { $0.millisOrNil(0) }) ?? nil
        }
    }

    /// Most recent buffered fix.
    ///
    /// Ordered by `id`, not by `recorded_at`. The id is a ULID, so it is
    /// lexicographically time-ordered *and* it is the primary key — the query is
    /// a seek to the right edge of an index that already exists. Ordering by
    /// `recorded_at` would be a full scan, since the only index on it is
    /// prefixed by `sync_state`. This is the payoff for choosing a time-sortable
    /// id over a UUID.
    var latest: BufferedPoint? {
        database.sync {
            try? database.first(
                "\(Self.selectColumns) FROM location_points ORDER BY id DESC LIMIT 1",
                [],
                BufferedPoint.init(row:)
            )
        }
    }

    func points(forSession sessionId: String) -> [BufferedPoint] {
        database.sync {
            (try? database.query(
                "\(Self.selectColumns) FROM location_points WHERE session_id = ? ORDER BY recorded_at ASC",
                [.text(sessionId)],
                BufferedPoint.init(row:)
            )) ?? []
        }
    }

    /// Counted straight off disk, bypassing the cache. For tests and for the
    /// error path — see the note on `cachedTotal`.
    func countsOnDisk() -> Counts {
        database.sync {
            let total = (try? database.count("SELECT COUNT(*) FROM location_points")) ?? 0
            let pending = (try? database.count(
                "SELECT COUNT(*) FROM location_points WHERE sync_state = \(SyncState.pending)"
            )) ?? 0
            return Counts(total: total, pending: pending, inFlight: total - pending)
        }
    }

    private func resyncCounts() {
        let disk = countsOnDisk()
        cachedTotal = disk.total
        cachedPending = disk.pending
    }

    // =========================================================================
    // 5. DISPOSAL — never on the sync path
    // =========================================================================

    /// Drop a finished session's leftovers.
    ///
    /// Only correct once the session is closed *and* drained; it deletes
    /// unacknowledged rows, which is the one thing the rest of this file exists
    /// to prevent. The driver pressing "finish" is not enough on its own —
    /// `clearSession()` on the store deliberately leaves the buffer alone so
    /// those points can still be uploaded under their own session id.
    @discardableResult
    func deleteSession(_ sessionId: String) -> Int {
        database.sync {
            let deleted = (try? database.run(
                "DELETE FROM location_points WHERE session_id = ?", [.text(sessionId)]
            )) ?? 0
            let events = (try? database.run(
                "DELETE FROM pending_events WHERE session_id = ?", [.text(sessionId)]
            )) ?? 0
            if deleted > 0 || events > 0 {
                Self.log.notice("Purged \(deleted) point(s) and \(events) event(s) for a finished session")
            }
            resyncCounts()
            return deleted
        }
    }

    /// Everything. Support tool only; there is no user-facing path to this.
    func clear() {
        database.sync {
            try? database.exec("DELETE FROM location_points; DELETE FROM pending_events;")
            resyncCounts()
            database.checkpoint()
        }
    }

    // =========================================================================
    // 6. EVENTS
    // =========================================================================

    /// A lifecycle or diagnostic message, buffered exactly like a point.
    ///
    /// These share the buffer's database for the reason `PendingEventEntity`
    /// gives on Android: the events worth having are generated precisely when
    /// the phone is offline or dying. On iOS the canonical one is not
    /// SERVICE_KILLED but its local equivalent — the driver revoked "Always"
    /// location, or Background App Refresh was switched off — and a
    /// fire-and-forget POST would lose exactly the message that explains the gap
    /// the dispatcher is staring at.
    struct Event: Equatable, Sendable {
        let id: Int64
        let sessionId: String
        let type: String
        let occurredAt: Date
        let message: String?
        /// Already-encoded JSON object, passed through to `kh.session_events`.
        let payloadJSON: String?
        let attempts: Int
    }

    @discardableResult
    func recordEvent(
        sessionId: String,
        type: String,
        message: String? = nil,
        payload: [String: String]? = nil,
        occurredAt: Date = Date()
    ) -> Bool {
        database.sync {
            var encoded: String?
            if let payload, !payload.isEmpty {
                encoded = (try? JSONEncoder().encode(payload)).flatMap { String(data: $0, encoding: .utf8) }
            }
            do {
                try database.run(
                    """
                    INSERT INTO pending_events (session_id, type, occurred_at, message, payload)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    [.text(sessionId), .text(type), .millis(occurredAt),
                     .textOrNull(message), .textOrNull(encoded)]
                )
                Self.log.notice("Event queued: \(type, privacy: .public)")
                return true
            } catch {
                Self.log.error("Event write failed: \(String(describing: error), privacy: .public)")
                return false
            }
        }
    }

    func oldestEvents(limit: Int = 20) -> [Event] {
        database.sync {
            (try? database.query(
                // `id` breaks the tie. Several events can share a millisecond —
                // PERMISSION_REVOKED and the GPS_LOST it causes arrive together —
                // and without a deterministic order a retry can deliver them in
                // a different sequence than the one they happened in.
                """
                SELECT id, session_id, type, occurred_at, message, payload, attempts
                  FROM pending_events ORDER BY occurred_at ASC, id ASC LIMIT ?
                """,
                [.integer(Int64(max(limit, 1)))]
            ) { row in
                Event(
                    id: row.int(0), sessionId: row.text(1), type: row.text(2),
                    occurredAt: row.millis(3), message: row.textOrNil(4),
                    payloadJSON: row.textOrNil(5), attempts: Int(row.int(6))
                )
            }) ?? []
        }
    }

    func deleteEvent(id: Int64) {
        database.sync { try? database.run("DELETE FROM pending_events WHERE id = ?", [.integer(id)]) }
    }

    func markEventAttempt(id: Int64) {
        database.sync {
            try? database.run("UPDATE pending_events SET attempts = attempts + 1 WHERE id = ?", [.integer(id)])
        }
    }

    /// Give up after twenty tries. An event that cannot be delivered in twenty
    /// attempts across a shift is a poison message, and keeping it blocks every
    /// event behind it forever.
    @discardableResult
    func dropPoisonedEvents() -> Int {
        database.sync {
            (try? database.run("DELETE FROM pending_events WHERE attempts >= 20")) ?? 0
        }
    }

    var eventCount: Int {
        database.sync { (try? database.count("SELECT COUNT(*) FROM pending_events")) ?? 0 }
    }

    // =========================================================================
    // SQL
    // =========================================================================

    private static let selectColumns = """
        SELECT id, session_id, recorded_at, monotonic_ns, lat, lon, accuracy_m,
               altitude_m, vertical_accuracy_m, speed_mps, speed_accuracy_mps,
               bearing_deg, satellites, provider, battery_pct, is_charging,
               is_mock, network_type, device_seq, attempts
        """

    private static let insertSQL = """
        INSERT OR IGNORE INTO location_points (
            id, session_id, recorded_at, monotonic_ns, lat, lon, accuracy_m,
            altitude_m, vertical_accuracy_m, speed_mps, speed_accuracy_mps,
            bearing_deg, satellites, provider, battery_pct, is_charging,
            is_mock, network_type, device_seq,
            sync_state, batch_id, claimed_at, attempts, created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 0, NULL, 0, 0, ?)
        """

    private static func bindings(
        id: String, sequence: Int64, _ capture: BufferedPoint.Capture
    ) -> [SQLValue] {
        [
            .text(id),
            .text(capture.sessionId),
            .millis(capture.recordedAt),
            .integer(capture.monotonicNs),
            .real(capture.latitude),
            .real(capture.longitude),
            .doubleOrNull(capture.accuracyM),
            .doubleOrNull(capture.altitudeM),
            .doubleOrNull(capture.verticalAccuracyM),
            .doubleOrNull(capture.speedMps),
            .doubleOrNull(capture.speedAccuracyMps),
            .doubleOrNull(capture.bearingDeg),
            .intOrNull(capture.satellites),
            .textOrNull(capture.provider),
            .intOrNull(capture.batteryPct),
            .bool(capture.isCharging),
            .bool(capture.isMock),
            .textOrNull(capture.networkType),
            .integer(sequence),
            .millis(Date()),
        ]
    }
}

// =============================================================================
// The row
// =============================================================================

/// One buffered GPS fix, as it sits on disk.
///
/// The field set is the wire shape of `LocationPointDto` and nothing more, so
/// the uploader can encode a row without deciding anything. Anything the server
/// will not store is not worth a driver's flash.
struct BufferedPoint: Equatable, Sendable {
    /// Client-generated ULID. Primary key here, idempotency key there — the
    /// server's `(session_id, client_point_id, recorded_at)` is what makes a
    /// re-send after a lost acknowledgement free.
    let id: String
    let sessionId: String

    /// UTC from the GPS fix itself, not from the phone's clock.
    ///
    /// `CLLocation.timestamp` is the time the fix was *determined*, which for a
    /// GNSS solve is satellite time. A driver who changes the time zone at the
    /// Habur crossing, or a phone that corrects itself over NTP mid-shift,
    /// cannot bend the route.
    let recordedAt: Date

    /// A monotonic stamp that survives every wall-clock change. Ordering and gap
    /// detection use this; `recordedAt` is what gets drawn.
    let monotonicNs: Int64

    let latitude: Double
    let longitude: Double

    let accuracyM: Double?
    let altitudeM: Double?
    let verticalAccuracyM: Double?
    let speedMps: Double?
    let speedAccuracyMps: Double?
    let bearingDeg: Double?
    /// Always nil on iOS — CoreLocation does not expose satellite counts to
    /// third-party apps. Kept in the schema so the two clients produce the same
    /// rows and the dashboard needs no platform branch.
    let satellites: Int?
    let provider: String?

    /// The dispatcher's early warning that a truck is about to go dark.
    let batteryPct: Int?
    let isCharging: Bool

    /// Recorded, never dropped. A spoofed route is evidence in a dispute with a
    /// carrier; deleting the points would destroy it.
    let isMock: Bool

    let networkType: String?

    /// Monotonic per install. Lets the server detect a gap it could not
    /// otherwise infer — points that were never recorded look exactly like
    /// points that were recorded and lost, unless the numbering says otherwise.
    let deviceSeq: Int64

    /// How many upload attempts this row has survived. Diagnostic; a row with a
    /// high count is a hint at a poisoned batch.
    let attempts: Int

    init(row: SQLRow) {
        self.id = row.text(0)
        self.sessionId = row.text(1)
        self.recordedAt = row.millis(2)
        self.monotonicNs = row.int(3)
        self.latitude = row.double(4)
        self.longitude = row.double(5)
        self.accuracyM = row.doubleOrNil(6)
        self.altitudeM = row.doubleOrNil(7)
        self.verticalAccuracyM = row.doubleOrNil(8)
        self.speedMps = row.doubleOrNil(9)
        self.speedAccuracyMps = row.doubleOrNil(10)
        self.bearingDeg = row.doubleOrNil(11)
        self.satellites = row.intOrNil(12)
        self.provider = row.textOrNil(13)
        self.batteryPct = row.intOrNil(14)
        self.isCharging = row.bool(15)
        self.isMock = row.bool(16)
        self.networkType = row.textOrNil(17)
        self.deviceSeq = row.int(18)
        self.attempts = Int(row.int(19))
    }
}

extension BufferedPoint {

    /// What the location engine hands the buffer. Everything except the two
    /// fields the buffer itself owns: the id and the sequence number.
    struct Capture: Equatable, Sendable {
        var sessionId: String
        var recordedAt: Date
        var monotonicNs: Int64
        var latitude: Double
        var longitude: Double
        var accuracyM: Double?
        var altitudeM: Double?
        var verticalAccuracyM: Double?
        var speedMps: Double?
        var speedAccuracyMps: Double?
        var bearingDeg: Double?
        var satellites: Int?
        var provider: String?
        var batteryPct: Int?
        var isCharging: Bool
        var isMock: Bool
        var networkType: String?

        init(
            sessionId: String,
            recordedAt: Date,
            monotonicNs: Int64 = BufferedPoint.monotonicNanos(),
            latitude: Double,
            longitude: Double,
            accuracyM: Double? = nil,
            altitudeM: Double? = nil,
            verticalAccuracyM: Double? = nil,
            speedMps: Double? = nil,
            speedAccuracyMps: Double? = nil,
            bearingDeg: Double? = nil,
            satellites: Int? = nil,
            provider: String? = nil,
            batteryPct: Int? = nil,
            isCharging: Bool = false,
            isMock: Bool = false,
            networkType: String? = nil
        ) {
            self.sessionId = sessionId
            self.recordedAt = recordedAt
            self.monotonicNs = monotonicNs
            self.latitude = latitude
            self.longitude = longitude
            self.accuracyM = accuracyM
            self.altitudeM = altitudeM
            self.verticalAccuracyM = verticalAccuracyM
            self.speedMps = speedMps
            self.speedAccuracyMps = speedAccuracyMps
            self.bearingDeg = bearingDeg
            self.satellites = satellites
            self.provider = provider
            self.batteryPct = batteryPct
            self.isCharging = isCharging
            self.isMock = isMock
            self.networkType = networkType
        }

        /// Translate a `CLLocation`, honouring every one of CoreLocation's
        /// sentinel values.
        ///
        /// This mapping lives here, once, because getting it wrong is silent.
        /// CoreLocation does not use `nil` for "unknown"; it uses negative
        /// numbers, and they are different negatives for different fields:
        ///
        ///  - `horizontalAccuracy < 0`   the whole fix is invalid
        ///  - `verticalAccuracy <= 0`    `altitude` means nothing
        ///  - `speed < 0`                speed unavailable
        ///  - `speedAccuracy < 0`        speed uncertainty unavailable
        ///  - `course < 0`               heading unavailable
        ///
        /// Passed straight through, `-1` becomes a lorry travelling at minus one
        /// metre per second on a bearing of minus one degree, and the server's
        /// `speed >= 0` and `bearing 0..360` checks reject the point — losing a
        /// perfectly good coordinate over a sentinel.
        init(
            location: CLLocation,
            sessionId: String,
            batteryPct: Int?,
            isCharging: Bool,
            networkType: String?
        ) {
            let altitudeIsValid = location.verticalAccuracy > 0

            var provider = "ios-gnss"
            var simulated = false
            if let source = location.sourceInformation {
                simulated = source.isSimulatedBySoftware
                if simulated {
                    provider = "ios-simulated"
                } else if source.isProducedByAccessory {
                    // An external GPS puck. Worth knowing about: they are common
                    // in cabs, and their fixes have different characteristics
                    // from the phone's own.
                    provider = "ios-accessory"
                }
            }

            self.init(
                sessionId: sessionId,
                recordedAt: location.timestamp,
                monotonicNs: BufferedPoint.monotonicNanos(),
                latitude: location.coordinate.latitude,
                longitude: location.coordinate.longitude,
                accuracyM: location.horizontalAccuracy >= 0 ? location.horizontalAccuracy : nil,
                altitudeM: altitudeIsValid ? location.altitude : nil,
                verticalAccuracyM: altitudeIsValid ? location.verticalAccuracy : nil,
                speedMps: location.speed >= 0 ? location.speed : nil,
                speedAccuracyMps: location.speedAccuracy >= 0 ? location.speedAccuracy : nil,
                bearingDeg: location.course >= 0 ? location.course : nil,
                // CoreLocation gives third-party apps no satellite count. The
                // column stays for parity with Android rather than being faked.
                satellites: nil,
                provider: provider,
                batteryPct: batteryPct,
                isCharging: isCharging,
                // The iOS analogue of `Location.isMock`. Recorded, never used to
                // discard the fix.
                isMock: simulated,
                networkType: networkType
            )
        }
    }

    /// A monotonic clock that keeps running while the device sleeps.
    ///
    /// `CLOCK_MONOTONIC`, not `ProcessInfo.systemUptime`. On Darwin
    /// `systemUptime` is `CLOCK_UPTIME_RAW`, which *stops* while the system is
    /// asleep — a phone in a cradle with the screen off would compress six hours
    /// of motorway into a few minutes of apparent elapsed time, and the gap
    /// detection built on this column would report a continuous route across a
    /// stop that really happened. `CLOCK_MONOTONIC` on Darwin keeps counting
    /// through sleep, which is what Android's `SystemClock.elapsedRealtime`
    /// does and what this column is a port of.
    static func monotonicNanos() -> Int64 {
        var ts = timespec()
        clock_gettime(CLOCK_MONOTONIC, &ts)
        return Int64(ts.tv_sec) * 1_000_000_000 + Int64(ts.tv_nsec)
    }
}

// =============================================================================
// ULID
// =============================================================================

extension PointBuffer {

    /// ULID — 26 characters of Crockford Base32, lexicographically sortable by
    /// time.
    ///
    /// Chosen over a UUIDv4 for the point identity for the same reason Android
    /// chose it: the server's primary key is
    /// `(session_id, client_point_id, recorded_at)`, and a time-ordered id makes
    /// a bulk insert land at the right edge of that B-tree instead of scattering
    /// across it — which is the difference between a fast and a painful flush
    /// when a lorry emerges from a dead zone with 8,600 points to deliver. It
    /// also earns the cheap `ORDER BY id DESC LIMIT 1` in `latest`.
    ///
    /// Monotonic inside a millisecond: two fixes sharing a timestamp increment
    /// the random component rather than redrawing it, so ids never collide and
    /// never go backwards within the same instant.
    ///
    /// No lock. Every caller reaches it through `database.sync`, so the serial
    /// queue already provides the mutual exclusion that `@Synchronized` provides
    /// on Android.
    struct ULIDGenerator {
        /// Crockford's alphabet: no I, L, O or U.
        private static let alphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")
        private static let timeChars = 10
        private static let randomChars = 16

        private var lastMillis: Int64 = -1
        private var entropy = [UInt8](repeating: 0, count: 10)

        /// Spelled out rather than left to the compiler: a struct with private
        /// stored properties gets a private memberwise initialiser, which would
        /// make this type unconstructible from the tests that pin it.
        init() {}

        mutating func generate(at date: Date = Date()) -> String {
            // Clamped at zero: a negative epoch would encode as a wrapped
            // 64-bit value and produce an id that sorts after every real one.
            // Only reachable from a phone whose clock is set to the 1960s, and
            // that phone should still be able to record a route.
            let millis = max(Int64((date.timeIntervalSince1970 * 1000).rounded()), 0)

            if millis == lastMillis {
                incrementEntropy()
            } else {
                redrawEntropy()
                lastMillis = millis
            }

            var out = ""
            out.reserveCapacity(Self.timeChars + Self.randomChars)

            var remaining = millis
            var timeDigits = [Character](repeating: "0", count: Self.timeChars)
            for index in stride(from: Self.timeChars - 1, through: 0, by: -1) {
                timeDigits[index] = Self.alphabet[Int(remaining & 0x1F)]
                remaining >>= 5
            }
            out.append(contentsOf: timeDigits)

            // 10 bytes = 80 bits = exactly 16 Base32 characters, no padding.
            var bits: UInt32 = 0
            var held = 0
            var emitted = 0
            for byte in entropy {
                bits = (bits << 8) | UInt32(byte)
                held += 8
                while held >= 5 && emitted < Self.randomChars {
                    held -= 5
                    out.append(Self.alphabet[Int((bits >> UInt32(held)) & 0x1F)])
                    emitted += 1
                }
            }
            return out
        }

        /// Big-endian +1 with carry, so monotonicity holds inside a millisecond.
        private mutating func incrementEntropy() {
            for index in stride(from: entropy.count - 1, through: 0, by: -1) {
                if entropy[index] == 0xFF {
                    entropy[index] = 0
                } else {
                    entropy[index] += 1
                    return
                }
            }
            // Eighty bits of carry inside one millisecond: not reachable, but
            // wrapping to all-zeros would be a collision, so redraw instead.
            redrawEntropy()
        }

        private mutating func redrawEntropy() {
            // `SystemRandomNumberGenerator` is arc4random-backed on Apple
            // platforms, so this is a CSPRNG — the same guarantee Android takes
            // from `SecureRandom`, without importing Security for something
            // whose job is collision avoidance rather than secrecy.
            var rng = SystemRandomNumberGenerator()
            for index in entropy.indices {
                entropy[index] = UInt8.random(in: UInt8.min...UInt8.max, using: &rng)
            }
        }
    }
}
