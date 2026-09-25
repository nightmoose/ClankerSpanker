#if os(macOS)
import Foundation
import AppKit

/// Installs the Node host into Application Support and manages a user LaunchAgent.
/// Source can be a monorepo `host/` checkout; install root is not a git tree.
@MainActor
enum HostInstaller {
    static var installRoot: URL { LocalHostConfigFile.installedHostRoot }
    static var label: String { LocalHostConfigFile.launchAgentLabel }
    static var plistURL: URL { LocalHostConfigFile.launchAgentPlistURL }

    static var isInstalled: Bool {
        FileManager.default.fileExists(
            atPath: installRoot.appendingPathComponent("dist/index.js").path
        )
    }

    static var launchAgentLoaded: Bool {
        let pipe = Pipe()
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        p.arguments = ["print", "gui/\(getuid())/\(label)"]
        p.standardOutput = pipe
        p.standardError = pipe
        do {
            try p.run()
            p.waitUntilExit()
            return p.terminationStatus == 0
        } catch {
            return false
        }
    }

    /// Copy/build host into Application Support and optionally load launchd.
    /// `takeoverStandalone` boots out `com.nightmoose.grok-dispatch-host`
    /// first if it is loaded — required because both agents bind port 8787.
    static func install(
        fromSource source: URL?,
        loadLaunchAgent: Bool = true,
        takeoverStandalone: Bool = false,
        log: (String) -> Void = { _ in }
    ) throws {
        let fm = FileManager.default
        let src = try resolveSource(source)
        log("Source: \(src.path)")

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

        try fm.createDirectory(at: installRoot, withIntermediateDirectories: true)
        // Fresh package tree. `web/` is the /app/ UI (not emitted by tsc).
        for name in ["dist", "web", "package.json", "package-lock.json", "node_modules"] {
            let dest = installRoot.appendingPathComponent(name)
            if fm.fileExists(atPath: dest.path) {
                try? fm.removeItem(at: dest)
            }
        }

        log("Copying dist + web + package manifests…")
        try copyItem(src.appendingPathComponent("dist"), to: installRoot.appendingPathComponent("dist"))
        let web = src.appendingPathComponent("web")
        if fm.fileExists(atPath: web.path) {
            try copyItem(web, to: installRoot.appendingPathComponent("web"))
        }
        try copyItem(src.appendingPathComponent("package.json"), to: installRoot.appendingPathComponent("package.json"))
        let lock = src.appendingPathComponent("package-lock.json")
        if fm.fileExists(atPath: lock.path) {
            try copyItem(lock, to: installRoot.appendingPathComponent("package-lock.json"))
        }

        log("npm install --omit=dev in install root…")
        try run(
            cmd: "/bin/bash",
            args: ["-lc", "cd \(shellQuote(installRoot.path)) && npm install --omit=dev"],
            log: log
        )

        // Ensure config exists
        _ = LocalHostConfigFile.readToken()
        if !fm.fileExists(atPath: LocalHostConfigFile.configURL.path) {
            try LocalHostConfigFile.mergeProjects([])
        }

        if loadLaunchAgent {
            try installLaunchAgent(takeoverStandalone: takeoverStandalone, log: log)
        }

        // RFC-027: remember where we installed FROM. Saving installRoot made the
        // next update copy the install root onto itself and delete dist/.
        LocalHostController.shared.savePackagePath(src.path)
        log("Installed host → \(installRoot.path)")
    }

    static func uninstall(removeFiles: Bool = false, log: (String) -> Void = { _ in }) throws {
        try unloadLaunchAgent(log: log)
        if removeFiles {
            if FileManager.default.fileExists(atPath: installRoot.path) {
                try FileManager.default.removeItem(at: installRoot)
                log("Removed \(installRoot.path)")
            }
        }
    }

    static func installLaunchAgent(
        takeoverStandalone: Bool = false,
        log: (String) -> Void = { _ in }
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
        let standalone = "com.nightmoose.grok-dispatch-host"
        let (standaloneLoaded, _) = LocalHostController.launchctl(
            ["print", "gui/\(uid)/\(standalone)"]
        )
        if standaloneLoaded {
            if !takeoverStandalone {
                throw InstallError.message(
                    "\(standalone) is already loaded (repo host at ~/Projects/GrokDispatch/host). Confirm from the Host panel to replace it, or leave it as your gateway."
                )
            }
            log("Booting out repo agent \(standalone) so the app-managed one can take the port…")
            _ = try? run(
                cmd: "/bin/launchctl",
                args: ["bootout", "gui/\(uid)/\(standalone)"],
                log: log
            )
        }

        try plist.write(to: plistURL, atomically: true, encoding: .utf8)
        log("Wrote \(plistURL.path)")

        // bootout any stale copy of the app-managed agent, then bootstrap.
        _ = try? run(cmd: "/bin/launchctl", args: ["bootout", "gui/\(uid)/\(label)"], log: log)
        try run(cmd: "/bin/launchctl", args: ["bootstrap", "gui/\(uid)", plistURL.path], log: log)
        _ = try? run(cmd: "/bin/launchctl", args: ["enable", "gui/\(uid)/\(label)"], log: log)
        _ = try? run(cmd: "/bin/launchctl", args: ["kickstart", "-k", "gui/\(uid)/\(label)"], log: log)
        log("LaunchAgent \(label) loaded")
    }

    static func unloadLaunchAgent(log: (String) -> Void = { _ in }) throws {
        let uid = getuid()
        _ = try? run(cmd: "/bin/launchctl", args: ["bootout", "gui/\(uid)/\(label)"], log: log)
        if FileManager.default.fileExists(atPath: plistURL.path) {
            try FileManager.default.removeItem(at: plistURL)
            log("Removed LaunchAgent plist")
        }
    }

    // MARK: - helpers

    private static func resolveSource(_ source: URL?) throws -> URL {
        let installed = (installRoot.path as NSString).standardizingPath
        let candidates = [
            source?.path ?? "",
            LocalHostController.shared.hostPackagePath,
            LocalHostConfigFile.homeDirectory.appendingPathComponent("Projects/GrokDispatch/host").path,
            LocalHostConfigFile.homeDirectory.appendingPathComponent("Projects/ClankerSpanker/host").path,
        ]
        .filter { !$0.isEmpty }
        // RFC-027: never install the install root onto itself.
        .filter { ($0 as NSString).standardizingPath != installed }
        for c in candidates {
            let url = URL(fileURLWithPath: c)
            if FileManager.default.fileExists(atPath: url.appendingPathComponent("package.json").path) {
                return url
            }
        }
        throw InstallError.message(
            "No host source found. Point Host package path at your ClankerSpanker checkout's host/ folder."
        )
    }

    private static func copyItem(_ from: URL, to: URL) throws {
        try FileManager.default.copyItem(at: from, to: to)
    }

    private static func findNode() -> String {
        for c in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"] {
            if FileManager.default.isExecutableFile(atPath: c) { return c }
        }
        return "/usr/local/bin/node"
    }

    @discardableResult
    private static func run(cmd: String, args: [String], log: (String) -> Void) throws -> String {
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

    private static func shellQuote(_ s: String) -> String {
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
