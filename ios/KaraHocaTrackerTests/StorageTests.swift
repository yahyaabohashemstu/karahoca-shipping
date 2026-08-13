import XCTest
import CoreLocation
@testable import KaraHocaTracker

/// ============================================================================
///  THE BUFFER
/// ============================================================================
///
/// These tests exist because the failure they guard against is invisible. A
/// broken cadence gate shows up as a sparse map; a broken claim/ack protocol
/// shows up as a route that is simply missing its middle hour, weeks later, in
/// an argument with a carrier about where a lorry actually was.
///
/// So the suite is written around the crash, not around the happy path: claim
/// and die, claim and fail, fill and overflow, write while reading. Anything
/// that can leave a point in a state nothing will ever pick up again is a bug
/// worth an ugly test.
final class PointBufferTests: XCTestCase {

    private var root: URL!
    private var opened: [SQLiteDatabase] = []
    private var storage: TrackerStorage!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("kh-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)

        storage = try makeStorage(named: "main")
        claimASession(on: storage)
    }

    override func tearDownWithError() throws {
        for database in opened { database.close() }
        opened.removeAll()
        storage = nil
        try? FileManager.default.removeItem(at: root)
    }

    // ---- Fixtures -----------------------------------------------------------

    /// Each storage gets its own folder, because a `TrackerStorage` always opens
    /// `karahoca-tracker.db` inside the folder it is given — which is what lets
    /// a test reopen *the same file* to simulate a relaunch.
    @discardableResult
    private func makeStorage(named name: String, maxRows: Int = PointBuffer.defaultMaxRows) throws -> TrackerStorage {
        let folder = root.appendingPathComponent(name, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let storage = try TrackerStorage.open(directory: folder, maxRows: maxRows)
        opened.append(storage.database)
        return storage
    }

    private func claimASession(on storage: TrackerStorage) {
        storage.session.saveSession(
            sessionId: "session-1",
            reference: "KH-2026-0413",
            policy: TrackingPolicy(pingIntervalSec: 10, idleIntervalSec: 60, minDistanceM: 0),
            shipment: SessionStore.Shipment(
                orderNumber: "SIP-88214",
                customerName: "Al Rashid Ticaret",
                destination: "Erbil",
                cargoSummary: "18 palet deterjan"
            )
        )
    }

    /// A plausible fix on the Gaziantep–Habur road.
    private func fix(
        at second: TimeInterval,
        lat: Double = 37.0662,
        lon: Double = 37.3833,
        session: String = "session-1"
    ) -> BufferedPoint.Capture {
        BufferedPoint.Capture(
            sessionId: session,
            recordedAt: Date(timeIntervalSince1970: 1_700_000_000 + second),
            monotonicNs: Int64(second * 1_000_000_000),
            latitude: lat,
            longitude: lon,
            accuracyM: 8.5,
            altitudeM: 843.2,
            verticalAccuracyM: 6,
            speedMps: 19.4,
            speedAccuracyMps: 1.25,
            bearingDeg: 132.5,
            provider: "ios-gnss",
            batteryPct: 74,
            isCharging: true,
            isMock: false,
            networkType: "cellular"
        )
    }

    @discardableResult
    private func appendFixes(_ count: Int, to buffer: PointBuffer, from start: TimeInterval = 0) -> [String] {
        var ids: [String] = []
        for index in 0..<count {
            let result = buffer.append(fix(at: start + Double(index) * 10))
            guard case let .stored(id, _, _) = result else {
                XCTFail("expected the fix to be stored, got \(result)")
                continue
            }
            ids.append(id)
        }
        return ids
    }

    // =========================================================================
    // Capture
    // =========================================================================

    func testEveryFieldSurvivesTheRoundTrip() throws {
        let result = storage.points.append(fix(at: 0))
        guard case let .stored(id, seq, evicted) = result else {
            return XCTFail("expected .stored, got \(result)")
        }
        XCTAssertEqual(seq, 1)
        XCTAssertEqual(evicted, 0)
        XCTAssertEqual(id.count, 26)

        let stored = try XCTUnwrap(storage.points.latest)
        XCTAssertEqual(stored.id, id)
        XCTAssertEqual(stored.sessionId, "session-1")
        XCTAssertEqual(stored.recordedAt.timeIntervalSince1970, 1_700_000_000, accuracy: 0.001)
        XCTAssertEqual(stored.latitude, 37.0662, accuracy: 1e-9)
        XCTAssertEqual(stored.longitude, 37.3833, accuracy: 1e-9)
        XCTAssertEqual(stored.accuracyM, 8.5)
        XCTAssertEqual(stored.altitudeM, 843.2)
        XCTAssertEqual(stored.verticalAccuracyM, 6)
        XCTAssertEqual(stored.speedMps, 19.4)
        XCTAssertEqual(stored.speedAccuracyMps, 1.25)
        XCTAssertEqual(stored.bearingDeg, 132.5)
        XCTAssertNil(stored.satellites)          // CoreLocation never tells us
        XCTAssertEqual(stored.provider, "ios-gnss")
        XCTAssertEqual(stored.batteryPct, 74)
        XCTAssertTrue(stored.isCharging)
        XCTAssertFalse(stored.isMock)
        XCTAssertEqual(stored.networkType, "cellular")
        XCTAssertEqual(stored.deviceSeq, 1)
        XCTAssertEqual(stored.attempts, 0)
    }

    func testAFixWithNoClaimedSessionIsRefusedRatherThanOrphaned() throws {
        let fresh = try makeStorage(named: "unclaimed")
        let location = CLLocation(latitude: 37.06, longitude: 37.38)
        let result = fresh.points.append(location, batteryPct: 80, isCharging: false, networkType: "wifi")
        XCTAssertEqual(result, .noSession)
        XCTAssertEqual(fresh.points.counts.total, 0)
    }

    /// CoreLocation signals "unknown" with negative numbers, not with nil.
    ///
    /// Passed through, `-1` becomes a lorry doing minus one metre per second on
    /// a bearing of minus one degree, and the server's `speed >= 0` /
    /// `bearing 0..360` checks throw the point away — a perfectly good
    /// coordinate lost to a sentinel.
    func testCoreLocationSentinelsBecomeNulls() throws {
        let location = CLLocation(
            coordinate: CLLocationCoordinate2D(latitude: 37.0662, longitude: 37.3833),
            altitude: 900,
            horizontalAccuracy: 12,
            verticalAccuracy: -1,     // altitude is meaningless
            course: -1,               // heading unavailable
            speed: -1,                // speed unavailable
            timestamp: Date(timeIntervalSince1970: 1_700_000_000)
        )

        let result = storage.points.append(location, batteryPct: 55, isCharging: false, networkType: "wifi")
        guard case .stored = result else { return XCTFail("expected .stored, got \(result)") }

        let stored = try XCTUnwrap(storage.points.latest)
        XCTAssertEqual(stored.accuracyM, 12)
        XCTAssertNil(stored.altitudeM)
        XCTAssertNil(stored.verticalAccuracyM)
        XCTAssertNil(stored.speedMps)
        XCTAssertNil(stored.speedAccuracyMps)  // never set by this initialiser, so -1
        XCTAssertNil(stored.bearingDeg)
    }

    /// The primary key is the idempotency key on both sides of the wire, so the
    /// table has to enforce it rather than trusting the id generator.
    func testTheSameClientPointIdIsStoredOnce() throws {
        appendFixes(1, to: storage.points)
        let existing = try XCTUnwrap(storage.points.latest)

        let insert = """
            INSERT OR IGNORE INTO location_points
                (id, session_id, recorded_at, monotonic_ns, lat, lon, device_seq, created_at)
            VALUES (?, 'session-1', 1700000000000, 0, 37.0, 37.0, 999, 1700000000000)
            """
        let changed = try storage.database.run(insert, [.text(existing.id)])
        XCTAssertEqual(changed, 0, "a duplicate client point id must not create a second row")
        XCTAssertEqual(storage.points.countsOnDisk().total, 1)
    }

    // =========================================================================
    // Claim / acknowledge
    // =========================================================================

    func testClaimMarksRowsAndAcknowledgeDeletesExactlyThose() throws {
        appendFixes(10, to: storage.points)

        let claim = try XCTUnwrap(storage.points.claimBatch(limit: 4))
        XCTAssertEqual(claim.points.count, 4)
        XCTAssertEqual(claim.pendingRemaining, 6)
        XCTAssertEqual(storage.points.counts, PointBuffer.Counts(total: 10, pending: 6, inFlight: 4))

        // Oldest first: after a dead zone the map has to fill in chronologically.
        XCTAssertEqual(
            claim.points.map(\.recordedAt),
            claim.points.map(\.recordedAt).sorted()
        )
        XCTAssertEqual(claim.points.first?.deviceSeq, 1)

        let deleted = storage.points.acknowledge(batchId: claim.batchId)
        XCTAssertEqual(deleted, 4)
        XCTAssertEqual(storage.points.counts, PointBuffer.Counts(total: 6, pending: 6, inFlight: 0))
        XCTAssertEqual(storage.points.counts, storage.points.countsOnDisk())
    }

    func testTwoClaimsNeverOverlap() throws {
        appendFixes(10, to: storage.points)

        let first = try XCTUnwrap(storage.points.claimBatch(limit: 4))
        let second = try XCTUnwrap(storage.points.claimBatch(limit: 4))

        XCTAssertNotEqual(first.batchId, second.batchId)
        XCTAssertTrue(Set(first.points.map(\.id)).isDisjoint(with: second.points.map(\.id)))
        XCTAssertEqual(storage.points.counts.inFlight, 8)
        XCTAssertEqual(second.pendingRemaining, 2)

        // And a third claim can only take what is left.
        let third = try XCTUnwrap(storage.points.claimBatch(limit: 4))
        XCTAssertEqual(third.points.count, 2)
        XCTAssertNil(storage.points.claimBatch(limit: 4))
    }

    func testAFailedUploadReleasesTheRowsAndCountsTheAttempt() throws {
        appendFixes(5, to: storage.points)
        let claim = try XCTUnwrap(storage.points.claimBatch(limit: 5))

        let released = storage.points.release(batchId: claim.batchId)
        XCTAssertEqual(released, 5)
        XCTAssertEqual(storage.points.counts, PointBuffer.Counts(total: 5, pending: 5, inFlight: 0))

        // Re-claimable, with the same ids — which is exactly what makes a
        // re-send free: the server deduplicates on those ids.
        let again = try XCTUnwrap(storage.points.claimBatch(limit: 5))
        XCTAssertEqual(Set(again.points.map(\.id)), Set(claim.points.map(\.id)))
        XCTAssertTrue(again.points.allSatisfy { $0.attempts == 1 })
    }

    /// A 2xx for some other batch, or a duplicated acknowledgement, must not be
    /// able to reach into the buffer.
    func testAcknowledgingAnUnknownBatchDeletesNothing() throws {
        appendFixes(3, to: storage.points)
        let claim = try XCTUnwrap(storage.points.claimBatch(limit: 3))

        XCTAssertEqual(storage.points.acknowledge(batchId: UUID().uuidString), 0)
        XCTAssertEqual(storage.points.countsOnDisk().total, 3)

        XCTAssertEqual(storage.points.acknowledge(batchId: claim.batchId), 3)
        // The second acknowledgement of the same batch is a no-op, not a fault.
        XCTAssertEqual(storage.points.acknowledge(batchId: claim.batchId), 0)
        XCTAssertEqual(storage.points.counts.total, 0)
    }

    // =========================================================================
    // Crash recovery
    // =========================================================================

    /// The case the whole protocol is built for.
    ///
    /// Claim a batch, then lose the process before the server answers — jetsam,
    /// force-quit, a watchdog kill in a background launch. The points must come
    /// back, all of them, ready to be sent again.
    ///
    /// Closing the connection is the closest an in-process test can get to a
    /// kill; it is what the kernel does to the file descriptor either way, and
    /// SQLite's WAL recovery on the next open is the part being exercised.
    func testProcessDeathMidUploadLeavesEveryPointReclaimable() throws {
        let first = try makeStorage(named: "crash")
        claimASession(on: first)
        appendFixes(20, to: first.points)

        let claim = try XCTUnwrap(first.points.claimBatch(limit: 8))
        XCTAssertEqual(first.points.counts.inFlight, 8)

        // — the phone dies here, between the POST and the acknowledgement —
        first.database.close()

        let relaunched = try makeStorage(named: "crash")
        XCTAssertEqual(relaunched.points.counts.total, 20, "not one point may be lost")
        XCTAssertEqual(
            relaunched.points.counts.inFlight, 0,
            "an in-flight row at launch belonged to a process that no longer exists"
        )
        XCTAssertEqual(relaunched.points.counts.pending, 20)

        let reclaimed = try XCTUnwrap(relaunched.points.claimBatch(limit: 8))
        XCTAssertEqual(Set(reclaimed.points.map(\.id)), Set(claim.points.map(\.id)))
        XCTAssertTrue(reclaimed.points.allSatisfy { $0.attempts == 1 })
    }

    /// The other half: the process lives, but the upload that owned the batch
    /// never came back. Without this the rows sit invisible until the next cold
    /// launch, which on iOS might be tomorrow.
    func testAbandonedClaimsAreRecoveredWithoutARelaunch() throws {
        appendFixes(6, to: storage.points)
        let claimedAt = Date(timeIntervalSince1970: 1_700_000_000)
        let claim = try XCTUnwrap(storage.points.claimBatch(limit: 6, now: claimedAt))

        // Four minutes on: still someone's, leave it alone.
        XCTAssertEqual(
            storage.points.recoverOrphanedClaims(olderThan: 300, now: claimedAt.addingTimeInterval(240)),
            0
        )
        XCTAssertEqual(storage.points.counts.inFlight, 6)

        // Six minutes on: nothing is taking that long.
        XCTAssertEqual(
            storage.points.recoverOrphanedClaims(olderThan: 300, now: claimedAt.addingTimeInterval(360)),
            6
        )
        XCTAssertEqual(storage.points.counts.pending, 6)
        XCTAssertEqual(storage.points.acknowledge(batchId: claim.batchId), 0)
    }

    func testAnAcknowledgedDeleteSurvivesARelaunch() throws {
        let first = try makeStorage(named: "durable")
        claimASession(on: first)
        appendFixes(5, to: first.points)
        let claim = try XCTUnwrap(first.points.claimBatch(limit: 5))
        XCTAssertEqual(first.points.acknowledge(batchId: claim.batchId), 5)
        first.database.close()

        let relaunched = try makeStorage(named: "durable")
        XCTAssertEqual(relaunched.points.counts.total, 0)
    }

    // =========================================================================
    // The cap
    // =========================================================================

    func testTheCapEvictsOldestFirstAndAdmitsIt() throws {
        let small = try makeStorage(named: "cap", maxRows: 10)
        claimASession(on: small)

        let ids = appendFixes(10, to: small.points)
        XCTAssertEqual(small.points.counts.total, 10)
        XCTAssertEqual(small.session.snapshot().evictedTotal, 0)

        // Eleventh fix: one must go, and it must be the first.
        let result = small.points.append(fix(at: 100))
        guard case let .stored(_, _, evicted) = result else {
            return XCTFail("expected .stored, got \(result)")
        }
        XCTAssertEqual(evicted, 1)
        XCTAssertEqual(small.points.counts.total, 10)
        XCTAssertEqual(small.points.counts, small.points.countsOnDisk())

        let survivors = Set(small.points.points(forSession: "session-1").map(\.id))
        XCTAssertFalse(survivors.contains(ids[0]), "the oldest point is the one that goes")
        XCTAssertTrue(survivors.contains(ids[1]))

        // Loud, durable, and still true tomorrow.
        XCTAssertEqual(small.session.snapshot().evictedTotal, 1)
        XCTAssertNotNil(small.session.snapshot().evictedLastAt)
        let events = small.points.oldestEvents()
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events.first?.type, "BUFFER_OVERFLOW")
    }

    /// Eviction must never steal a row out from under an upload that has already
    /// paid for it in bytes.
    func testEvictionLeavesInFlightRowsAlone() throws {
        let small = try makeStorage(named: "cap-inflight", maxRows: 6)
        claimASession(on: small)
        let ids = appendFixes(6, to: small.points)

        // The four oldest are in flight.
        let claim = try XCTUnwrap(small.points.claimBatch(limit: 4))
        XCTAssertEqual(Set(claim.points.map(\.id)), Set(ids.prefix(4)))

        small.points.append(fix(at: 100))
        let remaining = Set(small.points.points(forSession: "session-1").map(\.id))
        XCTAssertTrue(
            Set(claim.points.map(\.id)).isSubset(of: remaining),
            "an in-flight batch must survive the cap"
        )
        // The oldest *pending* row is what gave way instead.
        XCTAssertFalse(remaining.contains(ids[4]))
    }

    /// Android emits one BUFFER_OVERFLOW event per fix once the cap is reached —
    /// thousands of identical POSTs in a shift, queued ahead of the messages
    /// that matter. One on entry, then a summary at most every fifteen minutes.
    func testOverflowEventsAreCoalescedButTheTallyIsNot() throws {
        let small = try makeStorage(named: "cap-flood", maxRows: 5)
        claimASession(on: small)
        appendFixes(5, to: small.points)

        for index in 0..<40 {
            small.points.append(fix(at: 100 + Double(index)))
        }

        XCTAssertEqual(small.points.oldestEvents(limit: 100).count, 1, "the event is coalesced")
        XCTAssertEqual(small.session.snapshot().evictedTotal, 40, "the count is not")
        XCTAssertEqual(small.points.counts.total, 5)
    }

    // =========================================================================
    // Counters
    // =========================================================================

    /// The in-memory counters are an optimisation, and an optimisation that can
    /// drift is a bug. This drives every mutation and then checks them against a
    /// real `COUNT(*)`.
    func testCachedCountsStayExactThroughAMixedWorkload() throws {
        let small = try makeStorage(named: "counters", maxRows: 40)
        claimASession(on: small)

        appendFixes(30, to: small.points)
        let a = try XCTUnwrap(small.points.claimBatch(limit: 12))
        small.points.acknowledge(batchId: a.batchId)

        let b = try XCTUnwrap(small.points.claimBatch(limit: 10))
        small.points.release(batchId: b.batchId)

        let c = try XCTUnwrap(small.points.claimBatch(limit: 5))
        small.points.recoverOrphanedClaims(olderThan: -1)   // force them stale
        XCTAssertEqual(small.points.acknowledge(batchId: c.batchId), 0)

        appendFixes(30, to: small.points, from: 1000)       // pushes past the cap
        XCTAssertEqual(small.points.counts, small.points.countsOnDisk())
        XCTAssertEqual(small.points.counts.total, 40)

        small.points.deleteSession("session-1")
        XCTAssertEqual(small.points.counts, small.points.countsOnDisk())
        XCTAssertEqual(small.points.counts.total, 0)
    }

    /// Writes arrive on CoreLocation's queue while the UI reads on the main
    /// actor. The serial queue is what makes that safe, and this is the test
    /// that would fail if someone replaced it with something cleverer.
    func testConcurrentWritesWhileReading() throws {
        let iterations = 300
        let readers = DispatchQueue(label: "reader", attributes: .concurrent)
        let group = DispatchGroup()

        for _ in 0..<3 {
            group.enter()
            readers.async {
                for _ in 0..<iterations {
                    _ = self.storage.points.counts
                    _ = self.storage.points.latest
                    _ = self.storage.session.snapshot()
                }
                group.leave()
            }
        }

        DispatchQueue.concurrentPerform(iterations: iterations) { index in
            self.storage.points.append(self.fix(at: Double(index)))
        }
        group.wait()

        XCTAssertEqual(storage.points.counts.total, iterations)
        XCTAssertEqual(storage.points.counts, storage.points.countsOnDisk())

        // Every fix got its own sequence number, with no gaps and no repeats —
        // which is the property the whole gap-detection story rests on.
        let sequences = storage.points.points(forSession: "session-1").map(\.deviceSeq).sorted()
        XCTAssertEqual(sequences, Array(1...Int64(iterations)))
        XCTAssertEqual(Set(storage.points.points(forSession: "session-1").map(\.id)).count, iterations)
    }

    // =========================================================================
    // Device sequence
    // =========================================================================

    /// Skipping a number is harmless to gap detection. Reusing one makes it lie.
    ///
    /// The nasty case is the third assertion: once a batch has been acknowledged
    /// the rows are gone, so `MAX(device_seq)` in the table no longer knows how
    /// high the counter ever got. Only the persisted value does.
    func testDeviceSequenceNeverRepeatsAcrossRelaunchOrDrain() throws {
        let first = try makeStorage(named: "sequence")
        claimASession(on: first)
        appendFixes(3, to: first.points)
        XCTAssertEqual(first.session.deviceSeq, 3)
        first.database.close()

        let second = try makeStorage(named: "sequence")
        guard case let .stored(_, seq, _) = second.points.append(fix(at: 100)) else {
            return XCTFail("expected .stored")
        }
        XCTAssertEqual(seq, 4)

        // Drain everything, so the table's MAX(device_seq) disappears.
        let claim = try XCTUnwrap(second.points.claimBatch(limit: 100))
        XCTAssertEqual(second.points.acknowledge(batchId: claim.batchId), 4)
        XCTAssertEqual(second.points.counts.total, 0)
        second.database.close()

        let third = try makeStorage(named: "sequence")
        guard case let .stored(_, resumed, _) = third.points.append(fix(at: 200)) else {
            return XCTFail("expected .stored")
        }
        XCTAssertEqual(resumed, 5, "an empty buffer must not restart the sequence")
    }

    // =========================================================================
    // Backlog classification
    // =========================================================================

    /// The flag the dashboard uses to decide between `route:backfill` and
    /// `position:update`. Getting it wrong makes a truck's marker rewind across
    /// the dispatcher's map as its dead-zone backlog arrives.
    func testBacklogFlagMatchesTheAndroidRule() throws {
        appendFixes(5, to: storage.points)
        let claim = try XCTUnwrap(storage.points.claimBatch(limit: 5))

        let recordedAt = try XCTUnwrap(claim.points.first?.recordedAt)
        XCTAssertTrue(claim.isBacklog(now: recordedAt.addingTimeInterval(120)))
        XCTAssertFalse(claim.isBacklog(now: recordedAt.addingTimeInterval(30)))

        // A single live ping is never a backlog, however old the clock says it is.
        storage.points.acknowledge(batchId: claim.batchId)
        storage.points.append(fix(at: 500))
        let single = try XCTUnwrap(storage.points.claimBatch(limit: 5))
        XCTAssertEqual(single.points.count, 1)
        XCTAssertFalse(single.isBacklog(now: Date()))
    }

    // =========================================================================
    // Events
    // =========================================================================

    func testEventsAreQueuedDeliveredAndEventuallyGivenUpOn() throws {
        let base = Date(timeIntervalSince1970: 1_700_000_000)
        storage.points.recordEvent(
            sessionId: "session-1",
            type: "PERMISSION_REVOKED",
            message: "Konum izni her zaman değil",
            payload: ["authorization": "whenInUse"],
            occurredAt: base
        )
        storage.points.recordEvent(
            sessionId: "session-1", type: "BATTERY_LOW", occurredAt: base.addingTimeInterval(5)
        )

        let queued = storage.points.oldestEvents()
        XCTAssertEqual(queued.count, 2)
        XCTAssertEqual(queued.first?.type, "PERMISSION_REVOKED")
        XCTAssertEqual(queued.first?.payloadJSON, #"{"authorization":"whenInUse"}"#)

        storage.points.deleteEvent(id: try XCTUnwrap(queued.first?.id))
        XCTAssertEqual(storage.points.eventCount, 1)

        let survivor = try XCTUnwrap(storage.points.oldestEvents().first)
        for _ in 0..<20 { storage.points.markEventAttempt(id: survivor.id) }
        XCTAssertEqual(storage.points.dropPoisonedEvents(), 1)
        XCTAssertEqual(storage.points.eventCount, 0)
    }

    /// Row ids are not recycled, so a retried delete for a delivered event
    /// cannot take out a newer one that inherited its id.
    func testEventIdsAreNotRecycled() throws {
        storage.points.recordEvent(sessionId: "session-1", type: "STARTED")
        let first = try XCTUnwrap(storage.points.oldestEvents().first)
        storage.points.deleteEvent(id: first.id)

        storage.points.recordEvent(sessionId: "session-1", type: "GPS_LOST")
        let second = try XCTUnwrap(storage.points.oldestEvents().first)
        XCTAssertGreaterThan(second.id, first.id)
    }

    // =========================================================================
    // The database itself
    // =========================================================================

    func testWalIsActuallyOn() {
        // Not "we asked for WAL" — what the file is actually in. The durability
        // argument in SQLiteDatabase only holds in WAL mode.
        XCTAssertEqual(storage.database.journalMode, "WAL")
    }

    func testReopeningNeverRecreatesTheSchema() throws {
        let first = try makeStorage(named: "no-destructive")
        claimASession(on: first)
        appendFixes(7, to: first.points)
        first.database.close()

        // A second open runs the migration list again. If any step were
        // destructive — a DROP, a recreate, a `fallbackToDestructiveMigration` —
        // these seven points would be gone, and they are points no server has.
        let second = try makeStorage(named: "no-destructive")
        XCTAssertEqual(second.points.counts.total, 7)
        XCTAssertEqual(second.session.reference, "KH-2026-0413")
    }

    func testNestedTransactionsRollBackIndependently() throws {
        appendFixes(2, to: storage.points)

        try storage.database.transaction { () -> Void in
            try storage.database.run("DELETE FROM location_points")
            // An inner unit of work fails and the caller absorbs it. The outer
            // transaction must keep its own work and lose only the inner's,
            // which is what SAVEPOINT buys over a bare depth counter.
            try? storage.database.transaction { () -> Void in
                try storage.database.run(
                    "INSERT INTO location_points (id, session_id, recorded_at, monotonic_ns, lat, lon, device_seq, created_at) "
                        + "VALUES ('X', 's', 1, 0, 0, 0, 1, 1)"
                )
                throw SQLiteDatabase.Failure.statement(sql: "test", code: 1, message: "deliberate")
            }
        }

        XCTAssertEqual(storage.points.countsOnDisk().total, 0, "the outer DELETE stands")
        let leaked = try storage.database.count("SELECT COUNT(*) FROM location_points WHERE id = 'X'")
        XCTAssertEqual(leaked, 0, "the inner INSERT was rolled back")
    }
}

// =============================================================================
//  SESSION STATE
// =============================================================================

final class SessionStoreTests: XCTestCase {

    private var root: URL!
    private var opened: [SQLiteDatabase] = []
    private var storage: TrackerStorage!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("kh-session-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        storage = try makeStorage(named: "main")
    }

    override func tearDownWithError() throws {
        for database in opened { database.close() }
        opened.removeAll()
        storage = nil
        try? FileManager.default.removeItem(at: root)
    }

    @discardableResult
    private func makeStorage(named name: String) throws -> TrackerStorage {
        let folder = root.appendingPathComponent(name, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let storage = try TrackerStorage.open(directory: folder)
        opened.append(storage.database)
        return storage
    }

    func testSessionSurvivesAColdRelaunch() throws {
        let first = try makeStorage(named: "cold")
        first.session.saveSession(
            sessionId: "sess-42",
            reference: "KH-2026-0999",
            policy: TrackingPolicy(pingIntervalSec: 15, idleIntervalSec: 120, minDistanceM: 50),
            shipment: SessionStore.Shipment(
                orderNumber: "SIP-1", customerName: "Müşteri", destination: "Musul", cargoSummary: nil
            )
        )
        let deviceId = first.session.deviceId
        first.database.close()

        // The normal iOS case: the system relaunched us straight into the
        // background with nothing but this table to go on.
        let relaunched = try makeStorage(named: "cold")
        let snapshot = relaunched.session.snapshot()
        XCTAssertEqual(snapshot.sessionId, "sess-42")
        XCTAssertEqual(snapshot.reference, "KH-2026-0999")
        XCTAssertEqual(snapshot.policy.pingIntervalSec, 15)
        XCTAssertEqual(snapshot.policy.idleIntervalSec, 120)
        XCTAssertEqual(snapshot.policy.minDistanceM, 50)
        XCTAssertEqual(snapshot.shipment.destination, "Musul")
        XCTAssertNil(snapshot.shipment.cargoSummary)
        XCTAssertEqual(relaunched.session.deviceId, deviceId, "the device id is per install, not per launch")
    }

    /// A policy that somehow got stored out of range must not come back out.
    /// The database's `ck_session_intervals` would refuse it; the phone has to
    /// agree, or the two disagree about what the trace should look like.
    func testStoredPolicyIsReclampedOnRead() throws {
        // Written behind the store's back, the way a corrupted row or a value
        // from a future build would arrive.
        for (key, value) in [
            ("ping_interval_sec", "0"), ("idle_interval_sec", "1"), ("min_distance_m", "99999"),
        ] {
            try storage.database.run(
                "INSERT OR REPLACE INTO session_state (key, value) VALUES (?, ?)",
                [.text(key), .text(value)]
            )
        }
        storage.database.close()

        let reopened = try makeStorage(named: "main")
        let policy = reopened.session.policy
        XCTAssertEqual(policy.pingIntervalSec, 2)
        XCTAssertGreaterThanOrEqual(policy.idleIntervalSec, policy.pingIntervalSec)
        XCTAssertEqual(policy.minDistanceM, 20000)
    }

    /// The bug Android paid for.
    ///
    /// There a single `tracking_active` flag was written by the foreground
    /// service. When an OEM battery manager killed the service rather than
    /// letting it stop cleanly, the flag stayed true and the watchdog
    /// resurrected a session the driver had already ended. Splitting intent from
    /// observation makes that unrepresentable: the engine cannot write intent.
    @MainActor
    func testEngineStateCannotResurrectASessionTheDriverStopped() throws {
        storage.session.saveSession(
            sessionId: "sess-1", reference: "KH-1",
            policy: .default, shipment: SessionStore.Shipment()
        )
        storage.session.setTrackingIntent(true)
        storage.session.setEngineRunning(true)
        XCTAssertTrue(storage.session.snapshot().shouldBeTracking)
        XCTAssertNotNil(storage.session.snapshot().startedAt)

        // The driver stops. The engine is then killed without ever being told,
        // so it never gets to write `engineRunning = false`.
        storage.session.setTrackingIntent(false)
        XCTAssertFalse(storage.session.snapshot().shouldBeTracking)
        XCTAssertTrue(storage.session.snapshot().engineRunning, "stale, and deliberately not authoritative")
        XCTAssertNil(storage.session.snapshot().startedAt)

        // Whatever the engine says about itself, nothing restarts.
        storage.session.setEngineRunning(true)
        XCTAssertFalse(storage.session.snapshot().shouldBeTracking)
    }

    @MainActor
    func testIntentWithoutASessionIsNotTracking() {
        storage.session.setTrackingIntent(true)
        XCTAssertTrue(storage.session.trackingIntent)
        XCTAssertFalse(storage.session.snapshot().shouldBeTracking, "there is nothing to attribute fixes to")
    }

    /// Ending a session must not touch the buffer. Those points carry their own
    /// session id and the server has never seen them.
    @MainActor
    func testClearingASessionKeepsTheBufferTheSequenceAndTheDeviceId() throws {
        storage.session.saveSession(
            sessionId: "sess-1", reference: "KH-1", policy: .default,
            shipment: SessionStore.Shipment(orderNumber: "SIP-1")
        )
        storage.session.setTrackingIntent(true)
        let deviceId = storage.session.deviceId

        for index in 0..<4 {
            storage.points.append(BufferedPoint.Capture(
                sessionId: "sess-1",
                recordedAt: Date(timeIntervalSince1970: 1_700_000_000 + Double(index)),
                latitude: 37, longitude: 37
            ))
        }
        XCTAssertEqual(storage.session.deviceSeq, 4)

        storage.session.clearSession()

        let snapshot = storage.session.snapshot()
        XCTAssertNil(snapshot.sessionId)
        XCTAssertNil(snapshot.reference)
        XCTAssertTrue(snapshot.shipment.isEmpty)
        XCTAssertFalse(snapshot.trackingIntent)
        XCTAssertEqual(snapshot.deviceId, deviceId)

        XCTAssertEqual(storage.points.counts.total, 4, "unsent points outlive the session that made them")
        XCTAssertEqual(storage.session.deviceSeq, 4, "reusing sequence numbers would corrupt gap detection")
    }

    func testClockOffsetSurvivesAndCorrectsTheSignedTimestamp() {
        let twoHoursAhead = Int64(Date().timeIntervalSince1970) + 7200
        storage.session.recordServerTime(twoHoursAhead)

        XCTAssertEqual(Double(storage.session.clockOffsetMs) / 1000, 7200, accuracy: 2)
        XCTAssertEqual(
            storage.session.correctedNow().timeIntervalSince1970,
            Double(twoHoursAhead),
            accuracy: 2
        )
    }
}

// =============================================================================
//  ULID
// =============================================================================

final class ULIDGeneratorTests: XCTestCase {

    private let alphabet = CharacterSet(charactersIn: "0123456789ABCDEFGHJKMNPQRSTVWXYZ")

    func testIdsAreUniqueAndOrderedWithinTheSameMillisecond() {
        var generator = PointBuffer.ULIDGenerator()
        let instant = Date(timeIntervalSince1970: 1_700_000_000)

        let ids = (0..<2000).map { _ in generator.generate(at: instant) }
        XCTAssertEqual(Set(ids).count, ids.count, "a collision here is a silently dropped fix")
        XCTAssertEqual(ids, ids.sorted(), "monotonic inside a millisecond, so the sort key holds")
        XCTAssertTrue(ids.allSatisfy { $0.count == 26 })
    }

    func testIdsSortByTime() {
        var generator = PointBuffer.ULIDGenerator()
        let base = Date(timeIntervalSince1970: 1_700_000_000)
        let earlier = generator.generate(at: base)
        let later = generator.generate(at: base.addingTimeInterval(0.5))
        let muchLater = generator.generate(at: base.addingTimeInterval(86_400))

        // This ordering is what keeps a 8,600-point offline flush inserting at
        // the right edge of the server's index instead of scattered through it.
        XCTAssertLessThan(earlier, later)
        XCTAssertLessThan(later, muchLater)
    }

    func testOnlyCrockfordCharactersAreEmitted() {
        var generator = PointBuffer.ULIDGenerator()
        for _ in 0..<200 {
            let id = generator.generate()
            XCTAssertTrue(
                id.unicodeScalars.allSatisfy(alphabet.contains),
                "\(id) contains something outside Crockford Base32"
            )
        }
    }

    func testAnAbsurdClockStillProducesAUsableId() {
        var generator = PointBuffer.ULIDGenerator()
        // A phone whose clock is set to 1968 must still be able to record a
        // route; the server's length check (8..64) is all that has to hold.
        let id = generator.generate(at: Date(timeIntervalSince1970: -100_000))
        XCTAssertEqual(id.count, 26)
        XCTAssertTrue(id.unicodeScalars.allSatisfy(alphabet.contains))
    }
}
