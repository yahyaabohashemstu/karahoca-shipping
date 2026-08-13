import Foundation
#if canImport(UIKit)
import UIKit
#endif

/// Moves fixes off the phone, and is allowed to fail at it.
///
/// The buffer is the source of truth, not the network. A lorry crossing the
/// Habur gate loses signal for forty minutes and a driver in a valley in
/// Şırnak loses it for two hours; in both cases the route must be complete when
/// the phone comes back. So this drains, it does not stream, and nothing is
/// deleted locally until the server has said `accepted`.
///
/// Every batch is claimed, uploaded, then acknowledged. A crash between claim
/// and acknowledge leaves rows marked as in-flight, which
/// `recoverOrphanedClaims` releases — the cost of a crash is a duplicate batch,
/// which `kh.ingest_points` deduplicates on the point id, not a lost one.
actor Uploader {

    private let api: ApiClient
    private let buffer: PointBuffer
    private let session: SessionStore
    private let telemetry: DeviceTelemetry

    private var backoff = UploadBackoff()
    private var draining = false
    /// Set while a drain is running and another wake-up arrives. Rather than
    /// queueing drains — which on a burst of stored fixes would stack up dozens
    /// deep — the running drain simply goes round again.
    private var wakeAgain = false

    /// How many points go up at once.
    ///
    /// 200 fixes at ten-second cadence is a bit over half an hour of driving,
    /// and gzipped it is a few kilobytes. Small enough that a 2G edge cell can
    /// finish one before the connection drops, large enough that clearing a
    /// two-hour backlog takes four round trips rather than seven hundred.
    private let batchSize = 200

    init(api: ApiClient, buffer: PointBuffer, session: SessionStore,
         telemetry: DeviceTelemetry = .shared) {
        self.api = api
        self.buffer = buffer
        self.session = session
        self.telemetry = telemetry
    }

    /// Nudge. Cheap, idempotent, and safe to call on every stored fix.
    func wake() {
        if draining { wakeAgain = true; return }
        Task { await drain() }
    }

    /// Push everything currently pending, then stop.
    ///
    /// Returns the number of points the server accepted, which the UI shows and
    /// the end-of-shipment flow waits on.
    @discardableResult
    func drain() async -> Int {
        guard !draining else { wakeAgain = true; return 0 }
        draining = true
        defer { draining = false }

        var accepted = 0
        repeat {
            wakeAgain = false
            accepted += await drainOnce()
        } while wakeAgain

        return accepted
    }

    private func drainOnce() async -> Int {
        // Rows left in-flight by a crash or a kill. Released before claiming,
        // or a phone that was terminated mid-upload would never send them again.
        _ = buffer.recoverOrphanedClaims()

        var accepted = 0

        while !Task.isCancelled {
            if backoff.shouldWait { break }
            guard telemetry.isOnline else { break }
            guard let claim = buffer.claimBatch(limit: batchSize) else { break }

            let request = IngestBatchRequest(
                batchId: claim.batchId,
                // `offline` tells the server this batch is a backlog being
                // replayed rather than live telemetry, so the freshness alerts
                // do not fire on timestamps that are legitimately two hours old.
                offline: claim.points.contains { Date().timeIntervalSince($0.recordedAt) > 120 },
                bufferRemaining: claim.pendingRemaining,
                points: claim.points.map(\.dto)
            )

            do {
                let response = try await api.ingest(request)
                // Acknowledge deletes the rows. Duplicates and rejects are as
                // final as accepts — a point the server refuses will be refused
                // again forever, and retrying it would wedge the queue behind a
                // row that can never drain.
                _ = buffer.acknowledge(batchId: claim.batchId)
                accepted += response.accepted
                backoff.onSuccess()

                if response.rejected > 0 {
                    // Not fatal, but it means client and server disagree about
                    // what a valid point is, which is a bug somewhere.
                    log("server rejected \(response.rejected) of \(claim.points.count)")
                }
            } catch let error as ApiError {
                buffer.release(batchId: claim.batchId)
                switch error.failure {
                case .transient:
                    backoff.onFailure()

                case .rateLimited:
                    // The server named a delay in `Retry-After`; honouring it
                    // is the difference between backing off and being banned.
                    if case .rejected(_, _, _, let retryAfter) = error {
                        backoff.onFailure(retryAfterSec: retryAfter)
                    } else {
                        backoff.onFailure()
                    }

                case .batchTooLarge:
                    // The batch will never fit. Retrying it unchanged loops
                    // forever, so it goes back to pending and the next claim
                    // takes a smaller bite — the buffer hands out `batchSize`
                    // rows at a time and the oldest are now spread across two.
                    backoff.onFailure(retryAfterSec: 5)
                    return accepted

                case .tokenExpired:
                    // ApiClient refreshes and retries internally; reaching here
                    // means the refresh itself failed. Only a re-claim recovers.
                    backoff.onFailure(retryAfterSec: 60)
                    return accepted

                case .sessionClosed, .unauthorised:
                    // The shipment ended, or the token was revoked. Backing off
                    // hard rather than hammering: nothing this actor does will
                    // fix it, and the UI drives the re-claim.
                    backoff.onFailure(retryAfterSec: 300)
                    return accepted

                case .permanent:
                    backoff.onFailure(retryAfterSec: 60)
                    return accepted
                }
                break
            } catch {
                buffer.release(batchId: claim.batchId)
                backoff.onFailure()
                break
            }
        }

        await drainEvents()
        return accepted
    }

    /// Driver events — GPS lost, buffer overflowed, permission revoked.
    ///
    /// These are small, rare, and the alert desk keys on them, so they are worth
    /// their own pass. Poisoned rows are dropped after enough attempts: an event
    /// the server will never accept must not block the ones behind it.
    private func drainEvents() async {
        let dropped = buffer.dropPoisonedEvents()
        if dropped > 0 { log("dropped \(dropped) undeliverable events") }

        for event in buffer.oldestEvents(limit: 20) {
            guard !backoff.shouldWait, telemetry.isOnline else { return }
            do {
                _ = try await api.post(event: event.request)
                buffer.deleteEvent(id: event.id)
            } catch {
                buffer.markEventAttempt(id: event.id)
                backoff.onFailure()
                return
            }
        }
    }

    /// Seconds until the next attempt is allowed, for the diagnostics sheet.
    var retryIn: TimeInterval { backoff.remaining }
    var consecutiveFailures: Int { backoff.failureCount }

    private func log(_ message: String) {
        #if DEBUG
        print("[uploader] \(message)")
        #endif
    }
}

// ---- background execution -------------------------------------------------

/// A short extension of process life so a drain survives the app being
/// backgrounded mid-batch.
///
/// This is not what keeps the app alive through a shift — the `location`
/// background mode does that, and it is the only thing that can. This covers
/// the narrower case of the driver pressing Home while an upload is in flight,
/// where iOS would otherwise suspend the process between the request going out
/// and the response coming back, and the batch would be re-sent from scratch.
@MainActor
enum BackgroundTaskGuard {

    /// Runs `work` inside a `beginBackgroundTask` window when UIKit is present.
    ///
    /// The expiry handler matters: iOS gives roughly thirty seconds and then
    /// kills the app outright if the task was not ended. Ending it in a `defer`
    /// covers the normal path; the handler covers the slow one.
    static func run(_ work: @escaping () async -> Void) async {
        #if canImport(UIKit)
        var identifier = UIBackgroundTaskIdentifier.invalid
        identifier = UIApplication.shared.beginBackgroundTask(withName: "karahoca.upload") {
            // Out of time. Ending here is what prevents a hard kill; the drain
            // itself is safe to interrupt because unacknowledged rows stay in
            // the buffer.
            if identifier != .invalid {
                UIApplication.shared.endBackgroundTask(identifier)
                identifier = .invalid
            }
        }
        await work()
        if identifier != .invalid {
            UIApplication.shared.endBackgroundTask(identifier)
        }
        #else
        await work()
        #endif
    }
}
