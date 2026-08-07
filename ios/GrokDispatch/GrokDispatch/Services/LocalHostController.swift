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
        return projects.count
    }

    private static func randomToken() -> String {
        var bytes = [UInt8](repeating: 0, count: 24)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return bytes.map { String(format: "%02x", $0) }.joined()
    }
}

/// macOS: start/stop a local ClankerSpanker host process and read its config.
/// iOS: lightweight stub so shared Settings/onboarding compile.
@MainActor
final class LocalHostController: ObservableObject {
    static let shared = LocalHostController()

    @Published private(set) var isRunning = false
    @Published private(set) var pid: Int32?
    /// PID listening on bind port when we did not spawn the process (npm start, launchd, other terminal).
    @Published private(set) var externalPid: Int32?
    @Published var lastError: String?
    @Published private(set) var logs: [String] = []
    @Published private(set) var apiReachable = false
    @Published var hostPackagePath: String = ""

    /// Human-readable process ownership for the Host panel.
    var processStatusLabel: String {
        if isRunning, let pid {
            return "Owned by this app · pid \(pid)"
        }
        if apiReachable {
            if let externalPid {
                return "Running externally · pid \(externalPid)"
            }
            return "Running externally (not started by this app)"
        }
        if let externalPid {
            return "Port in use · pid \(externalPid) (API not responding)"
        }
        return "Not running"
    }

    /// True when something is serving (owned or external).
    var gatewayAlive: Bool { apiReachable || isRunning }

    #if os(macOS)
    private var process: Process?
    private let maxLogs = 200
    private var healthTimer: Timer?

    var hostConfigURL: URL { LocalHostConfigFile.configURL }

    private init() {
        if let saved = UserDefaults.standard.string(forKey: "localHostPackagePath"), !saved.isEmpty {
            hostPackagePath = saved
        } else {
            hostPackagePath = Self.defaultHostPackagePath() ?? ""
        }
        startHealthPolling()
    }

    private static func defaultHostPackagePath() -> String? {
        let installed = LocalHostConfigFile.installedHostRoot.path
        if FileManager.default.fileExists(atPath: (installed as NSString).appendingPathComponent("dist/index.js")) {
            return installed
        }
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
        if let process, process.isRunning {
            isRunning = true
            pid = process.processIdentifier
            externalPid = nil
        } else {
            if process != nil {
                self.process = nil
            }
            isRunning = false
            pid = nil
            // Discover who owns the port when API is up (or port is busy)
            externalPid = await Self.findListenerPid(port: readBindPort())
        }
    }

    func start() {
        lastError = nil
        if let process, process.isRunning {
            lastError = "Host already running (pid \(process.processIdentifier))"
            return
        }
        if apiReachable {
            lastError =
                "Gateway already reachable at \(localBaseURL) — started outside this app (terminal, launchd, etc.). Stop that process first if you want this app to own it."
            return
        }

        let root = hostPackagePath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !root.isEmpty else {
            lastError = "Set the host package path (folder containing package.json)."
            return
        }
        let entry = (root as NSString).appendingPathComponent("dist/index.js")
        guard FileManager.default.fileExists(atPath: entry) else {
            lastError = "Missing \(entry). Run: cd host && npm run build"
            return
        }

        let node = Self.findNode()
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: node)
        proc.arguments = [entry]
        proc.currentDirectoryURL = URL(fileURLWithPath: root)
        proc.environment = ProcessInfo.processInfo.environment.merging([
            "PATH": [
                FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".grok/bin").path,
                FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/bin").path,
                "/opt/homebrew/bin",
                "/usr/local/bin",
                "/usr/bin",
                "/bin",
                ProcessInfo.processInfo.environment["PATH"] ?? "",
            ].joined(separator: ":"),
        ]) { _, new in new }

        let out = Pipe()
        let err = Pipe()
        proc.standardOutput = out
        proc.standardError = err
        out.fileHandleForReading.readabilityHandler = { [weak self] h in
            let data = h.availableData
            guard !data.isEmpty, let s = String(data: data, encoding: .utf8) else { return }
            Task { @MainActor in self?.appendLog(s) }
        }
        err.fileHandleForReading.readabilityHandler = { [weak self] h in
            let data = h.availableData
            guard !data.isEmpty, let s = String(data: data, encoding: .utf8) else { return }
            Task { @MainActor in self?.appendLog(s) }
        }
        proc.terminationHandler = { [weak self] p in
            Task { @MainActor in
                self?.appendLog("[desktop] host exited code=\(p.terminationStatus)")
                self?.isRunning = false
                self?.pid = nil
                self?.process = nil
            }
        }

        do {
            appendLog("[desktop] starting \(node) \(entry)")
            try proc.run()
            process = proc
            isRunning = true
            pid = proc.processIdentifier
        } catch {
            lastError = error.localizedDescription
            appendLog("[desktop] start failed: \(error.localizedDescription)")
        }
    }

    func stop() {
        if let process {
            appendLog("[desktop] stopping host (owned)…")
            process.terminate()
            DispatchQueue.global().asyncAfter(deadline: .now() + 3) { [weak self] in
                if let p = self?.process, p.isRunning {
                    p.interrupt()
                }
            }
            return
        }
        // Optionally stop external listener we discovered
        if let externalPid {
            lastError =
                "Host is external (pid \(externalPid)). Stop it from the terminal that started it, or: kill \(externalPid)"
            appendLog("[desktop] will not SIGTERM external pid \(externalPid) — stop it yourself if needed")
            return
        }
        lastError = "No host process owned by this app"
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

    private static func findNode() -> String {
        let candidates = [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node",
        ]
        for c in candidates where FileManager.default.isExecutableFile(atPath: c) {
            return c
        }
        return "node"
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
