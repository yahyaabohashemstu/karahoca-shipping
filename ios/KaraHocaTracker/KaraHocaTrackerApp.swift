import SwiftUI

/// Entry point.
///
/// Deliberately thin while the app is being built up: the value in this
/// codebase so far is the pure logic that CI can verify — the claim-code
/// normaliser and the cadence gate — and a half-written UI shell would only
/// obscure what is and is not real yet.
@main
struct KaraHocaTrackerApp: App {
    var body: some Scene {
        WindowGroup {
            VStack(spacing: 12) {
                Text("KARAHOCA")
                    .font(.caption).bold()
                    .kerning(2)
                    .foregroundStyle(.tint)
                Text("Sevkiyat Takibi")
                    .font(.title2.weight(.semibold))
                Text("Kurulum sürüyor.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            .padding()
        }
    }
}
