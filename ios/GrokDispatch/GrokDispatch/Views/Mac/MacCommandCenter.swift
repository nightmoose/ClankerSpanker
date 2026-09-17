#if os(macOS)
import SwiftUI
import AppKit

// MARK: - Root (Bricklayer-shaped: list | detail, toolbar, sheets)

/// Top-level sections in the Mac command center (in-app tabs, not a second app).
private enum MacRootTab: String, CaseIterable, Identifiable {
    case sessions
    case bots

    var id: String { rawValue }

    var label: String {
        switch self {
        case .sessions: return "Sessions"
        case .bots: return "Bots"
        }
    }
}

/// Sidebar list scope for the Mac command center.
private enum SessionListMode: String, CaseIterable, Identifiable {
    case recent
    case active
    case archived

    var id: String { rawValue }

    var label: String {
        switch self {
        case .recent: return "Recent"
        case .active: return "Active"
        case .archived: return "Archived"
        }
    }
}

/// Native Mac command center. Not TabView. Not phone chrome.
struct MacCommandCenter: View {
    @EnvironmentObject private var appState: AppState
    @StateObject private var listVM = DashboardViewModel()
    @StateObject private var botsVM = BotsViewModel()
    @ObservedObject private var localHost = LocalHostController.shared

    /// Default: last 5 active sessions (by updatedAt).
    @State private var listMode: SessionListMode = .recent
    @State private var search = ""
    /// Host `?q=` hits (full summaries). nil = not searching / still loading.
    @State private var hostSearchHits: [SessionSummary]? = nil
    @State private var contentSearchTask: Task<Void, Never>? = nil
    @State private var showCompose = false
    @State private var showNewBot = false
    @State private var showSettings = false
    @State private var showHost = false
    @State private var showProjects = false
    @State private var showTasks = false
    @State private var showTerminal = false
    @State private var rootTab: MacRootTab = .sessions
    @State private var bootstrapMessage: String?
    @State private var isBootstrapping = false

    private static let recentLimit = 5

    var body: some View {
        NavigationSplitView {
            Group {
                switch rootTab {
                case .sessions:
                    sessionSidebar
                case .bots:
                    BotsSidebar(vm: botsVM, onNewBot: { showNewBot = true })
                }
            }
            .id(rootTab)
            .navigationSplitViewColumnWidth(min: 280, ideal: 320, max: 420)
        } detail: {
            switch rootTab {
            case .sessions:
                detailWithOptionalViewer
            case .bots:
                BotsDetail(vm: botsVM, onOpenSession: openBotSession, onNewBot: { showNewBot = true })
            }
        }
        .navigationSplitViewStyle(.balanced)
        .toolbar { toolbarContent }
        .background(Color(nsColor: .windowBackgroundColor))
        .background {
            // Hidden so ⌘1 / ⌘2 switch the in-app tab without extra toolbar chrome.
            Group {
                Button("Sessions Tab") { rootTab = .sessions }
                    .keyboardShortcut("1", modifiers: [.command])
                Button("Bots Tab") { rootTab = .bots }
                    .keyboardShortcut("2", modifiers: [.command])
            }
            .frame(width: 0, height: 0)
            .opacity(0)
            .allowsHitTesting(false)
        }
        .sheet(isPresented: $showCompose) {
            MacComposeSheet()
                .environmentObject(appState)
                .frame(minWidth: 560, minHeight: 520)
        }
        .sheet(isPresented: $showNewBot) {
            NewBotSheet(vm: botsVM)
                .environmentObject(appState)
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
        .sheet(isPresented: $showProjects) {
            // Reuse the cross-platform ProjectsView; it already handles Mac
            // toolbar, `.searchable`, swipeActions, and sheet-based editors.
            ProjectsView()
                .environmentObject(appState)
                .frame(minWidth: 720, minHeight: 560)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Done") { showProjects = false }
                            .keyboardShortcut(.cancelAction)
                    }
                }
        }
        .sheet(isPresented: $showTasks) {
            TasksView()
                .environmentObject(appState)
                .frame(minWidth: 640, minHeight: 520)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Done") { showTasks = false }
                            .keyboardShortcut(.cancelAction)
                    }
                }
        }
        .sheet(isPresented: $showTerminal) {
            NavigationStack {
                TerminalView()
                    .environmentObject(appState)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Done") { showTerminal = false }
                                .keyboardShortcut(.cancelAction)
                        }
                    }
            }
            .frame(minWidth: 780, minHeight: 520)
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
        .onChange(of: rootTab) { _, tab in
            if tab == .bots {
                Task { await botsVM.load(appState: appState) }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .dispatchSocketEvent)) { note in
            // Session sidebar already updates via AppState.refreshSessions.
            // Do not refetch the list on streaming chunks — that is what
            // froze the Mac client after a long Grok turn.
            guard let data = note.object as? Data,
                  let type = DispatchSocket.eventType(from: data),
                  type.hasPrefix("bot.")
            else { return }
            Task { await botsVM.load(appState: appState, quiet: true) }
        }
        .onReceive(NotificationCenter.default.publisher(for: .macShowCompose)) { _ in
            showCompose = true
        }
        .onReceive(NotificationCenter.default.publisher(for: .macShowNewBot)) { _ in
            rootTab = .bots
            showNewBot = true
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
                Text(sidebarTitle)
                    .font(.title3.weight(.bold))
                Spacer()
                // When a profile filter is on, show filtered/total so empty lanes aren't "no data"
                Text(sessionCountLabel)
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(Capsule().fill(DispatchColors.accent.opacity(0.18)))
                    .foregroundStyle(DispatchColors.accent)
                    .help(sessionCountHelp)
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

            Picker(selection: $listMode) {
                ForEach(SessionListMode.allCases) { mode in
                    Text(mode.label).tag(mode)
                }
            } label: {
                EmptyView()
            }
            .labelsHidden()
            .pickerStyle(.segmented)
            .padding(.horizontal, 16)
            .padding(.bottom, 8)

            // Always-visible search (system .searchable alone can vanish when the list is empty).
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                TextField("Search titles, paths & message content", text: $search)
                    .textFieldStyle(.plain)
                    .onChange(of: search) { _, newValue in
                        scheduleContentSearch(newValue)
                    }
                if !search.isEmpty {
                    Button {
                        search = ""
                        hostSearchHits = nil
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                    .help("Clear search")
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color(nsColor: .controlBackgroundColor)))
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .strokeBorder(Color.primary.opacity(0.08), lineWidth: 1)
            )
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

            // Always keep a List so search results have a stable surface.
            List(selection: $appState.macSelectedSessionId) {
                if filteredRows.isEmpty && diskRows.isEmpty && !listVM.isLoading && !isBootstrapping {
                    Section {
                        filterEmptyPane
                            .listRowInsets(EdgeInsets())
                            .listRowBackground(Color.clear)
                    }
                } else {
                    if !filteredRows.isEmpty {
                        Section {
                            ForEach(filteredRows) { session in
                                MacSessionRow(session: session)
                                    .tag(session.id)
                                    .contextMenu {
                                        if listMode == .archived {
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
                        } header: {
                            Text(listSectionHeader)
                        }
                    }

                    // Disk attach rows: full Active list (or when searching). Skip Recent to keep it tight.
                    if listMode != .recent || isSearching, listMode != .archived, !diskRows.isEmpty {
                        Section {
                            ForEach(diskRows) { disk in
                                Button {
                                    Task { await attachDisk(disk) }
                                } label: {
                                    MacDiskSessionRow(disk: disk)
                                }
                                .buttonStyle(.plain)
                            }
                        } header: {
                            Text(diskSectionTitle)
                        } footer: {
                            Text("Started in Grok Build / Claude / Gemini CLI but not yet opened from ClankerSpanker. Tap to attach for remote control.")
                                .font(.caption2)
                        }
                    }
                }
            }
            .listStyle(.sidebar)
        }
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.5))
    }

    private var sidebarTitle: String {
        switch listMode {
        case .recent: return "Recent"
        case .active: return "Sessions"
        case .archived: return "Archived"
        }
    }

    private var listSectionHeader: String {
        if isSearching { return "Matches" }
        switch listMode {
        case .recent: return "Last \(Self.recentLimit)"
        case .active: return "Active"
        case .archived: return "Archived"
        }
    }

    private var isSearching: Bool {
        !search.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var emptyHint: String {
        if appState.hosts.isEmpty {
            return "No host configured. This Mac can run the gateway — connect to it."
        }
        if appState.selectedHost?.loadToken().isEmpty == true {
            return "Host has no token in Keychain. Reconnect local host."
        }
        switch listMode {
        case .archived:
            return "Archive from the session menu when a chat is done."
        case .recent:
            return "No recent chats yet. Dispatch a task or switch to Active."
        case .active:
            return "Dispatch a task to put an agent to work."
        }
    }

    // MARK: Detail (+ optional trailing file viewer)

    @ViewBuilder
    private var detailWithOptionalViewer: some View {
        if appState.showMacViewer {
            HSplitView {
                sessionDetail
                    .frame(minWidth: 480)
                FileViewerPane()
                    .environmentObject(appState)
                    .frame(minWidth: 320)
            }
        } else {
            sessionDetail
        }
    }

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
                    Label("New session", systemImage: "plus.circle.fill")
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
        ToolbarItem(placement: .principal) {
            Picker("Section", selection: $rootTab) {
                ForEach(MacRootTab.allCases) { tab in
                    Text(tab.label).tag(tab)
                }
            }
            .pickerStyle(.segmented)
            .frame(minWidth: 180)
            .help("Sessions or Bots — same ClankerSpanker window")
        }
        ToolbarItemGroup(placement: .primaryAction) {
            if rootTab == .bots {
                Button {
                    showNewBot = true
                } label: {
                    Label("New Bot", systemImage: "plus.circle.fill")
                }
                .labelStyle(.titleAndIcon)
                .help("Create and schedule a hunter")
                .keyboardShortcut("n", modifiers: [.command, .shift])
            } else {
                Button {
                    showCompose = true
                } label: {
                    Label("New Session", systemImage: "plus.circle.fill")
                }
                .labelStyle(.titleAndIcon)
                .help("Dispatch a new agent session")
                .keyboardShortcut("n", modifiers: [.command])
            }

            Button {
                Task {
                    if rootTab == .bots {
                        await botsVM.load(appState: appState)
                    } else {
                        await listVM.load(appState: appState)
                    }
                }
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .help(rootTab == .bots ? "Refresh bots" : "Refresh sessions")

            if rootTab == .sessions {
                Button {
                    appState.showMacViewer.toggle()
                } label: {
                    Image(systemName: appState.showMacViewer
                          ? "sidebar.trailing"
                          : "doc.text.magnifyingglass")
                }
                .help(appState.showMacViewer ? "Hide file viewer" : "Show file viewer")
                .keyboardShortcut("i", modifiers: [.command, .option])
            }

            Button {
                showProjects = true
            } label: {
                Image(systemName: "folder")
            }
            .help("Projects")
            .keyboardShortcut("p", modifiers: [.command, .shift])

            Button {
                showTasks = true
            } label: {
                Image(systemName: "checklist")
            }
            .help("Tasks")
            .keyboardShortcut("t", modifiers: [.command, .shift])

            Button {
                showTerminal = true
            } label: {
                Image(systemName: "terminal")
            }
            .help("Host terminal (login shell on this machine)")
            .keyboardShortcut("k", modifiers: [.command, .shift])

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
                processLabel: localHost.apiReachable
                    ? (localHost.loadedAgentLabel.map { "agent · \($0.hasSuffix("clankerspanker-host") ? "app" : "repo")" } ?? "external")
                    : "down"
            )
        }
    }

    // MARK: Data

    private var totalPoolCount: Int {
        listMode == .archived ? appState.archivedSessions.count : appState.sessions.count
    }

    private var sessionCountLabel: String {
        if appState.showsAllProfiles || listMode == .archived {
            return "\(filteredRows.count)"
        }
        // e.g. "0/49" when Personal is selected but NightMoose has the pile
        return "\(filteredRows.count)/\(totalPoolCount)"
    }

    private var sessionCountHelp: String {
        if isSearching {
            return "\(filteredRows.count) match\(filteredRows.count == 1 ? "" : "es") (titles + message content)"
        }
        if appState.showsAllProfiles {
            return "\(filteredRows.count) sessions"
        }
        let enabled = appState.enabledBoundProfiles
        if enabled.count == 1 {
            return "\(filteredRows.count) for \(enabled[0].displayName) · \(totalPoolCount) total on host"
        }
        return "\(filteredRows.count) for \(enabled.count) profiles · \(totalPoolCount) total on host"
    }

    private var filteredRows: [SessionSummary] {
        if isSearching {
            return SessionSearch.mergeHits(
                hostHits: hostSearchHits,
                localPool: appState.sessions + appState.archivedSessions,
                query: search
            )
        }

        let base: [SessionSummary] = {
            switch listMode {
            case .archived: return appState.archivedSessions
            case .recent, .active: return appState.sessions
            }
        }()

        var rows = base.filter { matchesProfile($0) }
        rows.sort { $0.updatedAt > $1.updatedAt }
        if listMode == .recent {
            return Array(rows.prefix(Self.recentLimit))
        }
        return rows
    }

    /// Disk sessions not yet imported/attached (Claude always; Grok only if import skipped/failed).
    private var diskRows: [DiskSessionHint] {
        guard listMode != .archived else { return [] }
        let bound = appState.selectedBoundProfile
        let raw: [DiskSessionHint]
        if appState.showsAllProfiles {
            raw = appState.diskSessions + appState.claudeSessions + appState.agySessions
        } else if bound?.profile.isGrok == true {
            raw = appState.diskSessions
        } else if bound?.profile.isClaude == true {
            raw = appState.claudeSessions
        } else if bound?.profile.isAntigravity == true {
            raw = appState.agySessions
        } else {
            raw = []
        }
        let q = search.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return raw }
        return raw.filter {
            ($0.title ?? "").lowercased().contains(q)
                || ($0.cwd ?? "").lowercased().contains(q)
                || $0.id.lowercased().contains(q)
        }
    }

    private var diskSectionTitle: String {
        if appState.showsAllProfiles { return "On disk (tap to attach)" }
        if appState.selectedBoundProfile?.profile.isClaude == true { return "Claude on disk" }
        if appState.selectedBoundProfile?.profile.isAntigravity == true {
            return "Gemini CLI on disk"
        }
        return "Grok Build on disk"
    }

    private func matchesProfile(_ s: SessionSummary) -> Bool {
        appState.sessionMatchesSelectedProfile(s)
    }

    private func attachDisk(_ disk: DiskSessionHint) async {
        if disk.isClaude {
            if let route = await listVM.attachClaude(disk: disk, mode: "resume-claude", appState: appState) {
                appState.macSelectedSessionId = route.sessionId
            }
        } else if disk.isAntigravity {
            if let route = await listVM.attachAgy(disk: disk, appState: appState) {
                appState.macSelectedSessionId = route.sessionId
            }
        } else if let route = await listVM.attach(disk: disk, appState: appState) {
            appState.macSelectedSessionId = route.sessionId
        }
    }

    /// Debounced host content search (transcript bodies, tool titles, …).
    private func scheduleContentSearch(_ raw: String) {
        contentSearchTask?.cancel()
        let q = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard q.count >= 2 else {
            hostSearchHits = nil
            return
        }
        contentSearchTask = Task {
            try? await Task.sleep(nanoseconds: 250_000_000)
            guard !Task.isCancelled else { return }
            guard let host = appState.selectedHost else {
                await MainActor.run { hostSearchHits = [] }
                return
            }
            do {
                let response = try await appState.api.sessions(host: host, query: q)
                guard !Task.isCancelled else { return }
                var hits = response.sessions
                hits.append(contentsOf: response.archivedSessions ?? [])
                await MainActor.run { hostSearchHits = hits }
            } catch {
                // Keep local summary filter if content search fails
                if !Task.isCancelled {
                    await MainActor.run {
                        if hostSearchHits == nil { hostSearchHits = [] }
                    }
                }
            }
        }
    }

    /// Empty sidebar: distinguish "host has nothing" vs "this profile filter is empty".
    @ViewBuilder
    private var filterEmptyPane: some View {
        VStack(spacing: 12) {
            Spacer()
            Image(systemName: listMode == .archived ? "tray" : "line.3.horizontal.decrease.circle")
                .font(.system(size: 40, weight: .light))
                .foregroundStyle(.secondary)

            if isSearching {
                Text("No matches")
                    .font(.headline)
                Text("Nothing matched “\(search.trimmingCharacters(in: .whitespacesAndNewlines))” in titles or message content.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 20)
            } else if listMode == .archived {
                Text("No archived sessions")
                    .font(.headline)
                Text(emptyHint)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 20)
            } else if totalPoolCount > 0, !appState.showsAllProfiles {
                // Filter dead-end: data exists under other profile pills
                Text("No \(appState.selectedBoundProfile?.displayName ?? "profile") sessions")
                    .font(.headline)
                Text("This host has \(totalPoolCount) active chat\(totalPoolCount == 1 ? "" : "s") under other profiles.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 20)

                VStack(alignment: .leading, spacing: 6) {
                    ForEach(profileCounts, id: \.id) { row in
                        HStack {
                            Circle().fill(row.color).frame(width: 8, height: 8)
                            Text(row.name)
                            Spacer()
                            Text("\(row.count)")
                                .foregroundStyle(.secondary)
                                .monospacedDigit()
                        }
                        .font(.caption)
                    }
                }
                .padding(12)
                .frame(maxWidth: 220)
                .background(Color.primary.opacity(0.05))
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))

                Button("Show all profiles") {
                    appState.enableAllBoundProfiles()
                }
                .buttonStyle(.borderedProminent)

                if let bound = appState.selectedBoundProfile {
                    Button("New \(bound.displayName) task") { showCompose = true }
                        .buttonStyle(.bordered)
                }
            } else if listMode == .recent, !appState.sessions.isEmpty {
                Text("No recent chats for this filter")
                    .font(.headline)
                Text(emptyHint)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 20)
                Button("Show all active") { listMode = .active }
                    .buttonStyle(.borderedProminent)
            } else {
                Text("No sessions yet")
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
                } else {
                    Button("New session") { showCompose = true }
                        .buttonStyle(.borderedProminent)
                }
            }
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var profileCounts: [(id: String, name: String, count: Int, color: Color)] {
        let base = listMode == .archived ? appState.archivedSessions : appState.sessions
        return appState.boundProfiles.map { b in
            let n = base.filter { s in
                if let sp = s.profileId, !sp.isEmpty { return sp == b.profile.id }
                return false
            }.count
            return (b.id, b.displayName, n, b.uiColor)
        }
        .filter { $0.count > 0 }
        .sorted { $0.count > $1.count }
    }

    private func bootstrapAndLoad() async {
        isBootstrapping = true
        bootstrapMessage = nil
        defer { isBootstrapping = false }

        do {
            try await appState.ensureLocalHostOnMac()
            await localHost.refreshStatus()
            await listVM.load(appState: appState)
            await botsVM.load(appState: appState, quiet: true)
            // Prefer all chips on when the restored filter would show an empty list
            // while data exists (e.g. only Personal on, all chats are NightMoose).
            if !appState.showsAllProfiles,
               !appState.sessions.isEmpty,
               appState.sessions.filter({ appState.sessionMatchesSelectedProfile($0) }).isEmpty
            {
                appState.enableAllBoundProfiles()
            }
        } catch {
            bootstrapMessage = error.localizedDescription
            // Still try load with whatever hosts we have
            await listVM.load(appState: appState)
            await botsVM.load(appState: appState, quiet: true)
        }
    }

    private func openBotSession(_ sessionId: String) {
        appState.macSelectedSessionId = sessionId
        rootTab = .sessions
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

private struct MacDiskSessionRow: View {
    let disk: DiskSessionHint

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(disk.title ?? "Session")
                    .font(.body.weight(.semibold))
                    .lineLimit(1)
                Spacer(minLength: 4)
                Text(disk.isClaude ? "Claude disk" : disk.isAntigravity ? "Gemini disk" : "Grok disk")
                    .font(.caption2.weight(.bold))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .foregroundStyle(disk.isClaude ? Color.orange : disk.isAntigravity ? (Color(hex: "#34A853") ?? DispatchColors.success) : DispatchColors.accent)
                    .background((disk.isClaude ? Color.orange : disk.isAntigravity ? (Color(hex: "#34A853") ?? DispatchColors.success) : DispatchColors.accent).opacity(0.15))
                    .clipShape(Capsule())
            }
            Text(shortPath(disk.cwd ?? disk.id))
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
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
                Text("New session")
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
