import Foundation
import Combine
import Security

/// Disk config helpers — not tied to MainActor (safe from HostEndpoint.loadToken).
enum LocalHostConfigFile {
    /// Portable home directory (macOS + iOS).
    static var homeDirectory: URL {
        #if os(macOS)
        FileManager.default.homeDirectoryForCurrentUser
        #else
        URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
        #endif
    }

    static var configURL: URL {
        homeDirectory
            .appendingPathComponent(".grok-dispatch")
            .appendingPathComponent("config.json")
    }

    /// Stable install location for the gateway package (not a git checkout).
    static var installedHostRoot: URL {
        homeDirectory
            .appendingPathComponent("Library/Application Support/ClankerSpanker/host")
    }

    static var launchAgentLabel: String { "com.nightmoose.clankerspanker-host" }

    static var launchAgentPlistURL: URL {
        homeDirectory
            .appendingPathComponent("Library/LaunchAgents")
            .appendingPathComponent("\(launchAgentLabel).plist")
    }

    static func readToken() -> String? {
        guard let data = try? Data(contentsOf: configURL),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let token = obj["hostToken"] as? String,
              !token.isEmpty
        else { return nil }
        return token
    }

    static func readBindPort() -> Int {
        guard let data = try? Data(contentsOf: configURL),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let port = obj["bindPort"] as? Int
        else { return 8787 }
        return port
    }

    /// Merge project folders into host config.json (creates file if missing).
    @discardableResult
    static func mergeProjects(_ folders: [(id: String, name: String, path: String)]) throws -> Int {
        let fm = FileManager.default
        try fm.createDirectory(at: configURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        var root: [String: Any]
        if let data = try? Data(contentsOf: configURL),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        {
            root = obj
        } else {
            root = [
                "hostToken": randomToken(),
                "bindHost": "0.0.0.0",
                "bindPort": 8787,
                "projects": [] as [[String: String]],
                "allowCustomPaths": true,
                "notifyDesktop": true,
                "dataDir": homeDirectory.appendingPathComponent(".grok-dispatch").path,
            ]
        }
        var projects = (root["projects"] as? [[String: Any]]) ?? []
        var byPath = Dictionary(uniqueKeysWithValues: projects.compactMap { p -> (String, [String: Any])? in
            guard let path = p["path"] as? String else { return nil }
            return (path, p)
        })
        for f in folders {
            let resolved = (f.path as NSString).standardizingPath
            guard !resolved.isEmpty, resolved != "/", fm.fileExists(atPath: resolved) else { continue }
            byPath[resolved] = [
                "id": f.id,
                "name": f.name,
                "path": resolved,
            ]
        }
        projects = Array(byPath.values)
        root["projects"] = projects
        root["allowCustomPaths"] = true
        let data = try JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: configURL, options: .atomic)
        // RFC-026: config.json holds the host token + profile secrets. An
        // atomic write creates a fresh file at the default 0644.
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: configURL.path)
        return projects.count
    }

    private static func randomToken() -> String {
        var bytes = [UInt8](repeating: 0, count: 24)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return bytes.map { String(format: "%02x", $0) }.joined()
    }
}

/// macOS: kickstart / observe the LaunchAgent-owned host and read its config.
/// The app never runs `node` in-process — the gateway is a launchd job so it
/// survives Cmd-Q, upgrades, and reboots. iOS: lightweight stub so shared
/// Settings/onboarding compile.
@MainActor
final class LocalHostController: ObservableObject {
    static let shared = LocalHostController()

    /// PID listening on bind port, discovered via `lsof`. Owned by launchd,
    /// not this app.
    @Published private(set) var listenerPid: Int32?
    @Published var lastError: String?
    @Published private(set) var logs: [String] = []
    @Published private(set) var apiReachable = false
    @Published var hostPackagePath: String = ""
    /// Which LaunchAgent (if any) is loaded. Refreshed each health poll.
    @Published private(set) var loadedAgentLabel: String?

    /// Human-readable process ownership for the Host panel.
    var processStatusLabel: String {
        if apiReachable {
            let owner = loadedAgentLabel ?? "external"
            if let listenerPid {
                return "LaunchAgent \(owner) · pid \(listenerPid)"
            }
            return "Reachable (owner \(owner))"
        }
        if let listenerPid {
            return "Port in use · pid \(listenerPid) (API not responding)"
        }
        return "Not running"
    }

    /// True when something is serving on the local bind port.
    var gatewayAlive: Bool { apiReachable }

    #if os(macOS)
    private let maxLogs = 200
    private var healthTimer: Timer?

    /// LaunchAgent labels this app knows about, in preference order.
    /// The app-managed install (`clankerspanker-host`) wins over the repo
    /// standalone (`grok-dispatch-host`) when both are present.
    static let knownAgentLabels: [String] = [
        LocalHostConfigFile.launchAgentLabel,
        "com.nightmoose.grok-dispatch-host",
    ]

    var hostConfigURL: URL { LocalHostConfigFile.configURL }

    private init() {
        // RFC-027: a saved path equal to the install root is the old bug's
        // leftover — fall back to the checkout.
        if let saved = UserDefaults.standard.string(forKey: "localHostPackagePath"), !saved.isEmpty,
           (saved as NSString).standardizingPath != (LocalHostConfigFile.installedHostRoot.path as NSString).standardizingPath {
            hostPackagePath = saved
        } else {
            hostPackagePath = Self.defaultHostPackagePath() ?? ""
        }
        startHealthPolling()
    }

    private static func defaultHostPackagePath() -> String? {
        // RFC-027: the package path is the SOURCE for Install / update; never
        // the install root.
        let home = LocalHostConfigFile.homeDirectory.path
        let candidates = [
            "\(home)/Projects/GrokDispatch/host",
            "\(home)/Projects/ClankerSpanker/host",
            "\(home)/src/GrokDispatch/host",
            "\(home)/code/GrokDispatch/host",
        ]
        for c in candidates {
            if FileManager.default.fileExists(atPath: (c as NSString).appendingPathComponent("package.json")) {
                return c
            }
        }
        return nil
    }

    func savePackagePath(_ path: String) {
        hostPackagePath = path
        UserDefaults.standard.set(path, forKey: "localHostPackagePath")
    }

    func readHostToken() -> String? {
        LocalHostConfigFile.readToken()
    }

    /// Kept for call sites that used the old name.
    static func readTokenFromConfigFile() -> String? {
        LocalHostConfigFile.readToken()
    }

    func readBindPort() -> Int {
        LocalHostConfigFile.readBindPort()
    }

    var localBaseURL: String {
        "http://127.0.0.1:\(readBindPort())"
    }

    func refreshStatus() async {
        await probeAPI()
        listenerPid = await Self.findListenerPid(port: readBindPort())
        loadedAgentLabel = await Self.firstLoadedAgentLabel(Self.knownAgentLabels)
    }

    /// Kickstart the gateway via launchd. Never spawns node in-process.
    /// Tries `clankerspanker-host` first, then falls back to
    /// `grok-dispatch-host`. If neither is loaded, points the user at the
    /// two install paths.
    func start() {
        lastError = nil
        if apiReachable {
            appendLog("[desktop] gateway already reachable at \(localBaseURL) — no kickstart needed")
            return
        }
        let uid = getuid()
        for label in Self.knownAgentLabels {
            appendLog("[desktop] kickstart gui/\(uid)/\(label)")
            let (ok, output) = Self.launchctl(["kickstart", "-k", "gui/\(uid)/\(label)"])
            if ok {
                appendLog("[desktop] kickstarted \(label)")
                Task { await refreshStatus() }
                return
            }
            if !output.isEmpty {
                appendLog("[desktop] launchctl: \(output.trimmingCharacters(in: .whitespacesAndNewlines))")
            }
        }
        lastError = """
            No host LaunchAgent is loaded. Install one from Host → Install / update host,
            or from the repo: ./host/scripts/install-launchd.sh
            """
        Task { await refreshStatus() }
    }

    /// The host is a LaunchAgent — nothing to terminate from inside this app.
    /// Surface an actionable hint instead of silently doing nothing.
    func stop() {
        let uid = getuid()
        if let label = loadedAgentLabel {
            lastError = """
                Host is a LaunchAgent (\(label)). To stop it:
                  launchctl bootout gui/\(uid)/\(label)
                Or use Host → Unload LaunchAgent (app-managed install only).
                """
        } else if let pid = listenerPid {
            lastError = "Something is listening on port \(readBindPort()) as pid \(pid). Stop it from where it was started."
        } else {
            lastError = "No gateway is running."
        }
    }

    /// Run `/bin/launchctl` synchronously. Returns (success, combined output).
    /// Success means the process exited 0.
    @discardableResult
    static func launchctl(_ args: [String]) -> (ok: Bool, output: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        p.arguments = args
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        do {
            try p.run()
            p.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let text = String(data: data, encoding: .utf8) ?? ""
            return (p.terminationStatus == 0, text)
        } catch {
            return (false, error.localizedDescription)
        }
    }

    /// First LaunchAgent label in `candidates` that `launchctl print` reports
    /// as loaded for the current GUI session. Nil if none are loaded.
    static func firstLoadedAgentLabel(_ candidates: [String]) async -> String? {
        await withCheckedContinuation { cont in
            DispatchQueue.global(qos: .utility).async {
                let uid = getuid()
                for label in candidates {
                    let (ok, _) = launchctl(["print", "gui/\(uid)/\(label)"])
                    if ok {
                        cont.resume(returning: label)
                        return
                    }
                }
                cont.resume(returning: nil)
            }
        }
    }

    /// Best-effort: PID listening on TCP port (macOS `lsof`).
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

    /// Ensure config exists, start host if API is down, return local URL + token for onboarding.
    func bootstrapLocalHost() async -> (url: String, token: String)? {
        await refreshStatus()
        if !apiReachable {
            start()
            for _ in 0..<30 {
                try? await Task.sleep(nanoseconds: 200_000_000)
                await probeAPI()
                if apiReachable { break }
            }
        }
        guard let token = readHostToken() else {
            lastError = "No hostToken in \(hostConfigURL.path)"
            return nil
        }
        return (localBaseURL, token)
    }

    private func probeAPI() async {
        let url = URL(string: "\(localBaseURL)/health")!
        var req = URLRequest(url: url)
        req.timeoutInterval = 1.5
        do {
            let (_, res) = try await URLSession.shared.data(for: req)
            apiReachable = (res as? HTTPURLResponse)?.statusCode == 200
        } catch {
            apiReachable = false
        }
    }

    private func startHealthPolling() {
        healthTimer?.invalidate()
        healthTimer = Timer.scheduledTimer(withTimeInterval: 4, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.refreshStatus() }
        }
    }

    private func appendLog(_ chunk: String) {
        let lines = chunk.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        logs.append(contentsOf: lines.filter { !$0.isEmpty })
        if logs.count > maxLogs {
            logs.removeFirst(logs.count - maxLogs)
        }
    }

    #else

    private init() {}

    var localBaseURL: String { "http://127.0.0.1:8787" }

    func savePackagePath(_ path: String) { hostPackagePath = path }
    func readHostToken() -> String? { nil }
    func readBindPort() -> Int { 8787 }
    func refreshStatus() async {}
    func start() { lastError = "Host process control is macOS-only" }
    func stop() {}
    func bootstrapLocalHost() async -> (url: String, token: String)? { nil }
    static func readTokenFromConfigFile() -> String? { nil }

    #endif
}
