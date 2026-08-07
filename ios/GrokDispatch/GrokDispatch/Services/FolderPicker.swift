#if os(macOS)
import AppKit
import Foundation

/// Multi-folder picker for host project paths (absolute dirs the CLI can use).
enum FolderPicker {
    /// Pick one or more directories anywhere on the machine.
    static func pickDirectories(
        message: String = "Choose project folders the agent may use",
        prompt: String = "Add",
        canCreate: Bool = true
    ) -> [URL] {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = true
        panel.canCreateDirectories = canCreate
        panel.treatsFilePackagesAsDirectories = true
        panel.message = message
        panel.prompt = prompt
        // Start in a useful place if it exists
        let projects = LocalHostConfigFile.homeDirectory.appendingPathComponent("Projects")
        if FileManager.default.fileExists(atPath: projects.path) {
            panel.directoryURL = projects
        }
        guard panel.runModal() == .OK else { return [] }
        return panel.urls.filter { url in
            var isDir: ObjCBool = false
            return FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir) && isDir.boolValue
        }
    }

    /// Persist folders into host config as projects; returns paths added.
    static func pickAndRegisterProjects() throws -> [String] {
        let urls = pickDirectories()
        guard !urls.isEmpty else { return [] }
        let folders = urls.map { url -> (id: String, name: String, path: String) in
            let path = url.path
            let name = url.lastPathComponent
            let id = slug(name) + "-" + String(abs(path.hashValue), radix: 16)
            return (id, name, path)
        }
        _ = try LocalHostConfigFile.mergeProjects(folders)
        return folders.map(\.path)
    }

    private static func slug(_ s: String) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))
        let mapped = s.lowercased().unicodeScalars.map { allowed.contains($0) ? Character($0) : "-" }
        return String(mapped).replacingOccurrences(of: "--+", with: "-", options: .regularExpression)
    }
}
#endif
