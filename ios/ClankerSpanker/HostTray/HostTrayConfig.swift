import Foundation

/// Minimal duplicate of `LocalHostConfigFile` for the standalone tray
/// target. Only the read paths — the tray never writes host config.
/// Keeping this local avoids taking on the whole `ClankerSpankerMac`
/// codebase for a ~30-line surface.
enum HostTrayConfig {
    static var homeDirectory: URL {
        FileManager.default.homeDirectoryForCurrentUser
    }

    static var configURL: URL {
        homeDirectory
            .appendingPathComponent(".grok-dispatch")
            .appendingPathComponent("config.json")
    }

    static func readBindPort() -> Int {
        guard let data = try? Data(contentsOf: configURL),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let port = obj["bindPort"] as? Int
        else { return 8787 }
        return port
    }
}

/// Thin wrapper around `/bin/launchctl` — returns (success, stdout+stderr).
enum HostTrayLaunchctl {
    @discardableResult
    static func run(_ args: [String]) -> (ok: Bool, output: String) {
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
}
