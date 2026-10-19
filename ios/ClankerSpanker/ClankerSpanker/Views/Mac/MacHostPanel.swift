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
    /// True while the "Install / update host" confirm alert is up. Only shown
    /// when the repo-standalone agent (`com.nightmoose.grok-dispatch-host`)
    /// is loaded — installing would boot it out and hand the port to the
    /// Application Support copy.
    @State private var confirmTakeover = false
    @State private var repoUpdate: APIClient.HostUpdateStatus?
    @State private var repoUpdateBusy = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                header

                installCard

                repoUpdateCard

                HStack(alignment: .top, spacing: 16) {
                    processCard
                        .frame(maxWidth: .infinity, alignment: .leading)
                    connectionCard
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                profilesCard
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
        .navigationSubtitle("Gateway is a LaunchAgent — install ClankerSpanker Host Tray for menu-bar controls without this app")
        #endif
        .task {
            await host.refreshStatus()
            await refreshRepoUpdate()
        }
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
                // RFC-064: read the published snapshot only. A launchctl call
                // here ran inside SwiftUI's update and crashed the app.
                labeled("Installed package", installedLabel)
                labeled("LaunchAgent", agentLabel)
                labeled("Config", LocalHostConfigFile.configURL.path)

                if host.service?.recovery == .loadAppAgent {
                    Text("The LaunchAgent plist is installed but launchd has not loaded it, so the gateway is down. Click Load LaunchAgent.")
                        .font(.callout)
                        .foregroundStyle(DispatchColors.danger)
                        .fixedSize(horizontal: false, vertical: true)
                }

                HStack(spacing: 10) {
                    Button {
                        if repoAgentLoaded {
                            confirmTakeover = true
                        } else {
                            Task { await runInstall(loadAgent: true, takeover: false) }
                        }
                    } label: {
                        if installBusy { ProgressView() } else { Text("Install / update host") }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(installBusy)

                    Button("Load LaunchAgent") {
                        if repoAgentLoaded {
                            confirmTakeover = true
                        } else {
                            Task { await runLoadAgent(takeover: false) }
                        }
                    }
                    .disabled(installBusy || host.service?.packageInstalled != true)

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
                .alert("Replace repo-standalone host?", isPresented: $confirmTakeover) {
                    Button("Cancel", role: .cancel) { }
                    Button("Replace", role: .destructive) {
                        Task { await runInstall(loadAgent: true, takeover: true) }
                    }
                } message: {
                    Text("com.nightmoose.grok-dispatch-host is loaded and serving the port from ~/Projects/ClankerSpanker/host. Installing will boot that agent out and hand the port to the Application Support copy managed by this app.")
                }

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

    private var repoUpdateCard: some View {
        GroupBox("Update from the git repo") {
            VStack(alignment: .leading, spacing: 12) {
                Text(repoUpdate?.summary ?? "Checking the checkout…")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let repo = repoUpdate?.repoDir {
                    labeled("Checkout", repo)
                }
                if let upstream = repoUpdate?.upstream {
                    labeled("Upstream", upstream)
                }
                HStack(spacing: 10) {
                    Button(repoUpdateBusy ? "Updating…" : "Update from repo") {
                        Task { await applyRepoUpdate() }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(repoUpdateBusy || repoUpdate?.canApply != true)
                    Button("Check again") {
                        Task { await refreshRepoUpdate() }
                    }
                    .disabled(repoUpdateBusy)
                }
                .controlSize(.large)
                Text("Fast-forwards a clean checkout, rebuilds, and restarts the LaunchAgent. Dirty or diverged branches are left alone. Set \"autoUpdate\": true in config.json to do this when no session is running.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(4)
        }
    }

    private func refreshRepoUpdate() async {
        let endpoint = HostEndpoint(name: "This Mac", baseURL: host.localBaseURL)
        do {
            repoUpdate = try await appState.api.hostUpdate(host: endpoint)
        } catch {
            repoUpdate = nil
            statusNote = error.localizedDescription
        }
    }

    private func applyRepoUpdate() async {
        repoUpdateBusy = true
        defer { repoUpdateBusy = false }
        let endpoint = HostEndpoint(name: "This Mac", baseURL: host.localBaseURL)
        do {
            let result = try await appState.api.applyHostUpdate(host: endpoint)
            repoUpdate = result.status
            statusNote = result.ok
                ? "Update started. The gateway will drop offline briefly, then come back."
                : (result.error ?? result.status.summary)
        } catch {
            statusNote = error.localizedDescription
        }
    }

    private var processCard: some View {
        GroupBox("Process") {
            VStack(alignment: .leading, spacing: 12) {
                labeled("API", host.apiReachable ? "Reachable ✓" : "Down")
                labeled("Gateway process", host.processStatusLabel)

                if host.apiReachable {
                    Text("The gateway is a LaunchAgent — it survives quitting this app and reboots. Sessions stay live.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                HStack(spacing: 10) {
                    Button("Kickstart host") { Task { await host.start() } }
                        .buttonStyle(.borderedProminent)
                        .disabled(host.apiReachable)
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

    private var profilesCard: some View {
        MacProfilesSection(loopbackHost: HostEndpoint(name: "This Mac", baseURL: host.localBaseURL))
            .environmentObject(appState)
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
                    Button("Save") { saveSourcePath(host.hostPackagePath) }
                }
            }
            .padding(4)
        }
    }

    private var logsCard: some View {
        GroupBox("Runtime logs (this session)") {
            ScrollView {
                Text(host.logs.isEmpty ? "(no in-app messages — LaunchAgent logs: ~/Library/Logs/clankerspanker-host.log or ~/Library/Logs/grok-dispatch-host.log)" : host.logs.suffix(80).joined(separator: "\n"))
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
            }
            .frame(minHeight: 120, maxHeight: 220)
            .padding(4)
        }
    }

    private var installedLabel: String {
        guard let service = host.service else { return "Checking…" }
        return service.packageInstalled ? HostInstaller.installRoot.path : "Not installed"
    }

    private var agentLabel: String {
        guard let service = host.service else { return "Checking…" }
        if service.appAgentLoaded { return "Loaded · \(HostInstaller.label)" }
        return service.plistPresent ? "Not loaded (plist present)" : "Not loaded"
    }

    /// Appends from any thread, in order.
    private func appendInstallLog(_ line: String) {
        DispatchQueue.main.async { installLog.append(line) }
    }

    /// Marks a deliberate LaunchAgent change so launch-time recovery stays out of the way.
    private func beginServiceChange() {
        installBusy = true
        host.serviceChangeInProgress = true
    }

    private func endServiceChange() {
        installBusy = false
        host.serviceChangeInProgress = false
    }

    /// True when the repo-standalone LaunchAgent is the currently-loaded one.
    /// The Install / Load buttons prompt for confirmation before evicting it.
    private var repoAgentLoaded: Bool {
        host.loadedAgentLabel == "com.nightmoose.grok-dispatch-host"
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
            saveSourcePath(url.path)
        }
    }

    /// RFC-063: the install root is never a valid source.
    private func saveSourcePath(_ path: String) {
        if host.savePackagePath(path) {
            host.lastError = nil
            statusNote = "Source path set"
        } else {
            statusNote = nil
            host.lastError = "\(path) is where the host gets installed, not a source. Pick your ClankerSpanker checkout's host/ folder."
        }
    }

    @MainActor
    private func runInstall(loadAgent: Bool, takeover: Bool) async {
        beginServiceChange()
        installLog = []
        defer { endServiceChange() }
        do {
            host.lastError = nil
            // RFC-063: an install-root path here is ignored; resolveSource clears it.
            let path = host.hostPackagePath
            let source = path.isEmpty || HostInstaller.isInstallRootPath(path) ? nil : URL(fileURLWithPath: path)
            // RFC-064: build, npm and launchctl run off the main thread.
            try await HostInstaller.install(
                fromSource: source,
                loadLaunchAgent: loadAgent,
                takeoverStandalone: takeover,
                log: appendInstallLog
            )
            // RFC-027: HostInstaller already saved the source path. Saving the
            // install root here made the next update install from itself.
            await host.refreshStatus()
            if let pair = await host.bootstrapLocalHost() {
                appState.saveConfiguration(hostURL: pair.url, hostToken: pair.token, xaiKey: nil)
                await appState.refreshSessions()
            }
            statusNote = "Host installed to Application Support"
        } catch {
            host.lastError = error.localizedDescription
            appendInstallLog("ERROR: \(error.localizedDescription)")
            await host.refreshStatus()
        }
    }

    @MainActor
    private func runLoadAgent(takeover: Bool) async {
        beginServiceChange()
        defer { endServiceChange() }
        do {
            try await HostInstaller.loadLaunchAgent(takeoverStandalone: takeover, log: appendInstallLog)
            await host.refreshStatus()
            statusNote = "LaunchAgent loaded"
        } catch {
            host.lastError = error.localizedDescription
        }
    }

    @MainActor
    private func runUnloadAgent() async {
        beginServiceChange()
        defer { endServiceChange() }
        do {
            try await HostInstaller.unloadLaunchAgent(log: appendInstallLog)
            await host.refreshStatus()
            statusNote = "LaunchAgent unloaded"
        } catch {
            host.lastError = error.localizedDescription
        }
    }

    @MainActor
    private func runUninstall() async {
        beginServiceChange()
        defer { endServiceChange() }
        do {
            try await HostInstaller.uninstall(removeFiles: true, log: appendInstallLog)
            await host.refreshStatus()
            statusNote = "Host package removed from Application Support"
        } catch {
            host.lastError = error.localizedDescription
        }
    }
}
#endif
