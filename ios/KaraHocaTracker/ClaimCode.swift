import Foundation

/// The session hand-off code, and every way it can arrive.
///
/// A direct counterpart to `util/ClaimCode.kt` in the Android app, and it has
/// to stay one: both talk to `kh.normalize_claim_code` in Postgres, and a code
/// the phone accepts but the server rejects is indistinguishable, to a driver
/// standing in a yard, from a broken app.
///
/// Codes are 8 characters of Crockford Base32 — `0123456789ABCDEFGHJKMNPQRSTVWXYZ`,
/// which omits I, L, O and U precisely so a driver reading one off a dispatch
/// note in a dark cab cannot confuse 1/I/l or 0/O. Displayed as `XXXX-XXXX`;
/// stored, transmitted and compared without the dash.
enum ClaimCode {

    /// Every code `kh.generate_claim_code(8)` issues is this long.
    static let length = 8

    /// Where the dash goes when the code is shown to a human.
    static let group = 4

    /// Canonical form: ASCII only, upper case, ambiguous letters folded, capped.
    ///
    /// The uppercasing is done character by character against an explicit ASCII
    /// range rather than with `String.uppercased()`, and that is load-bearing
    /// for the same reason it is on Android: every driver phone in this fleet
    /// is set to Turkish, and Turkish has a dotted capital. `"i".uppercased()`
    /// under a Turkish locale yields `İ` (U+0130), which is not in the alphabet,
    /// would not fold to `1`, and would be stripped — turning a typed `i` into
    /// nothing at all, on exactly the devices this app runs on.
    ///
    /// Swift's `uppercased()` is actually locale-independent, unlike Kotlin's,
    /// but `localizedUppercase` is not and the two are one careless edit apart.
    /// Folding explicitly means the locale can never enter the question.
    static func normalise(_ raw: String?) -> String {
        guard let raw, !raw.isEmpty else { return "" }
        var out = ""
        out.reserveCapacity(length)

        for ch in raw.unicodeScalars {
            if out.count >= length { break }
            switch ch {
            case "0"..."9":
                out.unicodeScalars.append(ch)
            case "A"..."Z":
                out.append(fold(Character(ch)))
            case "a"..."z":
                // ASCII lowercase → uppercase by the fixed 0x20 offset. No
                // locale, no Unicode table, no dotted capital.
                let upper = Unicode.Scalar(ch.value - 0x20)!
                out.append(fold(Character(upper)))
            default:
                // Dashes, spaces, and anything else a human or a scanner adds.
                continue
            }
        }
        return out
    }

    /// Crockford's aliases: I and L read as one, O as zero, U as one.
    private static func fold(_ upper: Character) -> Character {
        switch upper {
        case "I", "L", "U": return "1"
        case "O":           return "0"
        default:            return upper
        }
    }

    /// `K7H29QX4` → `K7H2-9QX4`. Short codes are returned untouched.
    static func pretty(_ code: String) -> String {
        guard code.count > group else { return code }
        let i = code.index(code.startIndex, offsetBy: group)
        return "\(code[..<i])-\(code[i...])"
    }

    /// Pull a code out of whatever URL launched the app.
    ///
    /// Three shapes reach it, and all three are real:
    ///
    ///     https://track.karahoca.com/t/K7H29QX4   the QR, a Universal Link
    ///     karahoca://track?c=K7H29QX4             SMS, and the web fallback
    ///     https://track.karahoca.com/t/?c=…       tolerated, never generated
    ///
    /// The https host is checked against the one this build claims. A link from
    /// any other host did not come from our QR, and its path segment is not our
    /// code — iOS will only hand us a Universal Link for a host in the
    /// entitlement, but the custom scheme is open to any app on the phone.
    static func fromLink(_ url: URL?, host expectedHost: String, scheme: String) -> String? {
        guard let url else { return nil }
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let queryCode = components?.queryItems?.first(where: { $0.name == "c" })?.value

        var candidate: String?
        switch url.scheme?.lowercased() {
        case scheme.lowercased():
            candidate = queryCode

        case "https", "http":
            guard url.host?.lowercased() == expectedHost.lowercased() else { return nil }
            // pathComponents leads with "/" and drops nothing else, so
            // "/t/CODE" is ["/", "t", "CODE"] and a trailing slash does not
            // hand us an empty segment.
            let parts = url.pathComponents.filter { $0 != "/" }
            candidate = queryCode
                ?? (parts.count >= 2 && parts[0].lowercased() == "t" ? parts[1] : nil)

        default:
            return nil
        }

        let normalised = normalise(candidate)
        return normalised.count == length ? normalised : nil
    }
}
