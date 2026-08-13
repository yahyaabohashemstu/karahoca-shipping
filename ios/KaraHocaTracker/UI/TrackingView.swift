import SwiftUI

/// What the driver sees for the eighteen hours after the code goes in.
///
/// The information hierarchy is deliberate. The single most important fact —
/// "is this thing recording?" — is the largest element and readable at arm's
/// length from a phone in a windscreen cradle. The pending count is second,
/// because a driver who can see that fixes are queued understands that a
/// tunnel is not a failure. Everything else is deferred behind a sheet.
struct TrackingView: View {
    @EnvironmentObject private var coordinator: TrackerCoordinator
    @State private var showDiagnostics = false
    @State private var confirmStop = false

    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                StatusHero()
                PermissionNotice()
                ShipmentCard()
                QueueCard()
                controls
            }
            .padding(20)
        }
        .background(Color(.systemGroupedBackground))
        .refreshable { await coordinator.syncNow() }
        .safeAreaInset(edge: .top) { topBar }
        .sheet(isPresented: $showDiagnostics) { DiagnosticsSheet() }
        .alert("Sevkiyatı bitir?", isPresented: $confirmStop) {
            Button("Vazgeç", role: .cancel) {}
            Button("Bitir", role: .destructive) { Task { await coordinator.stop() } }
        } message: {
            Text("Takip durur ve kayıtlı konumlar sunucuya gönderilir. Bu işlem geri alınamaz.")
        }
    }

    private var topBar: some View {
        HStack {
            Text(coordinator.snapshot.reference ?? "—")
                .font(.footnote.monospaced().weight(.semibold))
                .foregroundStyle(.secondary)
            Spacer()
            Button { showDiagnostics = true } label: {
                Image(systemName: "waveform.path.ecg")
            }
            .accessibilityLabel("Teknik bilgiler")
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 10)
        .background(.bar)
    }

    private var controls: some View {
        VStack(spacing: 12) {
            if coordinator.engine.state.isTracking {
                Button {
                    coordinator.pause()
                } label: {
                    Label("Duraklat", systemImage: "pause.fill")
                        .frame(maxWidth: .infinity, minHeight: 50)
                }
                .buttonStyle(.bordered)
            } else {
                Button {
                    coordinator.resume()
                } label: {
                    Label("Devam Et", systemImage: "play.fill")
                        .frame(maxWidth: .infinity, minHeight: 50)
                }
                .buttonStyle(.borderedProminent)
            }

            Button(role: .destructive) {
                confirmStop = true
            } label: {
                HStack {
                    if coordinator.isStopping { ProgressView() }
                    Text(coordinator.isStopping ? "Gönderiliyor…" : "Sevkiyatı Bitir")
                }
                .frame(maxWidth: .infinity, minHeight: 50)
            }
            .buttonStyle(.bordered)
            .disabled(coordinator.isStopping)

            if let error = coordinator.claimError {
                // Reused for the "still N points to send" refusal in `stop`,
                // which is the message most likely to appear here.
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(.orange)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
            }
        }
    }
}

/// The one thing readable from the driver's seat.
private struct StatusHero: View {
    @EnvironmentObject private var coordinator: TrackerCoordinator

    var body: some View {
        VStack(spacing: 10) {
            Circle()
                .fill(tint)
                .frame(width: 14, height: 14)
                .overlay(Circle().stroke(tint.opacity(0.3), lineWidth: 10))

            Text(title)
                .font(.title2.weight(.bold))
                .multilineTextAlignment(.center)

            Text(subtitle)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 28)
        .background(Color(.secondarySystemGroupedBackground),
                    in: RoundedRectangle(cornerRadius: 18))
    }

    private var state: LocationEngine.State { coordinator.engine.state }

    private var tint: Color {
        if !state.isTracking { return .orange }
        if state.authorisation != .authorizedAlways { return .orange }
        return .green
    }

    private var title: String {
        state.isTracking ? "Takip Aktif" : "Takip Duraklatıldı"
    }

    /// Time since the last fix, in words. "2 dakika önce" tells a driver
    /// whether the app is working; a timestamp does not.
    private var subtitle: String {
        guard state.isTracking else { return "Devam etmek için düğmeye basın." }
        guard let last = state.lastFixAt else { return "İlk konum bekleniyor…" }
        let seconds = Int(Date().timeIntervalSince(last))
        if seconds < 30  { return "Konum az önce alındı." }
        if seconds < 120 { return "Son konum \(seconds) saniye önce." }
        return "Son konum \(seconds / 60) dakika önce."
    }
}

/// What is being carried and where. Read once, then ignored — but a driver who
/// scanned the wrong QR at a loading bay finds out here, not in Erbil.
private struct ShipmentCard: View {
    @EnvironmentObject private var coordinator: TrackerCoordinator

    var body: some View {
        let shipment = coordinator.snapshot.shipment
        if !shipment.isEmpty {
            Card(title: "Sevkiyat") {
                if let order = shipment.orderNumber { Row("Sipariş", order) }
                if let customer = shipment.customerName { Row("Müşteri", customer) }
                if let destination = shipment.destination { Row("Varış", destination) }
                if let cargo = shipment.cargoSummary { Row("Yük", cargo) }
            }
        }
    }
}

/// The queue, which is the honest picture of what has and has not left the
/// phone. A driver who can see "142 bekliyor" during a dead zone does not
/// phone the office.
private struct QueueCard: View {
    @EnvironmentObject private var coordinator: TrackerCoordinator

    var body: some View {
        Card(title: "Kayıt") {
            Row("Gönderilen", "\(coordinator.engine.state.fixesStored)")
            if let pending = coordinator.pending, pending.pending > 0 {
                Row("Bekleyen", "\(pending.pending)", tint: .orange)
            }
            if let last = coordinator.lastSyncAt {
                Row("Son gönderim", Self.relative(last))
            }
        }
    }

    private static func relative(_ date: Date) -> String {
        let seconds = Int(Date().timeIntervalSince(date))
        if seconds < 60 { return "az önce" }
        if seconds < 3600 { return "\(seconds / 60) dk önce" }
        return "\(seconds / 3600) sa önce"
    }
}

/// Everything a dispatcher might ask for over the phone, in one place.
///
/// Exists so the answer to "what does your app say?" is a screenshot rather
/// than a conversation. Not on the main screen, because none of it means
/// anything to a driver on a good day.
private struct DiagnosticsSheet: View {
    @EnvironmentObject private var coordinator: TrackerCoordinator
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section("Oturum") {
                    Row("Referans", coordinator.snapshot.reference ?? "—")
                    Row("Cihaz", String(coordinator.snapshot.deviceId.prefix(8)))
                    Row("Aralık", "\(Int(coordinator.snapshot.policy.pingIntervalSec)) sn")
                    Row("Bekleme", "\(Int(coordinator.snapshot.policy.idleIntervalSec)) sn")
                    Row("Mesafe", "\(Int(coordinator.snapshot.policy.minDistanceM)) m")
                }
                Section("Konum") {
                    Row("İzin", authorisationLabel)
                    Row("Hassasiyet",
                        coordinator.engine.state.accuracyIsReduced ? "Yaklaşık" : "Hassas")
                    Row("Kaydedilen", "\(coordinator.engine.state.fixesStored)")
                    Row("Elenen", "\(coordinator.engine.state.fixesRejected)")
                    if let fix = coordinator.engine.state.lastFix {
                        Row("Son konum",
                            String(format: "%.5f, %.5f", fix.latitude, fix.longitude))
                    }
                }
                Section("Kuyruk") {
                    Row("Toplam", "\(coordinator.pending?.total ?? 0)")
                    Row("Bekleyen", "\(coordinator.pending?.pending ?? 0)")
                    Row("Gönderimde", "\(coordinator.pending?.inFlight ?? 0)")
                    if coordinator.snapshot.evictedTotal > 0 {
                        Row("Silinen", "\(coordinator.snapshot.evictedTotal)", tint: .red)
                    }
                }
                Section("Cihaz") {
                    Row("Model", DeviceTelemetry.hardwareModel)
                    Row("Batarya", DeviceTelemetry.shared.batteryPct.map { "%\($0)" } ?? "—")
                    Row("Şebeke", DeviceTelemetry.shared.networkType)
                    Row("Güç tasarrufu",
                        DeviceTelemetry.shared.isLowPowerMode ? "Açık" : "Kapalı")
                }
            }
            .navigationTitle("Teknik Bilgiler")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Kapat") { dismiss() }
                }
            }
        }
    }

    private var authorisationLabel: String {
        switch coordinator.engine.state.authorisation {
        case .authorizedAlways:    return "Her zaman"
        case .authorizedWhenInUse: return "Uygulama açıkken"
        case .denied:              return "Reddedildi"
        case .restricted:          return "Kısıtlı"
        default:                   return "Belirsiz"
        }
    }
}

// ---- small shared pieces --------------------------------------------------

private struct Card<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title.uppercased())
                .font(.caption2.weight(.semibold))
                .kerning(1)
                .foregroundStyle(.secondary)
            content
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground),
                    in: RoundedRectangle(cornerRadius: 16))
    }
}

private struct Row: View {
    let label: String
    let value: String
    var tint: Color = .primary

    init(_ label: String, _ value: String, tint: Color = .primary) {
        self.label = label
        self.value = value
        self.tint = tint
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Spacer(minLength: 12)
            Text(value)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(tint)
                .multilineTextAlignment(.trailing)
        }
    }
}
