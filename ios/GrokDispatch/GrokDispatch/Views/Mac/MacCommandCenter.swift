#if os(macOS)
import SwiftUI
import AppKit

// MARK: - Root (Bricklayer-shaped: list | detail, toolbar, sheets)

/// Native Mac command center. Not TabView. Not phone chrome.
struct MacCommandCenter: View {
    @EnvironmentObject private var appState: AppState
    @StateObject private var listVM = DashboardViewModel()
    @ObservedObject private var localHost = LocalHostController.shared

    @State private var showArchived = false
    @State private var search = ""
    @State private var showCompose = false
    @State private var showSettings = false
    @State private var showHost = false
    @State private var bootstrapMessage: String?
    @State private var isBootstrapping = false

    var body: some View {
        NavigationSplitView {
            sessionSidebar
                .navigationSplitViewColumnWidth(min: 280, ideal: 320, max: 420)
        } detail: {
            sessionDetail
        }
        .navigationSplitViewStyle(.balanced)
        .toolbar { toolbarContent }
        .background(Color(nsColor: .windowBackgroundColor))
        .sheet(isPresented: $showCompose) {
            MacComposeSheet()
                .environmentObject(appState)
                .frame(minWidth: 560, minHeight: 520)
        }
        .sheet(isPresented: $showSettings) {
            NavigationStack {
                MacSettingsPane()
                    .environmentObject(appState)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Done") { showSettings = false }
                                .keyboardShortcut(.cancelAction)
                        }
                    }
            }
            .frame(minWidth: 520, minHeight: 480)
        }
        .sheet(isPresented: $showHost) {
            NavigationStack {
                MacHostPanel()
                    .environmentObject(appState)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Done") { showHost = false }
                                .keyboardShortcut(.cancelAction)
                        }
                    }
            }
            .frame(minWidth: 640, minHeight: 520)
        }
        .task { await bootstrapAndLoad() }
        .onReceive(NotificationCenter.default.publisher(for: .dispatchSocketEvent)) { _ in
            Task { await listVM.load(appState: appState) }
        }
        .onReceive(NotificationCenter.default.publisher(for: .macShowCompose)) { _ in
            showCompose = true
        }
        .onReceive(NotificationCenter.default.publisher(for: .macShowHost)) { _ in
            showHost = true
        }
        .onReceive(NotificationCenter.default.publisher(for: .macShowSettings)) { _ in
            showSettings = true
        }
    }

    // MARK: Sidebar

    private var sessionSidebar: some View {
        VStack(spacing: 0) {
            HStack {
                Text(showArchived ? "Archived" : "Sessions")
                    .font(.title3.weight(.bold))
                Spacer()
                Text("\(filteredRows.count)")
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(Capsule().fill(DispatchColors.accent.opacity(0.18)))
                    .foregroundStyle(DispatchColors.accent)
            }
            .padding(.horizontal, 16)
            .padding(.top, 14)
            .padding(.bottom, 8)

            // Profile filter (when we have profiles)
            if !appState.boundProfiles.isEmpty {
                ProfileSegmentBar()
                    .padding(.horizontal, 12)
                    .padding(.bottom, 8)
            }

            Picker("List", selection: $showArchived) {
                Text("Active").tag(false)
                Text("Archived").tag(true)
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 16)
            .padding(.bottom, 8)

            if isBootstrapping {
                ProgressView("Connecting to local host…")
                    .controlSize(.small)
                    .padding(.bottom, 8)
            }

            if let bootstrapMessage {
                Text(bootstrapMessage)
                    .font(.caption)
                    .foregroundStyle(DispatchColors.danger)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 6)
            }

            if let err = listVM.errorMessage ?? appState.lastRefreshError {
                Text(err)
                    .font(.caption)
                    .foregroundStyle(DispatchColors.danger)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 6)
                    .textSelection(.enabled)
            }

            Divider()

            if filteredRows.isEmpty && !listVM.isLoading && !isBootstrapping {
                VStack(spacing: 12) {
                    Spacer()
                    Image(systemName: "rectangle.stack")
                        .font(.system(size: 40, weight: .light))
                        .foregroundStyle(.secondary)
                    Text(showArchived ? "No archived sessions" : "No sessions yet")
                        .font(.headline)
                    Text(emptyHint)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 20)
                    if appState.hosts.isEmpty || appState.selectedHost?.loadToken().isEmpty == true {
                        Button("Connect local host") {
                            Task { await bootstrapAndLoad() }
                        }
                        .buttonStyle(.borderedProminent)
                    } else if !showArchived {
                        Button("New task") { showCompose = true }
                            .buttonStyle(.borderedProminent)
                    }
                    Spacer()
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List(selection: $appState.macSelectedSessionId) {
                    ForEach(filteredRows) { session in
                        MacSessionRow(session: session)
                            .tag(session.id)
                            .contextMenu {
                                if showArchived {
                                    Button("Unarchive") {
                                        Task { await listVM.unarchive(sessionId: session.id, appState: appState) }
                                    }
                                } else {
                                    Button("Archive") {
                                        Task {
                                            await listVM.archive(sessionId: session.id, appState: appState)
                                            if appState.macSelectedSessionId == session.id {
                                                appState.macSelectedSessionId = nil
                                            }
                                        }
                                    }
                                }
                            }
                    }
                }
                .listStyle(.sidebar)
            }
        }
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.5))
        .searchable(text: $search, placement: .sidebar, prompt: "Filter sessions")
    }

    private var emptyHint: String {
        if appState.hosts.isEmpty {
            return "No host configured. This Mac can run the gateway — connect to it."
        }
        if appState.selectedHost?.loadToken().isEmpty == true {
            return "Host has no token in Keychain. Reconnect local host."
        }
        return showArchived
            ? "Archive from the session menu when a chat is done."
            : "Dispatch a task to put an agent to work."
    }

    // MARK: Detail

    @ViewBuilder
    private var sessionDetail: some View {
        if let id = appState.macSelectedSessionId, let host = appState.selectedHost {
            SessionDetailView(sessionId: id, host: host)
                .id("\(host.id.uuidString)-\(id)")
        } else {
            VStack(spacing: 16) {
                Spacer()
                Image(systemName: "text.bubble")
                    .font(.system(size: 48, weight: .ultraLight))
                    .foregroundStyle(.secondary)
                Text("Select a session")
                    .font(.title2.weight(.semibold))
                Text("Or start a new agent task on this machine.")
                    .foregroundStyle(.secondary)
                Button {
                    showCompose = true
                } label: {
                    Label("New task", systemImage: "plus.circle.fill")
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color(nsColor: .windowBackgroundColor))
        }
    }

    // MARK: Toolbar

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .navigation) {
            HStack(spacing: 8) {
                Image(systemName: "bolt.circle.fill")
                    .font(.title2)
                    .foregroundStyle(DispatchColors.accent)
                Text("ClankerSpanker")
                    .font(.headline.weight(.bold))
            }
        }
        ToolbarItemGroup(placement: .primaryAction) {
            Button {
                showCompose = true
            } label: {
                Label("New Task", systemImage: "plus.circle.fill")
            }
            .labelStyle(.titleAndIcon)

            Button {
                Task { await listVM.load(appState: appState) }
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .help("Refresh sessions")

            Button {
                showHost = true
            } label: {
                Image(systemName: "server.rack")
            }
            .help("Local host control")

            Button {
                showSettings = true
            } label: {
                Image(systemName: "gearshape")
            }
            .help("Settings")
        }
        ToolbarItem(placement: .status) {
            MacStatusPill(
                apiUp: localHost.apiReachable || appState.socket.isConnected,
                wsLive: appState.socket.isConnected,
                hostName: appState.selectedHost?.name,
                processLabel: localHost.isRunning
                    ? "app-owned"
                    : (localHost.apiReachable ? "external" : "down")
            )
        }
    }

    // MARK: Data

    private var filteredRows: [SessionSummary] {
        let base = showArchived ? appState.archivedSessions : appState.sessions
        let profiled = base.filter { matchesProfile($0) }
        let q = search.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return profiled }
        return profiled.filter {
            $0.title.lowercased().contains(q)
                || $0.prompt.lowercased().contains(q)
                || $0.cwd.lowercased().contains(q)
        }
    }

    private func matchesProfile(_ s: SessionSummary) -> Bool {
        appState.sessionMatchesSelectedProfile(s)
    }

    private func bootstrapAndLoad() async {
        isBootstrapping = true
        bootstrapMessage = nil
        defer { isBootstrapping = false }

        do {
            try await appState.ensureLocalHostOnMac()
            await localHost.refreshStatus()
            await listVM.load(appState: appState)
            if appState.sessions.isEmpty && appState.lastRefreshError == nil {
                // still empty is fine — host has no chats
            }
        } catch {
            bootstrapMessage = error.localizedDescription
            // Still try load with whatever hosts we have
            await listVM.load(appState: appState)
        }
    }
}

// MARK: - Status pill

private struct MacStatusPill: View {
    let apiUp: Bool
    let wsLive: Bool
    let hostName: String?
    /// app-owned | external | down
    let processLabel: String

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(apiUp ? DispatchColors.success : Color.orange)
                .frame(width: 8, height: 8)
            Text(statusText)
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(Capsule().fill(Color.primary.opacity(0.06)))
        .help(helpText)
    }

    private var statusText: String {
        if wsLive { return "Live · \(hostName ?? "host")" }
        if apiUp { return "API up · \(processLabel)" }
        return "Offline"
    }

    private var helpText: String {
        [
            apiUp ? "Host API reachable" : "Host API not reachable",
            wsLive ? "WebSocket connected" : "WebSocket down",
            "Gateway: \(processLabel)",
        ].joined(separator: " · ")
    }
}

// MARK: - Session row

private struct MacSessionRow: View {
    let session: SessionSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(session.title)
                    .font(.body.weight(.semibold))
                    .lineLimit(1)
                Spacer(minLength: 4)
                StatusBadge(status: session.status)
            }
            Text((session.transcriptPreview?.isEmpty == false) ? session.transcriptPreview! : session.prompt)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
            HStack(spacing: 10) {
                if let name = session.profileName, !name.isEmpty {
                    Text(name)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(Color(hex: session.profileColor ?? "") ?? DispatchColors.accent)
                }
                Text(shortPath(session.cwd))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                if session.isLive == true {
                    Text("LIVE")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(DispatchColors.accent)
                }
            }
        }
        .padding(.vertical, 4)
    }

    private func shortPath(_ path: String) -> String {
        if let r = path.range(of: "/Projects/") { return String(path[r.upperBound...]) }
        return (path as NSString).lastPathComponent
    }
}

// MARK: - Compose as sheet

private struct MacComposeSheet: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss
    @StateObject private var vm = ComposerViewModel()

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("New task")
                    .font(.title2.weight(.bold))
                Spacer()
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
            }
            .padding()

            Divider()

            MacComposePane()
                .environmentObject(appState)
        }
        .onChange(of: appState.macSelectedSessionId) { _, newId in
            // MacComposePane sets tab + session; close sheet when dispatch succeeds
            if newId != nil { dismiss() }
        }
    }
}

#endif
