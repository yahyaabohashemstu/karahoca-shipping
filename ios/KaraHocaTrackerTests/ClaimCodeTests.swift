import XCTest
import CoreLocation
@testable import KaraHocaTracker

/// The same suite the Android app runs, ported case for case.
///
/// These two implementations have to agree with each other and with
/// `kh.normalize_claim_code`. Testing them from one shared list of cases is the
/// only thing that keeps three implementations of the same rule from drifting.
final class ClaimCodeTests: XCTestCase {

    private let host = "track.karahoca.com"
    private let scheme = "karahoca"

    func testStripsSeparatorsAndUppercases() {
        XCTAssertEqual(ClaimCode.normalise("k7h2-9qx4"), "K7H29QX4")
        XCTAssertEqual(ClaimCode.normalise("k7h2 9qx4"), "K7H29QX4")
        XCTAssertEqual(ClaimCode.normalise(" K7H2 - 9QX4 "), "K7H29QX4")
    }

    func testFoldsTheCrockfordAliases() {
        // I, L and U are not in the alphabet; a driver reading a printed code
        // will still type them.
        XCTAssertEqual(ClaimCode.normalise("ILUO1234"), "11101234")
    }

    func testCapsAtTheCodeLength() {
        XCTAssertEqual(ClaimCode.normalise("K7H29QX4EXTRA"), "K7H29QX4")
        // The cap counts stored characters, not typed ones: a long run of
        // separators must not eat into it.
        XCTAssertEqual(ClaimCode.normalise("K-7-H-2-9-Q-X-4-9"), "K7H29QX4")
    }

    func testHandlesEmptyAndNil() {
        XCTAssertEqual(ClaimCode.normalise(""), "")
        XCTAssertEqual(ClaimCode.normalise(nil), "")
        XCTAssertEqual(ClaimCode.normalise("----"), "")
    }

    /// The regression this fleet is most exposed to.
    ///
    /// Every driver phone is set to Turkish, where the locale-aware uppercase
    /// of `i` is `İ` (U+0130) — not a Latin I, not in the alphabet, silently
    /// dropped. Swift's `uppercased()` happens to be locale-independent, but
    /// `localizedUppercase` is not and the two are one careless edit apart, so
    /// the folding is explicit and this test pins it.
    func testDottedCapitalIsNeverProduced() {
        XCTAssertEqual(ClaimCode.normalise("i234567"), "1234567")
        XCTAssertEqual(ClaimCode.normalise("i234567").count, 7)
        // And the same string through the locale-aware path, to show what the
        // explicit folding is protecting against.
        let turkish = Locale(identifier: "tr_TR")
        XCTAssertEqual("i".uppercased(with: turkish), "İ")
    }

    func testNonAsciiIsDropped() {
        // Turkish letters a driver might fat-finger, and Arabic-Indic digits.
        XCTAssertEqual(ClaimCode.normalise("Kş7H2ğ9QX4"), "K7H29QX4")
        XCTAssertEqual(ClaimCode.normalise("١٢٣"), "")
    }

    // ---- pretty --------------------------------------------------------

    func testPrettyInsertsOneDashAfterTheFourth() {
        XCTAssertEqual(ClaimCode.pretty("K7H29QX4"), "K7H2-9QX4")
        XCTAssertEqual(ClaimCode.pretty("K7H29"), "K7H2-9")
        XCTAssertEqual(ClaimCode.pretty("K7H2"), "K7H2")
        XCTAssertEqual(ClaimCode.pretty("K7H"), "K7H")
        XCTAssertEqual(ClaimCode.pretty(""), "")
    }

    // ---- fromLink ------------------------------------------------------

    private func code(_ s: String) -> String? {
        ClaimCode.fromLink(URL(string: s), host: host, scheme: scheme)
    }

    func testReadsTheUniversalLinkTheQrEncodes() {
        XCTAssertEqual(code("https://\(host)/t/K7H29QX4"), "K7H29QX4")
        XCTAssertEqual(code("https://\(host)/t/k7h2-9qx4"), "K7H29QX4")
        // A trailing slash must not read as an empty ninth character.
        XCTAssertEqual(code("https://\(host)/t/K7H29QX4/"), "K7H29QX4")
    }

    func testReadsTheCustomSchemeFallback() {
        XCTAssertEqual(code("\(scheme)://track?c=K7H29QX4"), "K7H29QX4")
        XCTAssertEqual(code("\(scheme)://track?c=k7h2-9qx4"), "K7H29QX4")
    }

    func testQueryParameterWinsOverPath() {
        XCTAssertEqual(code("https://\(host)/t/?c=AAAA1111"), "AAAA1111")
    }

    func testRejectsAnotherHost() {
        XCTAssertNil(code("https://evil.example.com/t/K7H29QX4"))
    }

    func testRejectsAnythingThatIsNotACompleteCode() {
        XCTAssertNil(code("https://\(host)/t/K7H2"))
        XCTAssertNil(code("https://\(host)/"))
        XCTAssertNil(code("https://\(host)/sessions/K7H29QX4"))
        XCTAssertNil(code("\(scheme)://track"))
        XCTAssertNil(code("mailto:driver@example.com"))
        XCTAssertNil(ClaimCode.fromLink(nil, host: host, scheme: scheme))
    }
}

/// The cadence gate, which decides what the map is made of.
final class CadenceGateTests: XCTestCase {

    private func fix(_ lat: Double, _ lon: Double, accuracy: CLLocationAccuracy = 5,
                     at seconds: TimeInterval = 0) -> CLLocation {
        CLLocation(
            coordinate: CLLocationCoordinate2D(latitude: lat, longitude: lon),
            altitude: 0, horizontalAccuracy: accuracy, verticalAccuracy: 5,
            timestamp: Date(timeIntervalSince1970: seconds)
        )
    }

    func testPolicyIsClampedToWhatTheDatabaseAccepts() {
        // Migration 0007: ping 2-3600, idle 5-14400, distance 0-20000, and
        // idle >= ping. A policy the phone holds must be one the server would
        // have stored.
        let absurd = TrackingPolicy(pingIntervalSec: 0, idleIntervalSec: 1, minDistanceM: -50)
        XCTAssertEqual(absurd.pingIntervalSec, 2)
        XCTAssertGreaterThanOrEqual(absurd.idleIntervalSec, absurd.pingIntervalSec)
        XCTAssertEqual(absurd.minDistanceM, 0)

        let huge = TrackingPolicy(pingIntervalSec: 99999, idleIntervalSec: 99999, minDistanceM: 99999)
        XCTAssertEqual(huge.pingIntervalSec, 3600)
        XCTAssertEqual(huge.idleIntervalSec, 14400)
        XCTAssertEqual(huge.minDistanceM, 20000)
    }

    func testFirstFixIsAlwaysStored() {
        var gate = CadenceGate()
        XCTAssertTrue(gate.shouldStore(fix(36.9, 37.1), policy: .default, now: 0))
    }

    func testTimeTriggeredHonoursTheInterval() {
        var gate = CadenceGate()
        let p = TrackingPolicy(pingIntervalSec: 10, idleIntervalSec: 60, minDistanceM: 0)
        XCTAssertTrue(gate.shouldStore(fix(36.9, 37.1), policy: p, now: 0))
        // iOS delivers faster than asked; the gate is what enforces cadence.
        XCTAssertFalse(gate.shouldStore(fix(36.9001, 37.1), policy: p, now: 4))
        XCTAssertFalse(gate.shouldStore(fix(36.9002, 37.1), policy: p, now: 9.9))
        XCTAssertTrue(gate.shouldStore(fix(36.9003, 37.1), policy: p, now: 10))
    }

    func testDistanceTriggeredStoresOnDistance() {
        var gate = CadenceGate()
        let p = TrackingPolicy(pingIntervalSec: 5, idleIntervalSec: 600, minDistanceM: 100)
        XCTAssertTrue(gate.shouldStore(fix(36.9, 37.1), policy: p, now: 0))
        // ~11 m north: under the trigger, and the idle heartbeat is far off.
        XCTAssertFalse(gate.shouldStore(fix(36.9001, 37.1), policy: p, now: 30))
        // ~111 m north: over it.
        XCTAssertTrue(gate.shouldStore(fix(36.901, 37.1), policy: p, now: 60))
    }

    func testStationaryTruckStillHeartbeats() {
        var gate = CadenceGate()
        let p = TrackingPolicy(pingIntervalSec: 5, idleIntervalSec: 60, minDistanceM: 100)
        XCTAssertTrue(gate.shouldStore(fix(36.9, 37.1), policy: p, now: 0))
        XCTAssertFalse(gate.shouldStore(fix(36.9, 37.1), policy: p, now: 59))
        // A parked truck must keep proving it is parked. Silence is
        // indistinguishable from a dead phone, and the server raises a CRITICAL
        // alert for it.
        XCTAssertTrue(gate.shouldStore(fix(36.9, 37.1), policy: p, now: 60))
    }

    func testResetMakesTheNextFixUnconditional() {
        var gate = CadenceGate()
        let p = TrackingPolicy(pingIntervalSec: 600, idleIntervalSec: 600, minDistanceM: 0)
        XCTAssertTrue(gate.shouldStore(fix(36.9, 37.1), policy: p, now: 0))
        XCTAssertFalse(gate.shouldStore(fix(36.9, 37.1), policy: p, now: 5))
        gate.reset()
        // The far side of an overnight stop is a new start, not a continuation.
        XCTAssertTrue(gate.shouldStore(fix(36.9, 37.1), policy: p, now: 6))
    }
}

/// Fixes that must never reach the buffer, let alone the upload.
final class FixFilterTests: XCTestCase {

    private func fix(_ lat: Double, _ lon: Double, accuracy: CLLocationAccuracy,
                     at seconds: TimeInterval) -> CLLocation {
        CLLocation(
            coordinate: CLLocationCoordinate2D(latitude: lat, longitude: lon),
            altitude: 0, horizontalAccuracy: accuracy, verticalAccuracy: 5,
            timestamp: Date(timeIntervalSince1970: seconds)
        )
    }

    func testRejectsInvalidAndCoarseFixes() {
        // CoreLocation signals an invalid fix with a negative accuracy.
        XCTAssertFalse(FixFilter.isPlausible(fix(36.9, 37.1, accuracy: -1, at: 0), after: nil))
        // A kilometre of uncertainty says nothing about which road this is.
        XCTAssertFalse(FixFilter.isPlausible(fix(36.9, 37.1, accuracy: 1200, at: 0), after: nil))
        XCTAssertTrue(FixFilter.isPlausible(fix(36.9, 37.1, accuracy: 12, at: 0), after: nil))
    }

    func testRejectsTeleports() {
        let previous = fix(36.9, 37.1, accuracy: 8, at: 0)
        // ~111 km in ten seconds. A cell estimate colliding with a satellite
        // lock, and it would draw a line across the country.
        XCTAssertFalse(FixFilter.isPlausible(fix(37.9, 37.1, accuracy: 8, at: 10), after: previous))
        // ~1.1 km in a minute is 66 km/h — an ordinary lorry.
        XCTAssertTrue(FixFilter.isPlausible(fix(36.91, 37.1, accuracy: 8, at: 60), after: previous))
    }

    func testRejectsOutOfOrderFixes() {
        let previous = fix(36.9, 37.1, accuracy: 8, at: 100)
        // Same timestamp would be a division by zero; earlier is a backfill
        // arriving through the live path, which the buffer handles separately.
        XCTAssertFalse(FixFilter.isPlausible(fix(36.91, 37.1, accuracy: 8, at: 100), after: previous))
        XCTAssertFalse(FixFilter.isPlausible(fix(36.91, 37.1, accuracy: 8, at: 90), after: previous))
    }
}
