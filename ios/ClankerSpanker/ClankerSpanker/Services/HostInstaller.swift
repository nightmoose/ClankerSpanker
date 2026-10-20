#if os(macOS)
import Foundation
import AppKit

/// Installs the Node host into Application Support and manages a user LaunchAgent.
/// Source can be a monorepo `host/` checkout; install root is not a git tree.
/// What the Host panel shows about the app-managed install, and what to do
/// about it. RFC-064: built off the main thread by `probe`, published by
/// `LocalHostController.refreshStatus`. SwiftUI bodies only read it.
struct HostServiceStatus: Equatable {
    var packageInstalled: Bool
    var plistPresent: Bool
    var appAgentLoaded: Bool
    var standaloneAgentLoaded: Bool

    enum Recovery: Equatable {
        case none
        /// Package and plist are on disk but launchd has not loaded the agent,
        /// e.g. the app died between `bootout` and `bootstrap`.
        case loadAppAgent
    }

    /// The repo-standalone agent binds the same port, so never load ours over it.
    var recovery: Recovery {
        packageInstalled && plistPresent && !appAgentLoaded && !standaloneAgentLoaded
            ? .loadAppAgent : .none
    }

    var loadedAgentLabel: String? {
        if appAgentLoaded { return LocalHostConfigFile.launchAgentLabel }
        if standaloneAgentLoaded { return HostInstaller.standaloneLabel }
        return nil
    }

    /// Runs `isLoaded` (a `launchctl print`) — never call on the main thread.
    nonisolated static func probe(
        installRoot: URL = LocalHostConfigFile.installedHostRoot,
        plistURL: URL = LocalHostConfigFile.launchAgentPlistURL,
        appLabel: String = LocalHostConfigFile.launchAgentLabel,
        standaloneLabel: String = HostInstaller.standaloneLabel,
        isLoaded: (String) -> Bool = HostInstaller.isAgentLoaded
    ) -> HostServiceStatus {
        let fm = FileManager.default
        return HostServiceStatus(
            packageInstalled: fm.fileExists(atPath: installRoot.appendingPathComponent("dist/index.js").path),
            plistPresent: fm.fileExists(atPath: plistURL.path),
            appAgentLoaded: isLoaded(appLabel),
            standaloneAgentLoaded: isLoaded(standaloneLabel)
        )
    }
}

/// Installs the Node host into Application Support and manages a user LaunchAgent.
/// Source can be a monorepo `host/` checkout; install root is not a git tree.
///
/// RFC-064: every function that runs a subprocess is `nonisolated` and
/// synchronous, and is only called through `offMain`. `Process.waitUntilExit`
/// spins the run loop; on the main thread that re-enters SwiftUI mid-update
/// and crashed the app between `bootout` and `bootstrap`.
@MainActor
enum HostInstaller {
    nonisolated static var installRoot: URL { LocalHostConfigFile.installedHostRoot }
    nonisolated static var label: String { LocalHostConfigFile.launchAgentLabel }
    nonisolated static var plistURL: URL { LocalHostConfigFile.launchAgentPlistURL }
    nonisolated static let standaloneLabel = "com.nightmoose.grok-dispatch-host"

    /// `launchctl print` exit status. Blocks; never call on the main thread.
    nonisolated static func isAgentLoaded(_ label: String) -> Bool {
        LocalHostController.launchctl(["print", "gui/\(getuid())/\(label)"]).ok
    }

    /// Copy/build host into Application Support and optionally load launchd.
    /// `takeoverStandalone` boots out `com.nightmoose.grok-dispatch-host`
    /// first if it is loaded — required because both agents bind port 8787.
    /// Reads and saves the source path on the main actor; the build, npm and
    /// launchctl run off it. `log` may be called from any thread.
    static func install(
        fromSource source: URL?,
        loadLaunchAgent: Bool = true,
        takeoverStandalone: Bool = false,
        log: @escaping (String) -> Void = { _ in }
    ) async throws {
        let src = try resolveSource(source, log: log)
        try await offMain {
            try installPackage(
                from: src,
                loadLaunchAgent: loadLaunchAgent,
                takeoverStandalone: takeoverStandalone,
                log: log
            )
        }
        // RFC-027: remember where we installed FROM. Saving installRoot made the
        // next update copy the install root onto itself and delete dist/.
        LocalHostController.shared.savePackagePath(src.path)
        log("Installed host → \(installRoot.path)")
    }

    /// Writes the plist and (re)loads the agent, off the main thread.
    static func loadLaunchAgent(takeoverStandalone: Bool = false, log: @escaping (String) -> Void = { _ in }) async throws {
        try await offMain { try installLaunchAgent(takeoverStandalone: takeoverStandalone, log: log) }
    }

    /// RFC-064 recovery: bootstrap the plist already on disk without rewriting it.
    static func loadExistingLaunchAgent(log: @escaping (String) -> Void = { _ in }) async throws {
        try await offMain { try bootstrapAgent(log: log) }
    }

    static func unloadLaunchAgent(log: @escaping (String) -> Void = { _ in }) async throws {
        try await offMain { try unloadLaunchAgentSync(log: log) }
    }

    static func uninstall(removeFiles: Bool = false, log: @escaping (String) -> Void = { _ in }) async throws {
        try await offMain { try uninstallSync(removeFiles: removeFiles, log: log) }
    }

    /// Runs blocking work on a global queue and resumes the caller with its result.
    nonisolated static func offMain<T>(_ work: @escaping () throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { cont in
            DispatchQueue.global(qos: .userInitiated).async {
                cont.resume(with: Result { try work() })
            }
        }
    }

    nonisolated private static func installPackage(
        from src: URL,
        loadLaunchAgent: Bool,
        takeoverStandalone: Bool,
        log: (String) -> Void
    ) throws {
        let fm = FileManager.default
        log("Source: \(src.path)")
        // RFC-063: checked again here, before the build or anything is deleted.
        try refuseSelfSource(src, installRoot: installRoot)

        let distIndex = src.appendingPathComponent("dist/index.js")
        // RFC-027: a checkout always rebuilds, so a stale dist/ is never installed.
        let isCheckout = fm.fileExists(atPath: src.appendingPathComponent("src").path)
            && fm.fileExists(atPath: src.appendingPathComponent("tsconfig.json").path)
        if isCheckout || !fm.fileExists(atPath: distIndex.path) {
            log("Building host (npm install && npm run build)…")
            try run(cmd: "/bin/bash", args: ["-lc", "cd \(shellQuote(src.path)) && npm install && npm run build"], log: log)
        }
        guard fm.fileExists(atPath: distIndex.path) else {
            throw InstallError.message("Build failed — no dist/index.js in \(src.path)")
        }

        // RFC-063: stage the new package next to the install root, run npm in
        // the staging dir, then swap it in. A failure anywhere before the swap
        // leaves the running install untouched.
        try deploy(from: src, to: installRoot, log: log) { staged in
            log("npm install --omit=dev in staging dir…")
            try run(
                cmd: "/bin/bash",
                args: ["-lc", "cd \(shellQuote(staged.path)) && npm install --omit=dev"],
                log: log
            )
        }

        // Ensure config exists
        _ = LocalHostConfigFile.readToken()
        if !fm.fileExists(atPath: LocalHostConfigFile.configURL.path) {
            try LocalHostConfigFile.mergeProjects([])
        }

        if loadLaunchAgent {
            try installLaunchAgent(takeoverStandalone: takeoverStandalone, log: log)
        }
    }

    nonisolated private static func uninstallSync(removeFiles: Bool, log: (String) -> Void) throws {
        try unloadLaunchAgentSync(log: log)
        if removeFiles {
            if FileManager.default.fileExists(atPath: installRoot.path) {
                try FileManager.default.removeItem(at: installRoot)
                log("Removed \(installRoot.path)")
            }
        }
    }

    nonisolated private static func installLaunchAgent(
        takeoverStandalone: Bool,
        log: (String) -> Void
    ) throws {
        let node = findNode()
        let entry = installRoot.appendingPathComponent("dist/index.js").path
        guard FileManager.default.fileExists(atPath: entry) else {
            throw InstallError.message("Install host package first (missing \(entry))")
        }

        let home = LocalHostConfigFile.homeDirectory.path
        let uid = getuid()
        let plist = """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
          <key>Label</key>
          <string>\(label)</string>
          <key>ProgramArguments</key>
          <array>
            <string>\(node)</string>
            <string>\(entry)</string>
          </array>
          <key>WorkingDirectory</key>
          <string>\(installRoot.path)</string>
          <key>RunAtLoad</key>
          <true/>
          <key>KeepAlive</key>
          <true/>
          <key>StandardOutPath</key>
          <string>\(home)/Library/Logs/clankerspanker-host.log</string>
          <key>StandardErrorPath</key>
          <string>\(home)/Library/Logs/clankerspanker-host.err.log</string>
          <key>EnvironmentVariables</key>
          <dict>
            <key>HOME</key>
            <string>\(home)</string>
            <key>PATH</key>
            <string>\(home)/.grok/bin:\(home)/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
          </dict>
        </dict>
        </plist>
        """

        try FileManager.default.createDirectory(
            at: plistURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        // Both LaunchAgents bind port 8787 — only one can be loaded at a
        // time. If the repo-standalone agent is up, refuse unless the
        // caller (typically the Host panel confirm alert) opted in.
        if isAgentLoaded(standaloneLabel) {
            if !takeoverStandalone {
                throw InstallError.message(
                    "\(standaloneLabel) is already loaded (repo host at ~/Projects/ClankerSpanker/host). Confirm from the Host panel to replace it, or leave it as your gateway."
                )
            }
            log("Booting out repo agent \(standaloneLabel) so the app-managed one can take the port…")
            _ = try? run(
                cmd: "/bin/launchctl",
                args: ["bootout", "gui/\(uid)/\(standaloneLabel)"],
                log: log
            )
        }

        // RFC-064: the new plist is on disk before anything is unloaded, so if
        // the app dies from here on, the next launch (or login) loads it.
        try plist.write(to: plistURL, atomically: true, encoding: .utf8)
        log("Wrote \(plistURL.path)")
        try bootstrapAgent(log: log)
    }

    /// bootout any stale copy of the app-managed agent, then bootstrap the
    /// plist on disk. `bootout` returns before launchd has finished removing
    /// the job, and the gateway shuts down gracefully on SIGTERM, which can
    /// take several seconds. A `bootstrap` sent before the old job is gone
    /// fails with "Input/output error". So wait until `launchctl print` no
    /// longer finds the job, then retry `bootstrap` for a while before giving up.
    nonisolated static func bootstrapAgent(
        log: (String) -> Void,
        plistURL: URL = HostInstaller.plistURL,
        label: String = HostInstaller.label,
        attempts: Int = 10,
        retryDelay: TimeInterval = 1.0,
        unloadWait: TimeInterval = 30,
        unloadPollInterval: TimeInterval = 0.5,
        runLaunchctl: (([String]) throws -> Void)? = nil
    ) throws {
        func launchctl(_ args: [String]) throws {
            if let runLaunchctl {
                try runLaunchctl(args)
            } else {
                try run(cmd: "/bin/launchctl", args: args, log: log)
            }
        }
        let uid = getuid()
        guard FileManager.default.fileExists(atPath: plistURL.path) else {
            throw InstallError.message("No LaunchAgent plist at \(plistURL.path). Use Install / update host.")
        }
        try? launchctl(["bootout", "gui/\(uid)/\(label)"])
        func stillLoaded() -> Bool {
            if let runLaunchctl {
                return (try? runLaunchctl(["print", "gui/\(uid)/\(label)"])) != nil
            }
            return isAgentLoaded(label)
        }
        let deadline = Date().addingTimeInterval(unloadWait)
        var loaded = stillLoaded()
        if loaded { log("Waiting for the old gateway to stop…") }
        while loaded {
            guard Date() < deadline else {
                log("Old \(label) still loaded after \(Int(unloadWait))s; trying bootstrap anyway")
                break
            }
            Thread.sleep(forTimeInterval: unloadPollInterval)
            loaded = stillLoaded()
        }
        try retrying(attempts: attempts, delay: retryDelay, log: log) {
            try launchctl(["bootstrap", "gui/\(uid)", plistURL.path])
        }
        try? launchctl(["enable", "gui/\(uid)/\(label)"])
        try? launchctl(["kickstart", "-k", "gui/\(uid)/\(label)"])
        log("LaunchAgent \(label) loaded")
    }

    /// Calls `body` up to `attempts` times, sleeping `delay` between tries.
    /// Rethrows the last error.
    nonisolated static func retrying(
        attempts: Int,
        delay: TimeInterval,
        log: (String) -> Void = { _ in },
        _ body: () throws -> Void
    ) throws {
        var lastError: Error?
        for attempt in 1...max(1, attempts) {
            do {
                try body()
                return
            } catch {
                lastError = error
                if attempt < attempts {
                    log("Retrying (\(attempt)/\(attempts - 1)) after: \(error.localizedDescription)")
                    Thread.sleep(forTimeInterval: delay)
                }
            }
        }
        throw lastError!
    }

    nonisolated private static func unloadLaunchAgentSync(log: (String) -> Void) throws {
        let uid = getuid()
        _ = try? run(cmd: "/bin/launchctl", args: ["bootout", "gui/\(uid)/\(label)"], log: log)
        if FileManager.default.fileExists(atPath: plistURL.path) {
            try FileManager.default.removeItem(at: plistURL)
            log("Removed LaunchAgent plist")
        }
    }

    // MARK: - helpers

    /// Files the installer owns inside the install root. Anything else there
    /// is left alone.
    nonisolated static let packageItems = ["dist", "web", "package.json", "package-lock.json", "node_modules"]

    /// True when `path` is `root` or anywhere inside it, after expanding `~`,
    /// standardizing, and resolving symlinks on both sides.
    nonisolated static func isInside(_ path: String, root: URL) -> Bool {
        func canonical(_ p: String) -> [String] {
            let expanded = (p as NSString).expandingTildeInPath
            return URL(fileURLWithPath: expanded).standardizedFileURL
                .resolvingSymlinksInPath().pathComponents
        }
        let r = canonical(root.path)
        let c = canonical(path)
        return c.count >= r.count && Array(c.prefix(r.count)) == r
    }

    /// True when `path` must never be used as the install source.
    nonisolated static func isInstallRootPath(_ path: String) -> Bool {
        !path.isEmpty && isInside(path, root: LocalHostConfigFile.installedHostRoot)
    }

    /// RFC-027 / RFC-063: never install from the install root (or anything in it).
    nonisolated static func refuseSelfSource(_ src: URL, installRoot: URL) throws {
        if isInside(src.path, root: installRoot) {
            throw InstallError.message(
                "Source \(src.path) is the install location itself, so there is nothing to install from. Set Source package to your ClankerSpanker checkout's host/ folder (for example ~/Projects/ClankerSpanker/host). The installed host was not touched."
            )
        }
    }

    /// RFC-063: copy the package from `src` into a staging dir beside
    /// `installRoot`, let `prepare` finish it (npm install), then swap each
    /// package item into place. Until the swap, `installRoot` is not modified;
    /// if the swap itself fails, the previous items are moved back.
    nonisolated static func deploy(
        from src: URL,
        to installRoot: URL,
        log: (String) -> Void = { _ in },
        prepare: (URL) throws -> Void = { _ in }
    ) throws {
        let fm = FileManager.default
        try refuseSelfSource(src, installRoot: installRoot)
        let parent = installRoot.deletingLastPathComponent()
        try fm.createDirectory(at: parent, withIntermediateDirectories: true)
        let tag = UUID().uuidString.prefix(8)
        let staging = parent.appendingPathComponent(".\(installRoot.lastPathComponent).staging-\(tag)")
        let backup = parent.appendingPathComponent(".\(installRoot.lastPathComponent).previous-\(tag)")
        defer {
            try? fm.removeItem(at: staging)
            try? fm.removeItem(at: backup)
        }

        log("Staging dist + web + package manifests in \(staging.path)…")
        try fm.createDirectory(at: staging, withIntermediateDirectories: true)
        try fm.copyItem(at: src.appendingPathComponent("dist"), to: staging.appendingPathComponent("dist"))
        try fm.copyItem(at: src.appendingPathComponent("package.json"), to: staging.appendingPathComponent("package.json"))
        // `web/` is the /app/ UI (not emitted by tsc).
        for optional in ["web", "package-lock.json"] {
            let from = src.appendingPathComponent(optional)
            if fm.fileExists(atPath: from.path) {
                try fm.copyItem(at: from, to: staging.appendingPathComponent(optional))
            }
        }
        try prepare(staging)
        guard fm.fileExists(atPath: staging.appendingPathComponent("dist/index.js").path) else {
            throw InstallError.message("Staged package has no dist/index.js; the installed host was not touched.")
        }

        log("Swapping staged package into \(installRoot.path)…")
        try fm.createDirectory(at: installRoot, withIntermediateDirectories: true)
        try fm.createDirectory(at: backup, withIntermediateDirectories: true)
        var movedOut: [String] = []
        var movedIn: [String] = []
        do {
            for name in packageItems {
                let live = installRoot.appendingPathComponent(name)
                if fm.fileExists(atPath: live.path) {
                    try fm.moveItem(at: live, to: backup.appendingPathComponent(name))
                    movedOut.append(name)
                }
            }
            for name in packageItems {
                let staged = staging.appendingPathComponent(name)
                if fm.fileExists(atPath: staged.path) {
                    try fm.moveItem(at: staged, to: installRoot.appendingPathComponent(name))
                    movedIn.append(name)
                }
            }
        } catch {
            for name in movedIn {
                try? fm.removeItem(at: installRoot.appendingPathComponent(name))
            }
            for name in movedOut {
                try? fm.moveItem(at: backup.appendingPathComponent(name), to: installRoot.appendingPathComponent(name))
            }
            throw error
        }
    }

    private static func resolveSource(_ source: URL?, log: (String) -> Void = { _ in }) throws -> URL {
        let saved = LocalHostController.shared.hostPackagePath
        // RFC-063: a saved path inside the install root is the RFC-027 bug's
        // leftover. Clearing it (savePackagePath refuses it and falls back to
        // a detected checkout) gets the user out of that state.
        if isInstallRootPath(saved) {
            log("Saved source \(saved) is the install location; ignoring it and looking for a checkout.")
            LocalHostController.shared.savePackagePath(saved)
        }
        let candidates = [
            source?.path ?? "",
            saved,
            LocalHostConfigFile.homeDirectory.appendingPathComponent("Projects/GrokDispatch/host").path,
            LocalHostConfigFile.homeDirectory.appendingPathComponent("Projects/ClankerSpanker/host").path,
        ]
        .filter { !$0.isEmpty }
        // RFC-027: never install the install root onto itself.
        .filter { !isInside($0, root: installRoot) }
        for c in candidates {
            let url = URL(fileURLWithPath: (c as NSString).expandingTildeInPath)
            if FileManager.default.fileExists(atPath: url.appendingPathComponent("package.json").path) {
                return url
            }
        }
        throw InstallError.message(
            "No host source found. Set Source package to your ClankerSpanker checkout's host/ folder (not \(installRoot.path)). The installed host was not touched."
        )
    }

    nonisolated private static func findNode() -> String {
        for c in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"] {
            if FileManager.default.isExecutableFile(atPath: c) { return c }
        }
        return "/usr/local/bin/node"
    }

    @discardableResult
    nonisolated static func run(cmd: String, args: [String], log: (String) -> Void) throws -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: cmd)
        p.arguments = args
        let out = Pipe()
        let err = Pipe()
        p.standardOutput = out
        p.standardError = err
        log("+ \(cmd) \(args.joined(separator: " "))")
        try p.run()
        p.waitUntilExit()
        let stdout = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let stderr = String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        if !stdout.isEmpty { log(stdout.trimmingCharacters(in: .whitespacesAndNewlines)) }
        if !stderr.isEmpty { log(stderr.trimmingCharacters(in: .whitespacesAndNewlines)) }
        if p.terminationStatus != 0 {
            throw InstallError.message("Command failed (\(p.terminationStatus)): \(cmd)")
        }
        return stdout
    }

    nonisolated private static func shellQuote(_ s: String) -> String {
        "'\(s.replacingOccurrences(of: "'", with: "'\\''"))'"
    }

    enum InstallError: LocalizedError {
        case message(String)
        var errorDescription: String? {
            switch self {
            case .message(let s): return s
            }
        }
    }
}
#endif
