import Foundation

/// Pure decision table for a Markdown link tap in the transcript.
/// Grok emits relative paths like `[foo.pdf](foo.pdf)` which macOS can't
/// route via `NSWorkspace.shared.open` — we resolve those against the
/// session `cwd` before handing anything to the OS. iOS discards them:
/// the phone has no way to reach a file on the Mac host.
enum MarkdownLinkResolver {
    enum Action: Equatable {
        /// Pass to the OS's default handler (browser, Mail.app, etc.).
        case systemHandle
        /// Open this absolute file URL through `AppState.openInViewer`.
        case openLocalFile(URL)
        /// Suppress the tap silently (no macOS "-50" alert, no navigation).
        case discard
    }

    /// Schemes we defer to the OS. Anything else is treated as a relative
    /// path against `cwd` on macOS, or discarded on iOS.
    static let systemHandledSchemes: Set<String> = [
        "http", "https", "mailto", "tel", "sms", "file",
    ]

    static func resolve(url: URL, cwd: String?, platformIsMac: Bool) -> Action {
        if let scheme = url.scheme?.lowercased(),
           systemHandledSchemes.contains(scheme) {
            return .systemHandle
        }

        guard platformIsMac else { return .discard }

        // Strip anchor fragments and empty paths — nothing to open.
        let rawPath = url.absoluteString.removingPercentEncoding ?? url.absoluteString
        let path = rawPath.split(separator: "#", maxSplits: 1).first.map(String.init) ?? ""
        guard !path.isEmpty else { return .discard }

        if path.hasPrefix("/") {
            return .openLocalFile(URL(fileURLWithPath: path))
        }
        if path.hasPrefix("~") {
            return .openLocalFile(URL(fileURLWithPath: (path as NSString).expandingTildeInPath))
        }

        guard let cwd, !cwd.isEmpty else { return .discard }
        let joined = (cwd as NSString).appendingPathComponent(path)
        return .openLocalFile(URL(fileURLWithPath: joined))
    }
}
