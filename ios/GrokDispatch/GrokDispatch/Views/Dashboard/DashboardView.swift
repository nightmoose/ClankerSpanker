import SwiftUI

/// Top-level Sessions browser: Active (Dispatch) / Grok Build / Claude Code.
enum SessionsTab: String, CaseIterable, Identifiable {
    case active = "Active"
    case grok = "Grok"
    case claude = "Claude"

    var id: String { rawValue }

    var systemImage: String {
        switch self {
        case .active: return "bolt.fill"
        case .grok: return "sparkles"
        case .claude: return "brain.head.profile"
        }
    }
}

struct DashboardView: View {
    @EnvironmentObject private var appState: AppState
    @StateObject private var vm = DashboardViewModel()
    @State private var pendingNavId: String?
    @State private var tab: SessionsTab = .active
    @State private var search = ""
    /// When true, Active tab shows archived chats instead of live ones.
    @State private var showArchived = false

    var body: some View {
        NavigationStack {
            ZStack {
                DispatchBackground()
                VStack(spacing: 0) {
                    Picker("Source", selection: $tab) {
                        ForEach(SessionsTab.allCases) { t in
                            Label(t.rawValue, systemImage: t.systemImage).tag(t)
                        }
                    }
                    .pickerStyle(.segmented)
                    .padding(.horizontal)
                    .padding(.top, 8)

                    if tab == .active {
                        Picker("Active scope", selection: $showArchived) {
                            Text("Inbox (\(appState.sessions.count))").tag(false)
                            Text("Archived (\(appState.archivedSessions.count))").tag(true)
                        }
                        .pickerStyle(.segmented)
                        .padding(.horizontal)
                        .padding(.top, 8)
                    }

                    if let err = vm.errorMessage ?? appState.lastRefreshError {
                        Text(err)
                            .font(.footnote)
                            .foregroundStyle(DispatchColors.danger)
                            .padding(.horizontal)
                            .padding(.top, 6)
                    }

                    Group {
                        switch tab {
                        case .active:
                            activeList
                        case .grok:
                            grokDiskList
                        case .claude:
                            claudeDiskList
                        }
                    }
                }
            }
            .navigationTitle("ClankerSpanker")
            .navigationDestination(for: String.self) { id in
                SessionDetailView(sessionId: id)
            }
            .navigationDestination(item: $pendingNavId) { id in
                SessionDetailView(sessionId: id)
            }
            .searchable(text: $search, prompt: searchPrompt)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await vm.load(appState: appState) }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                }
            }
            .refreshable {
                await vm.load(appState: appState)
            }
            .task {
                await vm.load(appState: appState)
            }
            .onChange(of: tab) { _, newTab in
                if newTab != .active { showArchived = false }
            }
        }
    }

    private var searchPrompt: String {
        switch tab {
        case .active:
            return showArchived ? "Search archived chats" : "Search active chats"
        case .grok: return "Search Grok Build sessions"
        case .claude: return "Search Claude Code sessions"
        }
    }

    // MARK: - Active (Dispatch)

    private var filteredActive: [SessionSummary] {
        filterSessions(appState.sessions)
    }

    private var filteredArchived: [SessionSummary] {
        filterSessions(appState.archivedSessions)
    }

    private func filterSessions(_ items: [SessionSummary]) -> [SessionSummary] {
        let q = search.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return items }
        return items.filter {
            $0.title.lowercased().contains(q)
                || $0.prompt.lowercased().contains(q)
                || $0.cwd.lowercased().contains(q)
        }
    }

    private var activeList: some View {
        let rows = showArchived ? filteredArchived : filteredActive
        return Group {
            if rows.isEmpty && !vm.isLoading {
                emptyPane(
                    icon: showArchived ? "tray" : "bolt.horizontal.circle",
                    title: showArchived ? "No archived chats" : "No active chats",
                    body: showArchived
                        ? "Swipe left on an active chat and tap Archive to move it here."
                        : "Dispatch a task or open a Grok/Claude session from the other tabs."
                )
            } else {
                List {
                    Section {
                        HStack {
                            Text(showArchived ? "\(rows.count) archived" : "\(rows.count) chat\(rows.count == 1 ? "" : "s")")
                            Spacer()
                            if !showArchived {
                                Text(appState.connectionLabel)
                                    .foregroundStyle(appState.socket.isConnected ? DispatchColors.success : .secondary)
                            }
                        }
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .listRowBackground(Color.clear)
                    }

                    Section {
                        ForEach(rows) { session in
                            NavigationLink(value: session.id) {
                                SessionRowView(session: session)
                            }
                            .listRowBackground(DispatchColors.card)
                            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                                if showArchived {
                                    Button {
                                        Task { await vm.unarchive(sessionId: session.id, appState: appState) }
                                    } label: {
                                        Label("Unarchive", systemImage: "tray.and.arrow.up")
                                    }
                                    .tint(DispatchColors.accent)
                                } else {
                                    Button {
                                        Task { await vm.archive(sessionId: session.id, appState: appState) }
                                    } label: {
                                        Label("Archive", systemImage: "archivebox")
                                    }
                                    .tint(.orange)
                                }
                            }
                        }
                    } footer: {
                        Text(
                            showArchived
                                ? "Archived chats stay on the Mac and can be opened or restored anytime."
                                : "Live ClankerSpanker chats on this Mac. Swipe left to archive."
                        )
                        .font(.caption2)
                    }
                }
                .scrollContentBackground(.hidden)
                .listStyle(.insetGrouped)
            }
        }
    }

    // MARK: - Grok disk

    private var filteredGrok: [DiskSessionHint] {
        filterDisk(appState.diskSessions)
    }

    private var grokDiskList: some View {
        Group {
            if filteredGrok.isEmpty && !vm.isLoading {
                emptyPane(
                    icon: "sparkles",
                    title: "No Grok Build sessions",
                    body: "Sessions from the Grok TUI and prior Dispatch runs appear here."
                )
            } else {
                List {
                    Section {
                        Text("\(filteredGrok.count) on disk")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .listRowBackground(Color.clear)
                    }
                    Section {
                        ForEach(filteredGrok) { disk in
                            Button {
                                Task {
                                    if let id = await vm.attach(disk: disk, appState: appState) {
                                        pendingNavId = id
                                        tab = .active
                                    }
                                }
                            } label: {
                                diskRow(disk, badge: "Grok", badgeColor: DispatchColors.accent)
                            }
                            .listRowBackground(DispatchColors.card)
                        }
                    } footer: {
                        Text("From ~/.grok/sessions. Tap to open and keep chatting under Active.")
                            .font(.caption2)
                    }
                }
                .scrollContentBackground(.hidden)
                .listStyle(.insetGrouped)
            }
        }
    }

    // MARK: - Claude disk

    private var filteredClaude: [DiskSessionHint] {
        filterDisk(appState.claudeSessions)
    }

    private var claudeDiskList: some View {
        Group {
            if filteredClaude.isEmpty && !vm.isLoading {
                emptyPane(
                    icon: "brain.head.profile",
                    title: "No Claude Code sessions",
                    body: "Sessions from ~/.claude/projects appear here once Claude has been used on this Mac."
                )
            } else {
                List {
                    Section {
                        Text("\(filteredClaude.count) on disk")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .listRowBackground(Color.clear)
                    }
                    Section {
                        ForEach(filteredClaude) { disk in
                            Menu {
                                Button("Resume with Claude (streaming + phone approvals)") {
                                    Task {
                                        if let id = await vm.attachClaude(
                                            disk: disk,
                                            mode: "resume-claude",
                                            appState: appState
                                        ) {
                                            pendingNavId = id
                                            tab = .active
                                        }
                                    }
                                }
                                Button("Continue with Grok (import context)") {
                                    Task {
                                        if let id = await vm.attachClaude(
                                            disk: disk,
                                            mode: "continue-with-grok",
                                            appState: appState
                                        ) {
                                            pendingNavId = id
                                            tab = .active
                                        }
                                    }
                                }
                            } label: {
                                diskRow(disk, badge: "Claude", badgeColor: Color.orange)
                            }
                            .listRowBackground(DispatchColors.card)
                        }
                    } footer: {
                        Text("From ~/.claude/projects. Resume Claude keeps the same session with phone approval for Edit/Bash. Continue with Grok hands context to Grok Build.")
                            .font(.caption2)
                    }
                }
                .scrollContentBackground(.hidden)
                .listStyle(.insetGrouped)
            }
        }
    }

    // MARK: - Shared

    private func filterDisk(_ items: [DiskSessionHint]) -> [DiskSessionHint] {
        let q = search.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return items }
        return items.filter {
            ($0.title ?? "").lowercased().contains(q)
                || ($0.cwd ?? "").lowercased().contains(q)
                || $0.id.lowercased().contains(q)
        }
    }

    private func diskRow(_ disk: DiskSessionHint, badge: String, badgeColor: Color) -> some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 4) {
                Text(disk.title ?? "Session")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                Text(shortPath(disk.cwd ?? disk.id))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            Text(badge)
                .font(.caption2.weight(.bold))
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .foregroundStyle(badgeColor)
                .background(badgeColor.opacity(0.15))
                .clipShape(Capsule())
        }
    }

    private func shortPath(_ path: String) -> String {
        if let r = path.range(of: "/Projects/") {
            return String(path[r.upperBound...])
        }
        if let r = path.range(of: "/Documents/") {
            return String(path[r.upperBound...])
        }
        return (path as NSString).lastPathComponent
    }

    private func emptyPane(icon: String, title: String, body: String) -> some View {
        VStack(spacing: 14) {
            Spacer()
            Image(systemName: icon)
                .font(.system(size: 48))
                .foregroundStyle(DispatchColors.accent)
            Text(title).font(.title3.bold())
            Text(body)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 36)
            if tab == .active {
                DispatchButton(title: "Compose a task", icon: "square.and.pencil") {
                    appState.selectedTab = .compose
                }
                .padding(.horizontal, 40)
            }
            Spacer()
        }
    }
}
