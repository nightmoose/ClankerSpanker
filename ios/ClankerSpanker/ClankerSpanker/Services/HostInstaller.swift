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
        let src = try resolveSource(source, log: log)
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
                    "\(standalone) is already loaded (repo host at ~/Projects/ClankerSpanker/host). Confirm from the Host panel to replace it, or leave it as your gateway."
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
