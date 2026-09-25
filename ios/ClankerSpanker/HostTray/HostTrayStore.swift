import Foundation
import AppKit
import Combine

/// Menu-bar-only host status + actions. Polls `/health` every 4s and
/// exposes launchd controls. Intentionally standalone — this target has
/// no dependency on the ClankerSpanker Mac app.
@MainActor
final class HostTrayStore: ObservableObject {
    @Published private(set) var apiReachable = false
    @Published private(set) var listenerPid: Int32?
    @Published private(set) var loadedAgentLabel: String?

    /// LaunchAgent labels this tray knows about, in preference order.
    /// The app-managed install (`clankerspanker-host`) wins over the
    /// repo standalone (`grok-dispatch-host`) when both are present.
    static let knownAgentLabels: [String] = [
        "com.nightmoose.clankerspanker-host",
        "com.nightmoose.grok-dispatch-host",
    ]

    private var pollTask: Task<Void, Never>?

    init() {
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(nanoseconds: 4_000_000_000)
            }
        }
    }

    deinit {
        pollTask?.cancel()
    }

    var statusLine: String {
        if apiReachable {
            let owner = loadedAgentLabel.map { shortName($0) } ?? "external"
            if let listenerPid {
                return "Gateway: Up · \(owner) · pid \(listenerPid)"
            }
            return "Gateway: Up · \(owner)"
        }
        return "Gateway: Down"
    }

    var bindPort: Int { HostTrayConfig.readBindPort() }
    var localBaseURL: String { "http://127.0.0.1:\(bindPort)" }

    func refresh() async {
        apiReachable = await Self.probeHealth(baseURL: localBaseURL)
        listenerPid = await Self.findListenerPid(port: bindPort)
        loadedAgentLabel = await Self.firstLoadedAgentLabel(Self.knownAgentLabels)
    }

    func openBrowser(path: String) {
        guard let url = URL(string: "\(localBaseURL)\(path)") else { return }
        NSWorkspace.shared.open(url)
    }

    /// Ask launchd to bounce the loaded agent. If neither is loaded,
    /// pop a modal alert with install instructions.
    func kickstart() {
        let uid = getuid()
        for label in Self.knownAgentLabels {
            let (ok, _) = HostTrayLaunchctl.run(["kickstart", "-k", "gui/\(uid)/\(label)"])
            if ok {
                Task { await refresh() }
                return
            }
        }
        showAlert(
            title: "No host LaunchAgent loaded",
            body: """
                Install a host on this Mac first:

                • From a repo checkout: ./host/scripts/install-launchd.sh
                • From ClankerSpanker.app: Host → Install / update host
                """
        )
    }

    func revealHostLog() {
        let candidates = [
            "\(HostTrayConfig.homeDirectory.path)/Library/Logs/clankerspanker-host.log",
            "\(HostTrayConfig.homeDirectory.path)/Library/Logs/grok-dispatch-host.log",
        ]
        for path in candidates where FileManager.default.fileExists(atPath: path) {
            NSWorkspace.shared.open(URL(fileURLWithPath: path))
            return
        }
        showAlert(
            title: "No host log found",
            body: "Expected one of:\n\(candidates.joined(separator: "\n"))"
        )
    }

    func revealConfigFolder() {
        let url = HostTrayConfig.configURL.deletingLastPathComponent()
        NSWorkspace.shared.open(url)
    }

    private func shortName(_ label: String) -> String {
        if label.hasSuffix("clankerspanker-host") { return "app agent" }
        if label.hasSuffix("grok-dispatch-host") { return "repo agent" }
        return label
    }

    private func showAlert(title: String, body: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = body
        alert.alertStyle = .informational
        alert.runModal()
    }

    // MARK: - probes

    private static func probeHealth(baseURL: String) async -> Bool {
        guard let url = URL(string: "\(baseURL)/health") else { return false }
        var req = URLRequest(url: url)
        req.timeoutInterval = 1.5
        do {
            let (_, res) = try await URLSession.shared.data(for: req)
            return (res as? HTTPURLResponse)?.statusCode == 200
        } catch {
            return false
        }
    }

    private static func findListenerPid(port: Int) async -> Int32? {
        await withCheckedContinuation { cont in
            DispatchQueue.global(qos: .utility).async {
                let proc = Process()
                proc.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
                proc.arguments = ["-nP", "-iTCP:\(port)", "-sTCP:LISTEN", "-t"]
                let pipe = Pipe()
                proc.standardOutput = pipe
                proc.standardError = FileHandle.nullDevice
                do {
                    try proc.run()
                    proc.waitUntilExit()
                    let data = pipe.fileHandleForReading.readDataToEndOfFile()
                    let text = String(data: data, encoding: .utf8)?
                        .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                    let first = text.split(whereSeparator: { $0.isNewline }).first
                        .flatMap { Int32($0) }
                    cont.resume(returning: first)
                } catch {
                    cont.resume(returning: nil)
                }
            }
        }
    }

    private static func firstLoadedAgentLabel(_ candidates: [String]) async -> String? {
        await withCheckedContinuation { cont in
            DispatchQueue.global(qos: .utility).async {
                let uid = getuid()
                for label in candidates {
                    let (ok, _) = HostTrayLaunchctl.run(["print", "gui/\(uid)/\(label)"])
                    if ok {
                        cont.resume(returning: label)
                        return
                    }
                }
                cont.resume(returning: nil)
            }
        }
    }
}
