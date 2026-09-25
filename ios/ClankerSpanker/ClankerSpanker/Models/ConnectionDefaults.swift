import Foundation

/// Onboarding defaults (RFC-043). No machine addresses: the host only listens
/// on loopback + Tailscale (RFC-028) and only shares its token with its own
/// machine (RFC-026), so phones pair by scanning the QR on the host's /setup.
enum ConnectionDefaults {
    /// Simulator and the Mac app run on the host machine and can use loopback.
    static let simulatorHostURL = "http://127.0.0.1:8787"

    /// Placeholder for the Host URL field on a phone.
    static let hostURLPlaceholder = "http://100.x.y.z:8787 (Tailscale)"

    /// Pre-filled Host URL: loopback where that works, empty on a phone.
    static var suggestedHostURL: String {
        #if targetEnvironment(simulator) || os(macOS)
        return simulatorHostURL
        #else
        return ""
        #endif
    }

    /// The pairing page, opened on the host machine itself.
    static let setupPageURL = URL(string: "http://localhost:8787/setup")!
}
