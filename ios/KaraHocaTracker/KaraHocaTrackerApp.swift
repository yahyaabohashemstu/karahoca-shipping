import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// Entry point.
///
/// The coordinator is built once, here, and never rebuilt: it owns the SQLite
/// handle and the CoreLocation manager, and a second copy of either would mean
/// two writers to one database and two delegates fighting over one location
/// stream.
///
/// Construction can fail — the database may not open on a phone with no free
/// space — and when it does the app says so plainly rather than showing an
/// empty screen. A tracker that silently records nothing is worse than one that
/// visibly refuses to start, because the first is discovered in Erbil.
@main
struct KaraHocaTrackerApp: App {

    @StateObject private var host = CoordinatorHost()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            Group {
                switch host.result {
                case .building:
                    ProgressView()
                        .task { host.build() }

                case .failed(let message):
                    StartupFailureView(message: message)

                case .ready(let coordinator):
                    RootView()
                        .environmentObject(coordinator)
                        .task { await coordinator.start() }
                        // Universal Links and the custom-scheme fallback both
                        // land here. `onOpenURL` fires before the first render
                        // on a cold launch, which is why the code is parked on
                        // the coordinator rather than handed to a view.
                        .onOpenURL { coordinator.handle(url: $0) }
                }
            }
            .onChange(of: scenePhase) { phase in
                guard case .ready(let coordinator) = host.result else { return }
                switch phase {
                case .active:     coordinator.enterForeground()
                case .background: coordinator.enterBackground()
                default:          break
                }
            }
        }
    }
}

/// Holds the coordinator, or the reason there isn't one.
@MainActor
final class CoordinatorHost: ObservableObject {
    enum Startup {
        case building
        case ready(TrackerCoordinator)
        case failed(String)
    }

    @Published private(set) var result: Startup = .building

    func build() {
        guard case .building = result else { return }
        do {
            result = .ready(try TrackerCoordinator.makeDefault())
        } catch {
            result = .failed(String(describing: error))
        }
    }
}

/// Which screen, decided in one place.
private struct RootView: View {
    @EnvironmentObject private var coordinator: TrackerCoordinator

    var body: some View {
        switch coordinator.screen {
        case .loading:
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color(.systemGroupedBackground))
        case .claim:
            ClaimView()
        case .tracking:
            TrackingView()
        }
    }
}

/// The storage-failed screen. Turkish, actionable, and honest that tracking is
/// not happening.
private struct StartupFailureView: View {
    let message: String

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "externaldrive.trianglebadge.exclamationmark")
                .font(.largeTitle)
                .foregroundStyle(.red)
            Text("Uygulama başlatılamadı")
                .font(.title3.weight(.semibold))
            Text("Telefonun deposu dolu olabilir. Yer açıp uygulamayı yeniden başlatın. Bu ekran görünürken sevkiyat takip edilmiyor.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Text(message)
                .font(.caption2.monospaced())
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
                .padding(.top, 8)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemGroupedBackground))
    }
}
