import Foundation

/// The seam between what the phone stores and what the wire carries.
///
/// Kept in one file, apart from both, because it is the thing most likely to
/// drift: the buffer schema changes when the app needs a new field, the DTO
/// changes when the API does, and a mismatch between them is silent — a field
/// that stops being sent does not fail to compile, it just stops arriving, and
/// the first sign is a column of nulls in production three weeks later.
extension BufferedPoint {

    /// Wire form.
    ///
    /// `recordedAt` goes out as epoch milliseconds because that is what
    /// `kh.ingest_points` expects and what the Android app sends; a formatted
    /// string here would be a second parser to keep in agreement, and an
    /// ambiguity about time zones that this fleet — crossing three of them —
    /// cannot afford.
    var dto: LocationPointDto {
        LocationPointDto(
            id: id,
            recordedAt: Int64((recordedAt.timeIntervalSince1970 * 1000).rounded()),
            lat: latitude,
            lon: longitude,
            accuracy: accuracyM,
            altitude: altitudeM,
            verticalAccuracy: verticalAccuracyM,
            speed: speedMps,
            speedAccuracy: speedAccuracyMps,
            bearing: bearingDeg,
            // The counterpart to Android's `SystemClock.elapsedRealtimeNs`.
            // The server uses it to order points that share a wall-clock
            // millisecond and to detect a phone whose clock was corrected
            // mid-shift.
            elapsedRealtimeNs: monotonicNs,
            batteryPct: batteryPct,
            isCharging: isCharging,
            isMock: isMock,
            satellites: satellites,
            provider: provider,
            networkType: networkType,
            seq: deviceSeq
        )
    }
}

extension PointBuffer.Event {

    /// Wire form.
    ///
    /// `occurredAt` is ISO 8601 here rather than epoch millis, because that is
    /// what the events endpoint takes — the two endpoints disagree, and this is
    /// the place that knows it.
    var request: DriverEventRequest {
        DriverEventRequest(
            type: type,
            occurredAt: ISO8601.string(from: occurredAt),
            message: message,
            payload: Self.decodePayload(payloadJSON)
        )
    }

    /// Payload is stored as a JSON blob and sent as a flat string map.
    ///
    /// A blob that will not decode is dropped rather than failing the event:
    /// the event itself — "GPS lost at 14:02" — is the part the alert desk acts
    /// on, and losing it because a diagnostic side-car is malformed would be
    /// the wrong trade.
    private static func decodePayload(_ json: String?) -> [String: String]? {
        guard let json, let data = json.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode([String: String].self, from: data)
    }
}

/// One formatter, made once.
///
/// `ISO8601DateFormatter` is expensive to construct and thread-safe to use, so
/// building one per event — which is what the obvious code does — shows up as
/// real cost when a phone comes out of a dead zone with a backlog. Fractional
/// seconds are included: two events in the same second are ordinary when a
/// permission change cascades.
enum ISO8601 {
    private static let formatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        f.timeZone = TimeZone(secondsFromGMT: 0)
        return f
    }()

    static func string(from date: Date) -> String {
        formatter.string(from: date)
    }

    /// Parses both with and without fractional seconds.
    ///
    /// The server sends `plannedDeliveryAt` from Postgres, which omits the
    /// fraction when it happens to be zero. A parser that only accepts one
    /// shape returns nil for midnight exactly, which is precisely when a
    /// delivery deadline is most likely to be set.
    static func date(from string: String) -> Date? {
        if let date = formatter.date(from: string) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: string)
    }
}
