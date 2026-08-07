#if os(macOS)
import SwiftUI
import AppKit

/// First-class Mac host control — install, launchd, process, projects, logs.
struct MacHostPanel: View {
    @EnvironmentObject private var appState: AppState
    @ObservedObject private var host = LocalHostController.shared
    @State private var statusNote: String?
    @State private var installBusy = false
    @State private var installLog: [String] = []

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                header

                installCard

                HStack(alignment: .top, spacing: 16) {
                    processCard
                        .frame(maxWidth: .infinity, alignment: .leading)
                    connectionCard
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                projectsCard
                packageCard
                logsCard

                if let statusNote {
                    Text(statusNote)
                        .font(.callout)
                        .foregroundStyle(DispatchColors.success)
                }
                if let err = host.lastError, !err.isEmpty {
                    Text(err)
                        .font(.callout)
                        .foregroundStyle(DispatchColors.danger)
                        .textSelection(.enabled)
                }
            }
            .padding(24)
            .frame(maxWidth: 920, alignment: .leading)
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .navigationTitle("Host")
        #if os(macOS)
        .navigationSubtitle("Close with Done — app stays in the menu bar")
        #endif
        .task { await host.refreshStatus() }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Local host gateway")
                .font(.largeTitle.weight(.bold))
            Text("Install the gateway into Application Support (not your git checkout), run it via LaunchAgent, and manage project folders agents may use.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var installCard: some View {
        GroupBox("Install & service") {
            VStack(alignment: .leading, spacing: 12) {
                labeled("Installed package", HostInstaller.isInstalled ? HostInstaller.installRoot.path : "Not installed")
                labeled("LaunchAgent", HostInstaller.launchAgentLoaded ? "Loaded · \(HostInstaller.label)" : "Not loaded")
                labeled("Config", LocalHostConfigFile.configURL.path)

                HStack(spacing: 10) {
                    Button {
                        Task { await runInstall(loadAgent: true) }
                    } label: {
                        if installBusy { ProgressView() } else { Text("Install / update host") }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(installBusy)

                    Button("Load LaunchAgent") {
                        Task { await runLoadAgent() }
                    }
                    .disabled(installBusy || !HostInstaller.isInstalled)

                    Button("Unload LaunchAgent", role: .destructive) {
                        Task { await runUnloadAgent() }
                    }
                    .disabled(installBusy)

                    Button("Uninstall files…", role: .destructive) {
                        Task { await runUninstall() }
                    }
                    .disabled(installBusy)
                }
                .controlSize(.large)

                Text("Copies a built `host/` into \(HostInstaller.installRoot.path), runs `npm install --omit=dev`, and registers a per-user LaunchAgent that survives reboots.")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                if !installLog.isEmpty {
                    ScrollView {
                        Text(installLog.suffix(40).joined(separator: "\n"))
                            .font(.system(.caption2, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .textSelection(.enabled)
                    }
                    .frame(maxHeight: 120)
                }
            }
            .padding(4)
        }
    }

    private var processCard: some View {
        GroupBox("Process") {
            VStack(alignment: .leading, spacing: 12) {
                labeled("API", host.apiReachable ? "Reachable ✓" : "Down")
                labeled("Gateway process", host.processStatusLabel)

                if host.apiReachable && !host.isRunning {
                    Text("Something is already serving \(host.localBaseURL) (often LaunchAgent or a terminal). Sessions still work.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                HStack(spacing: 10) {
                    Button("Start host") { host.start() }
                        .buttonStyle(.borderedProminent)
                        .disabled(host.isRunning || host.apiReachable)
                    Button("Stop (app-owned)") { host.stop() }
                        .disabled(!host.isRunning)
                    Button("Refresh") {
                        Task { await host.refreshStatus() }
                    }
                }
                .controlSize(.large)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(4)
        }
    }

    private var connectionCard: some View {
        GroupBox("App connection") {
            VStack(alignment: .leading, spacing: 12) {
                labeled("Local URL", host.localBaseURL)
                labeled(
                    "Token",
                    host.readHostToken().map { String($0.prefix(12)) + "…" } ?? "(none in config)"
                )
                Button("Connect app to this host") {
                    Task {
                        if let pair = await host.bootstrapLocalHost() {
                            appState.saveConfiguration(hostURL: pair.url, hostToken: pair.token, xaiKey: nil)
                            await appState.refreshSessions()
                            statusNote = "Connected to \(pair.url)"
                        }
                    }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(4)
        }
    }

    private var projectsCard: some View {
        GroupBox("Project folders") {
            VStack(alignment: .leading, spacing: 10) {
                Text("Absolute directories on this Mac that agents may use as working trees (written to host config).")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                HStack {
                    Button {
                        do {
                            let paths = try FolderPicker.pickAndRegisterProjects()
                            if paths.isEmpty {
                                statusNote = "No folders selected"
                            } else {
                                statusNote = "Added \(paths.count) project folder(s). Restart host / LaunchAgent if the list is stale."
                                Task { await appState.refreshSessions() }
                            }
                        } catch {
                            statusNote = nil
                            installLog.append("ERROR: \(error.localizedDescription)")
                        }
                    } label: {
                        Label("Add folders…", systemImage: "folder.badge.plus")
                    }
                    .buttonStyle(.borderedProminent)
                }
                Text("Multi-select any folders the CLI can access. Paths are stored in ~/.grok-dispatch/config.json.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .padding(4)
        }
    }

    private var packageCard: some View {
        GroupBox("Source package (for install)") {
            VStack(alignment: .leading, spacing: 10) {
                Text("Dev checkout used as the *source* when installing into Application Support.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                HStack(spacing: 8) {
                    TextField("…/GrokDispatch/host", text: $host.hostPackagePath)
                        .textFieldStyle(.roundedBorder)
                    Button("Browse…") { pickPackageFolder() }
                    Button("Save") {
                        host.savePackagePath(host.hostPackagePath)
                        statusNote = "Saved source path"
                    }
                }
            }
            .padding(4)
        }
    }

    private var logsCard: some View {
        GroupBox("Runtime logs (app-owned process)") {
            ScrollView {
                Text(host.logs.isEmpty ? "(no process output yet — LaunchAgent logs: ~/Library/Logs/clankerspanker-host.log)" : host.logs.suffix(80).joined(separator: "\n"))
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
            }
            .frame(minHeight: 120, maxHeight: 220)
            .padding(4)
        }
    }

    private func labeled(_ title: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(width: 120, alignment: .leading)
            Text(value)
                .font(.body.monospaced())
                .textSelection(.enabled)
                .lineLimit(3)
        }
    }

    private func pickPackageFolder() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.message = "Select host *source* (repo host/ with package.json)"
        if panel.runModal() == .OK, let url = panel.url {
            host.savePackagePath(url.path)
            statusNote = "Source path set"
        }
    }

    @MainActor
    private func runInstall(loadAgent: Bool) async {
        installBusy = true
        installLog = []
        defer { installBusy = false }
        do {
            let source = host.hostPackagePath.isEmpty ? nil : URL(fileURLWithPath: host.hostPackagePath)
            try HostInstaller.install(fromSource: source, loadLaunchAgent: loadAgent) { line in
                installLog.append(line)
            }
            host.savePackagePath(HostInstaller.installRoot.path)
            await host.refreshStatus()
            if let pair = await host.bootstrapLocalHost() {
                appState.saveConfiguration(hostURL: pair.url, hostToken: pair.token, xaiKey: nil)
                await appState.refreshSessions()
            }
            statusNote = "Host installed to Application Support"
        } catch {
            host.lastError = error.localizedDescription
            installLog.append("ERROR: \(error.localizedDescription)")
        }
    }

    @MainActor
    private func runLoadAgent() async {
        installBusy = true
        defer { installBusy = false }
        do {
            try HostInstaller.installLaunchAgent { installLog.append($0) }
            await host.refreshStatus()
            statusNote = "LaunchAgent loaded"
        } catch {
            host.lastError = error.localizedDescription
        }
    }

    @MainActor
    private func runUnloadAgent() async {
        installBusy = true
        defer { installBusy = false }
        do {
            try HostInstaller.unloadLaunchAgent { installLog.append($0) }
            await host.refreshStatus()
            statusNote = "LaunchAgent unloaded"
        } catch {
            host.lastError = error.localizedDescription
        }
    }

    @MainActor
    private func runUninstall() async {
        installBusy = true
        defer { installBusy = false }
        do {
            try HostInstaller.uninstall(removeFiles: true) { installLog.append($0) }
            await host.refreshStatus()
            statusNote = "Host package removed from Application Support"
        } catch {
            host.lastError = error.localizedDescription
        }
    }
}
#endif
