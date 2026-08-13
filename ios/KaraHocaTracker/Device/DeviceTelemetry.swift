import Foundation
import CoreLocation
#if canImport(UIKit)
import UIKit
#endif
import Network

/// What the phone can say about itself, and how much of it to believe.
///
/// Every fix carries a battery reading and a network label, and the dispatcher
/// uses both: a lorry that goes silent with the battery at 4% is a flat phone,
/// not a driver who switched the app off, and the alert that fires should say
/// so. This is also where `isMock` is decided, which is the only defence this
/// system has against a subcontracted driver spoofing a route.
///
/// Everything here is best-effort by design. A reading that cannot be taken is
/// `nil`, never a fabricated zero — a battery column full of honest nulls is
/// diagnosable, a column full of invented 100s is a lie the dispatcher will act
/// on.
final class DeviceTelemetry: @unchecked Sendable {

    static let shared = DeviceTelemetry()

    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "com.karahoca.tracker.telemetry")

    /// Guarded by `queue`. Read through `networkType`, which hops onto it.
    private var path: NWPath?

    private init() {
        monitor.pathUpdateHandler = { [weak self] path in
            self?.queue.async { self?.path = path }
        }
        monitor.start(queue: queue)

        #if canImport(UIKit)
        // Without this the level is always -1. It costs nothing and Apple has
        // never deprecated it, unlike almost everything else on this class.
        DispatchQueue.main.async {
            UIDevice.current.isBatteryMonitoringEnabled = true
        }
        #endif
    }

    // ---- battery ---------------------------------------------------------

    /// 0-100, or nil if the level is genuinely unknown.
    ///
    /// The simulator always reports -1, and so does a real device for a beat
    /// after monitoring is switched on. Both must come out as nil rather than
    /// as a battery that is somehow negative.
    var batteryPct: Int? {
        #if canImport(UIKit)
        let level = UIDevice.current.batteryLevel
        guard level >= 0 else { return nil }
        return Int((level * 100).rounded())
        #else
        return nil
        #endif
    }

    var isCharging: Bool {
        #if canImport(UIKit)
        switch UIDevice.current.batteryState {
        case .charging, .full: return true
        default:               return false
        }
        #else
        return false
        #endif
    }

    /// iOS's own battery saver. Worth reporting because it is the single most
    /// common cause of a phone that stops delivering background fixes while
    /// insisting every permission is granted.
    var isLowPowerMode: Bool {
        ProcessInfo.processInfo.isLowPowerModeEnabled
    }

    // ---- network ---------------------------------------------------------

    /// The same vocabulary the Android app sends, so the two populate one
    /// column: `wifi`, `cellular`, `wired`, `other`, `none`.
    ///
    /// iOS will not tell an app which radio generation it is on without
    /// `CoreTelephony`, which needs an entitlement this app does not have and
    /// does not want. `cellular` covers 2G through 5G, and that is the honest
    /// answer rather than a guess dressed up as data.
    var networkType: String {
        queue.sync {
            guard let path, path.status == .satisfied else { return "none" }
            if path.usesInterfaceType(.wifi)          { return "wifi" }
            if path.usesInterfaceType(.cellular)      { return "cellular" }
            if path.usesInterfaceType(.wiredEthernet) { return "wired" }
            return "other"
        }
    }

    var isOnline: Bool {
        queue.sync { path?.status == .satisfied }
    }

    /// iOS's "Low Data Mode", plus a hotspot. Both mean: this connection is
    /// metered, batch harder before spending it.
    var isConstrainedOrExpensive: Bool {
        queue.sync {
            guard let path else { return false }
            return path.isConstrained || path.isExpensive
        }
    }

    // ---- mock detection --------------------------------------------------

    /// Whether this fix looks fabricated.
    ///
    /// On Android this is `Location.isMock`, a first-class flag the OS sets.
    /// iOS has no equivalent, because on a non-jailbroken phone there is no
    /// supported way for one app to feed another a false location — the attack
    /// Android's flag exists to catch is not available here.
    ///
    /// What *is* available is Xcode's simulated-location feature and a
    /// simulator, both of which produce fixes with a distinctive signature: a
    /// `sourceInformation` that says so from iOS 15 onwards. Anything older
    /// falls back to the compile-time simulator check.
    ///
    /// This is a real gap versus Android and it is stated rather than papered
    /// over: a determined driver with a jailbroken phone can beat it. The
    /// server-side teleport and speed checks in migration 0004 are the defence
    /// that does not depend on the client being honest.
    func isMock(_ location: CLLocation) -> Bool {
        #if targetEnvironment(simulator)
        return true
        #else
        if #available(iOS 15.0, *), let source = location.sourceInformation {
            return source.isSimulatedBySoftware || source.isProducedByAccessory
        }
        return false
        #endif
    }

    // ---- identity --------------------------------------------------------

    /// What the server records about this handset at claim time.
    ///
    /// `deviceId` is not the vendor identifier: `identifierForVendor` changes
    /// when the last app from a vendor is deleted and reinstalled, which is
    /// exactly what a driver does when told to "reinstall the app", and a new
    /// id there would look like a new device claiming an existing session.
    /// `CredentialStore.deviceId()` mints one into the keychain instead, which
    /// survives reinstallation.
    func describe(deviceId: String, hasBackgroundLocation: Bool) -> DeviceInfoDto {
        let bundle = Bundle.main.infoDictionary
        var dto = DeviceInfoDto(deviceId: deviceId)
        dto.manufacturer = "Apple"
        dto.model = Self.hardwareModel
        #if canImport(UIKit)
        dto.osVersion = "iOS " + UIDevice.current.systemVersion
        #else
        dto.osVersion = ProcessInfo.processInfo.operatingSystemVersionString
        #endif
        dto.appVersion = bundle?["CFBundleShortVersionString"] as? String
        dto.appBuild = (bundle?["CFBundleVersion"] as? String).flatMap(Int.init)
        // iOS has no per-app battery-optimisation whitelist to be excluded
        // from; the closest thing is Low Power Mode, which is global and which
        // the driver can turn off. Reported as "not restricted" only when it is
        // genuinely off, so the dispatcher's "why is this phone quiet" screen
        // has the same signal it has for Android.
        dto.batteryOptimisationIgnored = !isLowPowerMode
        dto.hasBackgroundLocation = hasBackgroundLocation
        dto.fingerprint = Self.hardwareModel
        return dto
    }

    /// `iPhone14,2` rather than `iPhone`. `UIDevice.model` returns the latter
    /// for every handset ever made, which tells a fleet manager nothing about
    /// whether a driver is carrying a phone old enough to have a GPS chip that
    /// struggles.
    static let hardwareModel: String = {
        var info = utsname()
        uname(&info)
        let machine = withUnsafePointer(to: &info.machine) { pointer in
            pointer.withMemoryRebound(to: CChar.self, capacity: 1) {
                String(validatingUTF8: $0) ?? ""
            }
        }
        return machine.isEmpty ? "unknown" : machine
    }()
}
