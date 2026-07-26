import Foundation

/// Pre-filled values for this Mac Mini so onboarding is mostly paste-free.
/// Token still comes from the host (or deep link) — never hardcode secrets long-term.
enum ConnectionDefaults {
    /// Same Wi‑Fi LAN address for Alex's Mac mini (en0).
    static let lanHostURL = "http://192.168.50.9:8787"

    /// Simulator on this Mac can hit localhost.
    static let simulatorHostURL = "http://127.0.0.1:8787"

    /// Best default for the current device.
    static var suggestedHostURL: String {
        #if targetEnvironment(simulator)
        return simulatorHostURL
        #else
        return lanHostURL
        #endif
    }

    /// Setup page on the Mac (open in Safari on the phone while on the same Wi‑Fi).
    static var setupPageURL: URL {
        URL(string: "\(lanHostURL)/setup")!
    }
}
