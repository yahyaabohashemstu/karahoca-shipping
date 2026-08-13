import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// The first and often only screen a driver interacts with.
///
/// Designed for one hand, in a cab, in daylight, by someone who is not going to
/// read anything. Two things happen here: a code goes in, and tracking starts.
/// Everything else is deferred.
struct ClaimView: View {
    @EnvironmentObject private var coordinator: TrackerCoordinator
    @State private var code = ""
    @FocusState private var focused: Bool

    var body: some View {
        ScrollView {
            VStack(spacing: 28) {
                header

                VStack(spacing: 12) {
                    CodeField(text: $code)
                        .focused($focused)
                        .disabled(coordinator.isClaiming)

                    if let error = coordinator.claimError {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .font(.footnote)
                            .foregroundStyle(.red)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .transition(.opacity)
                    }
                }

                Button {
                    focused = false
                    Task { await coordinator.claim(code: code) }
                } label: {
                    HStack {
                        if coordinator.isClaiming {
                            ProgressView().tint(.white)
                        }
                        Text(coordinator.isClaiming ? "Bağlanıyor…" : "Takibi Başlat")
                            .font(.headline)
                    }
                    .frame(maxWidth: .infinity, minHeight: 54)
                }
                .buttonStyle(.borderedProminent)
                .disabled(ClaimCode.normalise(code).count != ClaimCode.length
                          || coordinator.isClaiming)

                PermissionNotice()

                Spacer(minLength: 0)
            }
            .padding(24)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Color(.systemGroupedBackground))
        // The QR path. A deep link arriving while this screen is up fills the
        // field and — because the driver has already made the decision by
        // scanning — starts immediately, so the phone can go back on the seat.
        .onChange(of: coordinator.pendingCode) { incoming in
            guard let incoming else { return }
            code = ClaimCode.pretty(incoming)
            coordinator.pendingCode = nil
            focused = false
            Task { await coordinator.claim(code: incoming) }
        }
        .onAppear {
            if let incoming = coordinator.pendingCode {
                // A link that arrived before this view existed — the cold-launch
                // path, where `onOpenURL` fires ahead of the first render.
                code = ClaimCode.pretty(incoming)
                coordinator.pendingCode = nil
                Task { await coordinator.claim(code: incoming) }
            }
        }
    }

    private var header: some View {
        VStack(spacing: 6) {
            Text("KARAHOCA")
                .font(.caption.bold())
                .kerning(3)
                .foregroundStyle(.tint)
            Text("Sevkiyat Takibi")
                .font(.title.weight(.semibold))
            Text("Sevk emrindeki 8 haneli kodu girin\nveya karekodu okutun.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(.top, 40)
    }
}

/// The code entry itself.
///
/// The dash is painted, not typed. A driver copying `K7H2-9QX4` off a dispatch
/// note types the dash; a driver reading it aloud over the phone does not; the
/// field has to accept both and store neither. This mirrors
/// `ClaimCodeTransformation.kt` on Android, which solves the same problem with
/// a `VisualTransformation`.
private struct CodeField: View {
    @Binding var text: String

    var body: some View {
        TextField("K7H2-9QX4", text: $text)
            .textFieldStyle(.plain)
            .font(.system(.title, design: .monospaced).weight(.semibold))
            .multilineTextAlignment(.center)
            .kerning(4)
            .textInputAutocapitalization(.characters)
            .autocorrectionDisabled()
            .textContentType(.oneTimeCode)
            // .asciiCapable, not .default: on a Turkish keyboard the default
            // layout offers ı, ğ, ş and ö, none of which are in the alphabet,
            // and a driver who taps one gets a character that silently
            // disappears. This keyboard cannot produce them.
            .keyboardType(.asciiCapable)
            .padding(.vertical, 18)
            .frame(maxWidth: .infinity)
            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14))
            .onChange(of: text) { raw in
                // Normalise then re-prettify on every keystroke. Doing it here
                // rather than at submit means the driver sees exactly what will
                // be sent — including the I→1 and O→0 folding, which otherwise
                // looks like the app silently changing their typing.
                let formatted = ClaimCode.pretty(ClaimCode.normalise(raw))
                if formatted != raw { text = formatted }
            }
    }
}

/// The permission state, stated plainly, with the one button that fixes it.
///
/// This is the single largest source of "the app is broken" calls on Android,
/// and iOS is worse: there are three separate ways to be half-permitted —
/// `whenInUse` instead of `always`, reduced accuracy instead of precise, and
/// Location Services off device-wide — and each needs a different remedy.
/// Guessing which one a driver has hit, over a phone, from a lorry cab, is not
/// a thing a dispatcher should have to do.
struct PermissionNotice: View {
    @EnvironmentObject private var coordinator: TrackerCoordinator

    var body: some View {
        if let issue {
            VStack(alignment: .leading, spacing: 10) {
                Label(issue.title, systemImage: issue.icon)
                    .font(.subheadline.weight(.semibold))
                Text(issue.detail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Button(issue.action) { issue.perform(coordinator) }
                    .font(.footnote.weight(.semibold))
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(issue.tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 14))
        }
    }

    private var issue: PermissionIssue? {
        PermissionIssue.current(coordinator.engine.state)
    }
}

/// One case per way the phone can be misconfigured, each with its own remedy.
struct PermissionIssue {
    let title: String
    let detail: String
    let action: String
    let icon: String
    let tint: Color
    let perform: (TrackerCoordinator) -> Void

    static func current(_ state: LocationEngine.State) -> PermissionIssue? {
        if !state.servicesEnabled {
            return PermissionIssue(
                title: "Konum servisleri kapalı",
                detail: "Telefonun konum servisleri tamamen kapalı. Ayarlar → Gizlilik ve Güvenlik → Konum Servisleri.",
                action: "Ayarları Aç",
                icon: "location.slash.fill",
                tint: .red,
                perform: { _ in openSettings() }
            )
        }

        switch state.authorisation {
        case .notDetermined:
            return PermissionIssue(
                title: "Konum izni gerekiyor",
                detail: "Sevkiyat boyunca konumun kaydedilebilmesi için izin vermeniz gerekir.",
                action: "İzin Ver",
                icon: "location.circle",
                tint: .blue,
                perform: { $0.engine.requestPermission() }
            )

        case .denied, .restricted:
            return PermissionIssue(
                title: "Konum izni reddedildi",
                detail: "İzin verilmeden sevkiyat takip edilemez. Ayarlardan “Her Zaman” seçeneğini işaretleyin.",
                action: "Ayarları Aç",
                icon: "xmark.circle.fill",
                tint: .red,
                perform: { _ in openSettings() }
            )

        case .authorizedWhenInUse:
            // The dangerous middle state: everything looks fine while the
            // driver is holding the phone, and recording stops the moment the
            // screen locks. Which is to say, for the entire journey.
            return PermissionIssue(
                title: "“Her Zaman” izni gerekiyor",
                detail: "Şu an yalnızca uygulama açıkken konum alınabiliyor. Ekran kilitlendiğinde takip durur.",
                action: "İzni Yükselt",
                icon: "exclamationmark.triangle.fill",
                tint: .orange,
                perform: { $0.engine.requestPermission() }
            )

        default:
            break
        }

        if state.accuracyIsReduced {
            return PermissionIssue(
                title: "Hassas konum kapalı",
                detail: "Konum yalnızca yaklaşık olarak alınıyor; rota birkaç kilometre sapabilir.",
                action: "Hassas Konumu Aç",
                icon: "scope",
                tint: .orange,
                perform: { $0.engine.requestTemporaryPrecision() }
            )
        }

        return nil
    }

    /// Straight to this app's page, not the top of Settings. A driver told to
    /// "go to settings and find the app" will not find the app.
    static func openSettings() {
        #if canImport(UIKit)
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
        #endif
    }
}