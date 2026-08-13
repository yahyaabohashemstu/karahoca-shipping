import Foundation
import CoreLocation

/// The part of this app that has to work while nobody is looking at it.
///
/// A shipment from Gaziantep to Erbil is eighteen hours. For seventeen of them
/// the phone is face-down on the passenger seat with the screen off, and iOS is
/// under no obligation to keep an app alive in that state. Everything in this
/// file is arranged around one question: what does iOS *guarantee*, as opposed
/// to what it usually does?
///
/// The answer is narrow.
///
///  * `allowsBackgroundLocationUpdates` plus the `location` background mode
///    keeps the process alive while location updates are being delivered. This
///    is the guarantee the whole app rests on and it is real — but it is void
///    the moment updates stop, so the engine never stops them mid-shift.
///
///  * `pausesLocationUpdatesAutomatically` is the trap. iOS decides the device
///    has been stationary, pauses updates to save power, and — for a
///    standard-accuracy app — may never resume them. A lorry parked four hours
///    at the Habur border crossing is exactly the case it triggers on, and the
///    consequence is a driver who arrives in Erbil having transmitted nothing
///    since Turkey. It is switched off, permanently, and the idle heartbeat in
///    `CadenceGate` is what replaces it.
///
///  * Significant-location-change is the fallback, not the primary. It is
///    kilometres-coarse and minutes-late, which is useless for a dispatcher
///    watching a delivery window, but it is the only thing that relaunches a
///    terminated app. It runs alongside, as a resurrection trigger.
///
/// Cadence is not delegated to `distanceFilter`. iOS delivers fixes on its own
/// schedule regardless, so the `CadenceGate` — the same pure, tested rule the
/// Android app uses — is the single arbiter of what gets stored.
@MainActor
final class LocationEngine: NSObject, ObservableObject {

    /// What the UI needs to know, and nothing it does not.
    struct State: Equatable {
        var authorisation: CLAuthorizationStatus = .notDetermined
        var isTracking = false
        var servicesEnabled = true
        var accuracyIsReduced = false
        var lastFixAt: Date?
        var lastFix: CLLocationCoordinate2D?
        var fixesStored = 0
        /// Fixes iOS delivered that the gate or the filter threw away. Shown in
        /// the diagnostics sheet: a driver whose "stored" count is stuck while
        /// this one climbs has a GPS problem, not an app problem, and the two
        /// need different phone calls.
        var fixesRejected = 0

        static func == (a: State, b: State) -> Bool {
            a.authorisation == b.authorisation
                && a.isTracking == b.isTracking
                && a.servicesEnabled == b.servicesEnabled
                && a.accuracyIsReduced == b.accuracyIsReduced
                && a.lastFixAt == b.lastFixAt
                && a.fixesStored == b.fixesStored
                && a.fixesRejected == b.fixesRejected
                && a.lastFix?.latitude == b.lastFix?.latitude
                && a.lastFix?.longitude == b.lastFix?.longitude
        }
    }

    @Published private(set) var state = State()

    private let manager: CLLocationManager
    private let buffer: PointBuffer
    private let session: SessionStore
    private let telemetry: DeviceTelemetry

    private var gate = CadenceGate()
    private var lastAccepted: CLLocation?

    /// Raised after a gap in fixes, cleared on the next one. Drives the
    /// `GPS_LOST` / `GPS_RECOVERED` events the dispatcher's alert desk keys on.
    private var gpsLost = false
    private var watchdog: Task<Void, Never>?

    /// Called when a fix is stored, so the uploader can wake up rather than
    /// poll. Set by `TrackerCoordinator`.
    var onPointStored: (() -> Void)?
    var onEvent: ((DriverEvent, String?) -> Void)?

    init(
        buffer: PointBuffer,
        session: SessionStore,
        telemetry: DeviceTelemetry = .shared,
        manager: CLLocationManager = CLLocationManager()
    ) {
        self.manager = manager
        self.buffer = buffer
        self.session = session
        self.telemetry = telemetry
        super.init()

        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBestForNavigation
        // Not the cadence control — see the class comment. Set to the smallest
        // value that is not `kCLDistanceFilterNone`, so a stationary lorry does
        // not spin the radio at 1 Hz while the gate discards every fix, but
        // small enough that the gate still sees everything that matters.
        manager.distanceFilter = 5
        manager.activityType = .automotiveNavigation
        manager.pausesLocationUpdatesAutomatically = false
        state.authorisation = manager.authorizationStatus
        state.accuracyIsReduced = manager.accuracyAuthorization == .reducedAccuracy
    }

    // ---- permissions -----------------------------------------------------

    /// Two-step, in the order iOS requires.
    ///
    /// Asking for `always` from a cold start gets the driver a dialog with no
    /// "Always" button — iOS only offers the upgrade after `whenInUse` has been
    /// granted and the app has actually used it. Asking in the wrong order
    /// burns the one prompt the system will ever show, and from then on the only
    /// route is Settings, which for a driver in a cab is the same as broken.
    func requestPermission() {
        switch manager.authorizationStatus {
        case .notDetermined:
            manager.requestWhenInUseAuthorization()
        case .authorizedWhenInUse:
            manager.requestAlwaysAuthorization()
        default:
            break
        }
    }

    /// True when the app can record through a whole shift unattended.
    var canTrackInBackground: Bool {
        manager.authorizationStatus == .authorizedAlways
    }

    /// Granted, but only well enough to say which city. Precise Location has
    /// been switched off for this app, and a route drawn from it would be a
    /// smear rather than a road.
    var needsPreciseAccuracy: Bool {
        manager.accuracyAuthorization == .reducedAccuracy
    }

    /// One-shot upgrade request for the current session, which iOS grants
    /// without sending the driver to Settings. The purpose string is the
    /// `NSLocationTemporaryUsageDescriptionDictionary` key in Info.plist.
    func requestTemporaryPrecision() {
        guard manager.accuracyAuthorization == .reducedAccuracy else { return }
        manager.requestTemporaryFullAccuracyAuthorization(
            withPurposeKey: "PreciseTrackingRequired"
        )
    }

    // ---- lifecycle -------------------------------------------------------

    func start() {
        guard session.sessionId != nil else { return }
        guard manager.authorizationStatus == .authorizedAlways
                || manager.authorizationStatus == .authorizedWhenInUse else {
            requestPermission()
            return
        }

        // Only legal with the `location` background mode and `always`. Setting
        // it under `whenInUse` throws; guarded rather than assumed.
        manager.allowsBackgroundLocationUpdates =
            manager.authorizationStatus == .authorizedAlways

        // The blue bar. Deliberately shown: the drivers are subcontractors, not
        // employees, and a tracker that hides itself from the person carrying it
        // is a different product from the one that was agreed to.
        manager.showsBackgroundLocationIndicator = true

        gate.reset()
        lastAccepted = nil
        manager.startUpdatingLocation()

        // The resurrection trigger. If iOS kills the process — memory pressure,
        // a reboot in a lay-by — this is what relaunches it, and
        // `didUpdateLocations` on the fresh instance restarts the real stream.
        manager.startMonitoringSignificantLocationChanges()

        state.isTracking = true
        startWatchdog()
    }

    /// Pause, keeping the session. The lighter of the two stops.
    func pause() {
        manager.stopUpdatingLocation()
        // Significant-change monitoring stays on. A paused driver who resumes
        // twenty kilometres later should relaunch the app, not vanish.
        watchdog?.cancel()
        watchdog = nil
        state.isTracking = false
    }

    /// Full stop, at the end of a shipment.
    func stop() {
        manager.stopUpdatingLocation()
        manager.stopMonitoringSignificantLocationChanges()
        if manager.allowsBackgroundLocationUpdates {
            manager.allowsBackgroundLocationUpdates = false
        }
        watchdog?.cancel()
        watchdog = nil
        gate.reset()
        lastAccepted = nil
        state.isTracking = false
    }

    // ---- the silence watchdog -------------------------------------------

    /// iOS can go quiet without telling anyone: a tunnel, a dead antenna, or a
    /// pause the system applied despite being asked not to. Nothing in
    /// CoreLocation calls back to say "no fixes are coming". This notices.
    private func startWatchdog() {
        watchdog?.cancel()
        watchdog = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 30 * 1_000_000_000)
                guard let self, self.state.isTracking else { return }
                self.checkForSilence()
            }
        }
    }

    private func checkForSilence() {
        // Three missed heartbeats. Two would fire on an ordinary tunnel.
        let tolerance = max(session.policy.idleIntervalSec * 3, 90)
        let last = state.lastFixAt ?? Date.distantPast
        let quiet = Date().timeIntervalSince(last) > tolerance

        if quiet && !gpsLost {
            gpsLost = true
            onEvent?(.gpsLost, "No fix for \(Int(Date().timeIntervalSince(last)))s")
            // A restart is the only lever an app has here, and it is a real one:
            // it clears a stuck delegate and re-arms a stream iOS quietly paused.
            manager.stopUpdatingLocation()
            manager.startUpdatingLocation()
        }
    }
}

// ---- CLLocationManagerDelegate -------------------------------------------

extension LocationEngine: CLLocationManagerDelegate {

    nonisolated func locationManager(
        _ manager: CLLocationManager,
        didChangeAuthorization status: CLAuthorizationStatus
    ) {
        Task { @MainActor in self.authorisationChanged(status) }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        let reduced = manager.accuracyAuthorization == .reducedAccuracy
        Task { @MainActor in
            self.state.accuracyIsReduced = reduced
            self.authorisationChanged(status)
        }
    }

    @MainActor
    private func authorisationChanged(_ status: CLAuthorizationStatus) {
        let previous = state.authorisation
        state.authorisation = status

        switch status {
        case .authorizedAlways:
            // The upgrade the driver was asked for. If a session is live but
            // tracking stalled waiting for this, start now.
            if session.sessionId != nil && !state.isTracking { start() }

        case .authorizedWhenInUse:
            // Enough to record while the screen is on, which is better than
            // nothing, but the shift will not survive a locked phone. The UI
            // surfaces this; the engine records what it can.
            if session.sessionId != nil && !state.isTracking { start() }

        case .denied, .restricted:
            // The one case where a driver silently stops being tracked mid-run.
            // The server must hear about it, because from the dispatcher's side
            // it is indistinguishable from a phone in a ditch.
            if previous == .authorizedAlways || previous == .authorizedWhenInUse {
                onEvent?(.permissionRevoked, "Authorisation changed to \(status.rawValue)")
            }
            state.isTracking = false

        default:
            break
        }
    }

    nonisolated func locationManager(
        _ manager: CLLocationManager,
        didUpdateLocations locations: [CLLocation]
    ) {
        // iOS batches deferred fixes and hands them over oldest-first. All of
        // them are real and all of them belong in the route.
        Task { @MainActor in self.ingest(locations) }
    }

    @MainActor
    private func ingest(_ locations: [CLLocation]) {
        if gpsLost {
            gpsLost = false
            onEvent?(.gpsRecovered, nil)
        }

        let policy = session.policy
        var stored = 0

        for location in locations.sorted(by: { $0.timestamp < $1.timestamp }) {
            state.lastFixAt = Date()
            state.lastFix = location.coordinate

            guard FixFilter.isPlausible(location, after: lastAccepted) else {
                state.fixesRejected += 1
                continue
            }
            lastAccepted = location

            // Uptime, not wall-clock: a phone that corrects its clock over NTP
            // at a border must not appear to jump backwards, which would wedge
            // the gate shut until real time caught up.
            guard gate.shouldStore(
                location, policy: policy, now: ProcessInfo.processInfo.systemUptime
            ) else {
                state.fixesRejected += 1
                continue
            }

            let capture = BufferedPoint.Capture(
                location: location,
                sessionId: session.sessionId ?? "",
                batteryPct: telemetry.batteryPct,
                isCharging: telemetry.isCharging,
                networkType: telemetry.networkType
            )
            var marked = capture
            marked.isMock = telemetry.isMock(location)

            switch buffer.append(marked) {
            case .stored(_, _, let evicted):
                stored += 1
                if evicted > 0 {
                    // The ring buffer ate the oldest fixes to make room. The
                    // route now has a hole in it, and the dispatcher should
                    // learn that from an event rather than from a gap on a map.
                    onEvent?(.bufferOverflow, "Evicted \(evicted) oldest points")
                }
            case .noSession:
                // The session ended between the fix arriving and it being
                // filed. Nothing to attribute it to; dropping it is correct.
                return
            case .duplicate:
                // Two fixes with the same ULID: iOS redelivered one. Already
                // recorded, so this is success, not loss.
                break
            case .failed(let reason):
                state.fixesRejected += 1
                onEvent?(.bufferOverflow, "Write failed: \(reason)")
            }
        }

        if stored > 0 {
            state.fixesStored += stored
            onPointStored?()
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        let code = (error as? CLError)?.code
        Task { @MainActor in
            switch code {
            case .denied:
                // Location Services switched off device-wide, or authorisation
                // pulled. `didChangeAuthorization` covers the second; this
                // covers the first, which fires no authorisation callback.
                self.state.servicesEnabled = false
                self.state.isTracking = false
                self.onEvent?(.permissionRevoked, "Location services disabled")
            case .locationUnknown:
                // Transient and normal: iOS could not get a fix *yet*. Not an
                // error to act on, and specifically not one to stop tracking
                // for — the watchdog handles a persistent version of it.
                break
            default:
                break
            }
        }
    }
}
