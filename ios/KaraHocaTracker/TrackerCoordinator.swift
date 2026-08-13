import Foundation
import SwiftUI
import CoreLocation
#if canImport(UIKit)
import UIKit
#endif

/// The one object that owns the others, and the only place their order matters.
///
/// Storage opens first because everything else needs it. The engine and the
/// uploader are wired to each other by callback rather than by reference, so
/// neither can call into the other's internals. And crucially, tracking resumes
/// from persisted intent rather than from anything held in memory: iOS will
/// terminate this app mid-shift and relaunch it from a significant-location
/// change, and on that launch the only thing that knows a lorry is on the road
/// is the database.
@MainActor
final class TrackerCoordinator: ObservableObject {

    /// Everything a screen can be in. One enum rather than a handful of
    /// booleans, because "claiming" and "tracking" and "failed" are mutually
    /// exclusive and representing them separately invites a state that is two
    /// of them at once.
    enum Screen: Equatable {
        case loading
        case claim
        case tracking
    }

    @Published private(set) var screen: Screen = .loading
    @Published private(set) var snapshot: SessionStore.Snapshot = .empty
    @Published private(set) var pending: PointBuffer.Counts?
    @Published private(set) var lastSyncAt: Date?
    @Published private(set) var claimError: String?
    @Published private(set) var isClaiming = false
    @Published private(set) var isStopping = false

    /// Prefilled from a QR scan or a deep link, consumed by the claim screen.
    ///
    /// Published rather than a plain field, and that is load-bearing: a stored
    /// property mutated from `onOpenURL` while the claim view is already on
    /// screen produces no redraw, and the code silently fails to appear. This
    /// is the exact bug that shipped in the Android app and had to be fixed
    /// after the fact — see `MainActivity.pendingDeepLinkCode`.
    @Published var pendingCode: String?

    let engine: LocationEngine
    let storage: TrackerStorage
    private let api: ApiClient
    private let credentials: CredentialStore
    private let uploader: Uploader
    private let telemetry: DeviceTelemetry

    private var ticker: Task<Void, Never>?

    init(storage: TrackerStorage,
         credentials: CredentialStore,
         api: ApiClient,
         telemetry: DeviceTelemetry = .shared) {
        self.storage = storage
        self.credentials = credentials
        self.api = api
        self.telemetry = telemetry
        self.uploader = Uploader(api: api, buffer: storage.points, session: storage.session)
        self.engine = LocationEngine(buffer: storage.points, session: storage.session)

        engine.onPointStored = { [weak self] in
            guard let self else { return }
            self.storage.session.markFix(at: Date())
            Task { await self.uploader.wake() }
        }
        engine.onEvent = { [weak self] event, message in
            self?.record(event, message: message)
        }
    }

    /// Build the whole stack. Failing here is fatal and says so, rather than
    /// limping on with a half-open database that loses a shift's fixes.
    static func makeDefault() throws -> TrackerCoordinator {
        let storage = try TrackerStorage.open()
        let credentials = CredentialStore()
        let api = ApiClient(credentials: credentials)
        return TrackerCoordinator(storage: storage, credentials: credentials, api: api)
    }

    // ---- launch ----------------------------------------------------------

    /// Called once, at launch — including the launches iOS performs on its own
    /// after terminating the app.
    func start() async {
        refresh()

        let hasSession = storage.session.sessionId != nil
        let hasCredentials = await credentials.hasSession

        // A session in the database with no key in the keychain, or the
        // reverse. Reinstalling the app clears one and not the other, and a
        // half-claimed state that looks live but cannot upload is worse than a
        // clean claim screen.
        if hasSession != hasCredentials {
            await endLocally()
            screen = .claim
            return
        }

        screen = hasSession ? .tracking : .claim

        if storage.session.snapshot().shouldBeTracking {
            // The relaunch path. Intent survived the process; the engine did
            // not, so it is started from scratch here.
            engine.start()
            storage.session.setEngineRunning(engine.state.isTracking)
        }

        startTicker()
        await BackgroundTaskGuard.run { [uploader] in _ = await uploader.drain() }
        refresh()
    }

    // ---- claiming --------------------------------------------------------

    func claim(code raw: String) async {
        let code = ClaimCode.normalise(raw)
        guard code.count == ClaimCode.length else {
            claimError = "Kod 8 karakter olmalı."
            return
        }

        isClaiming = true
        claimError = nil
        defer { isClaiming = false }

        let info = telemetry.describe(
            deviceId: await credentials.deviceId(),
            hasBackgroundLocation: engine.canTrackInBackground
        )

        do {
            let response = try await api.claim(code: code, device: info)
            try await credentials.save(claim: response)

            storage.session.saveSession(
                sessionId: response.sessionId,
                reference: response.reference,
                policy: response.policy.resolved,
                shipment: SessionStore.Shipment(
                    orderNumber: response.shipment.orderNumber,
                    customerName: response.shipment.customerName,
                    destination: response.shipment.destinationLabel
                        ?? response.shipment.destinationAddress,
                    cargoSummary: response.shipment.cargoSummary
                )
            )
            storage.session.recordServerTime(Int64(response.serverTime))
            storage.session.setTrackingIntent(true)

            pendingCode = nil
            screen = .tracking
            record(.started, message: nil)

            engine.start()
            storage.session.setEngineRunning(engine.state.isTracking)
            startTicker()
            refresh()

        } catch let error as ApiError {
            claimError = Self.message(for: error)
        } catch {
            claimError = "Bağlantı kurulamadı. Tekrar deneyin."
        }
    }

    // ---- during the shift ------------------------------------------------

    func pause() {
        engine.pause()
        storage.session.setTrackingIntent(false)
        storage.session.setEngineRunning(false)
        record(.paused, message: nil)
        refresh()
    }

    func resume() {
        storage.session.setTrackingIntent(true)
        engine.start()
        storage.session.setEngineRunning(engine.state.isTracking)
        record(.resumed, message: nil)
        refresh()
    }

    /// End the shipment.
    ///
    /// The order is deliberate and it is the part most likely to be got wrong.
    /// The engine stops first so no new fixes arrive mid-drain; the buffer is
    /// drained *before* the server is told the session is over, because a
    /// closed session rejects ingest and the last twenty minutes of the route —
    /// the part covering the actual delivery — would be lost. Local state is
    /// cleared last, and only if the drain left nothing behind.
    func stop() async {
        isStopping = true
        defer { isStopping = false }

        engine.stop()
        storage.session.setTrackingIntent(false)
        storage.session.setEngineRunning(false)

        await BackgroundTaskGuard.run { [uploader] in _ = await uploader.drain() }
        refresh()

        let leftover = storage.points.counts
        if leftover.pending > 0 {
            // Refuse to close. The driver sees "N points still to send" and the
            // session stays live until the phone finds signal — which is the
            // right answer at a border crossing, where "finish" is pressed
            // exactly where there is no coverage.
            claimError = "\(leftover.pending) konum henüz gönderilmedi. Şebeke gelince tekrar deneyin."
            return
        }

        _ = try? await api.stop()
        await endLocally()
        screen = .claim
        refresh()
    }

    /// Tear down everything local. Used by `stop`, and by the mismatch check at
    /// launch.
    private func endLocally() async {
        engine.stop()
        if let sessionId = storage.session.sessionId {
            _ = storage.points.deleteSession(sessionId)
        }
        storage.session.clearSession()
        await credentials.clear()
        claimError = nil
    }

    /// Push whatever is pending, on demand. Wired to pull-to-refresh and to
    /// returning from the background.
    func syncNow() async {
        await BackgroundTaskGuard.run { [uploader] in _ = await uploader.drain() }
        storage.session.markSynced()
        refresh()
    }

    // ---- deep links ------------------------------------------------------

    /// A Universal Link from the QR, or the custom scheme from an SMS.
    ///
    /// Guarded on `screen`: a link arriving while a shipment is already live
    /// must not silently re-claim under a different session, which would strand
    /// whatever is still in the buffer.
    func handle(url: URL) {
        guard let code = ClaimCode.fromLink(
            url, host: ApiClient.linkHost, scheme: ApiClient.linkScheme
        ) else { return }
        guard screen != .tracking else { return }
        pendingCode = code
    }

    // ---- plumbing --------------------------------------------------------

    private func record(_ event: DriverEvent, message: String?) {
        guard let sessionId = storage.session.sessionId else { return }
        _ = storage.points.recordEvent(
            sessionId: sessionId, type: event.rawValue, message: message
        )
        Task { await uploader.wake() }
    }

    /// Pull fresh counts out of storage into the published state.
    ///
    /// The buffer is not observable — it is a `@unchecked Sendable` class behind
    /// a serial queue, deliberately, because making it observable would drag
    /// SwiftUI's main-actor requirements into a code path that runs from a
    /// CoreLocation delegate on a background thread. Polling it from here is
    /// the boring, correct alternative.
    private func refresh() {
        snapshot = storage.session.snapshot()
        pending = storage.points.counts
        lastSyncAt = snapshot.lastSyncAt
    }

    /// One second while the app is in front, so the pending count and the
    /// "last fix" age move. Cancelled on background: a timer that keeps firing
    /// behind a locked screen buys nothing and costs battery on a phone that
    /// has to last eighteen hours.
    private func startTicker() {
        ticker?.cancel()
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                guard let self else { return }
                self.refresh()
            }
        }
    }

    func enterBackground() {
        ticker?.cancel()
        ticker = nil
        // One last push. The window is short and the drain may not finish, but
        // an unfinished drain costs nothing — the rows are still pending.
        Task { await BackgroundTaskGuard.run { [uploader] in _ = await uploader.drain() } }
    }

    func enterForeground() {
        startTicker()
        refresh()
        Task { await syncNow() }
    }

    // ---- errors ----------------------------------------------------------

    /// Turkish, because the driver reads it, and specific, because "hata"
    /// tells a dispatcher on the phone nothing about what to try next.
    private static func message(for error: ApiError) -> String {
        switch error.failure {
        case .unauthorised, .sessionClosed:
            return "Bu kod artık geçerli değil. Sevkiyat sorumlusundan yeni kod isteyin."
        case .rateLimited:
            return "Çok fazla deneme yapıldı. Bir dakika bekleyin."
        case .transient:
            return "Bağlantı yok. Şebekeyi kontrol edip tekrar deneyin."
        case .tokenExpired, .permanent, .batchTooLarge:
            if case .rejected(_, _, let message, _) = error, let message, !message.isEmpty {
                return message
            }
            return "Kod kabul edilmedi. Kodu kontrol edin."
        }
    }
}
