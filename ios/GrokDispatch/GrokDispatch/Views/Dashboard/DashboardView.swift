import SwiftUI

/// List scope for the phone sessions dashboard (mirrors Mac command center).
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

struct DashboardView: View {
    @EnvironmentObject private var appState: AppState
    @StateObject private var vm = DashboardViewModel()
    @State private var pendingRoute: SessionRoute?
    @State private var search = ""
    /// Default: last N active sessions (by updatedAt), same as Mac.
    @State private var listMode: SessionListMode = .recent
    /// Host `?q=` hits (full summaries). nil = not searching / still loading.
    @State private var hostSearchHits: [SessionSummary]? = nil
    @State private var contentSearchTask: Task<Void, Never>? = nil
    /// Inline search (system `.searchable` needs a nav bar — we hide that for space).
    @State private var showSearchField = false
    @FocusState private var searchFocused: Bool

    private static let recentLimit = 5

    var body: some View {
        NavigationStack {
            ZStack {
                DispatchBackground()
                // Chips/picker are OUTSIDE the List so a vertical drag on them
                // cannot fire List `.refreshable` (that was wiping profiles mid-cancel).
                VStack(spacing: 0) {
                    sessionsChrome
                    profileContent
                }
            }
            .navigationTitle("")
            #if os(iOS)
            .toolbar(.hidden, for: .navigationBar)
            #endif
            .navigationDestination(item: $pendingRoute) { route in
                if let host = appState.hosts.first(where: { $0.id == route.hostId }) {
                    SessionDetailView(sessionId: route.sessionId, host: host)
                } else {
                    Text("Host no longer available").foregroundStyle(.secondary)
                }
            }
            .navigationDestination(for: SessionRoute.self) { route in
                if let host = appState.hosts.first(where: { $0.id == route.hostId }) {
                    SessionDetailView(sessionId: route.sessionId, host: host)
                } else {
                    Text("Host no longer available").foregroundStyle(.secondary)
                }
            }
            .onChange(of: search) { _, newValue in
                scheduleContentSearch(newValue)
            }
            .task { await vm.load(appState: appState) }
            .onChange(of: appState.tabRefreshTick) { _, _ in
                guard appState.selectedTab == .sessions else { return }
                Task { await vm.load(appState: appState) }
            }
        }
    }

    /// Sticky filters under the app tab strip — not part of the refreshing List.
    private var sessionsChrome: some View {
        VStack(spacing: 0) {
            ProfileSegmentBar(showsContext: false)
                .padding(.horizontal, 12)
                .padding(.top, 4)
                .padding(.bottom, 2)

            HStack(spacing: 8) {
                Picker(selection: $listMode) {
                    ForEach(SessionListMode.allCases) { mode in
                        Text(mode.label).tag(mode)
                    }
                } label: {
                    EmptyView()
                }
                .labelsHidden()
                .pickerStyle(.segmented)

                Button {
                    withAnimation(.easeInOut(duration: 0.15)) {
                        showSearchField.toggle()
                        if showSearchField {
                            searchFocused = true
                        } else {
                            search = ""
                            searchFocused = false
                        }
                    }
                } label: {
                    Image(systemName: showSearchField || isSearching ? "magnifyingglass.circle.fill" : "magnifyingglass")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(showSearchField || isSearching ? DispatchColors.accent : .secondary)
                        .frame(width: 32, height: 32)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Search sessions")
            }
            .padding(.horizontal, 12)
            .padding(.bottom, showSearchField || isSearching ? 4 : 6)

            // Search field opens under Recent / Active / Archived.
            if showSearchField || isSearching {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass")
                        .foregroundStyle(.secondary)
                    TextField(searchPrompt, text: $search)
                        .textFieldStyle(.plain)
                        .focused($searchFocused)
                        .submitLabel(.search)
                    if !search.isEmpty {
                        Button {
                            search = ""
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .foregroundStyle(.secondary)
                        }
                        .buttonStyle(.plain)
                    }
                    Button("Cancel") {
                        search = ""
                        showSearchField = false
                        searchFocused = false
                    }
                    .font(.subheadline)
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 6)
            }

            // Status line lives in chrome (not a List section) to avoid fat gaps.
            if !appState.boundProfiles.isEmpty {
                HStack(spacing: 8) {
                    Text(sessionCountLabel)
                    Spacer(minLength: 8)
                    connectionChip
                    if let p = appState.selectedBoundProfile {
                        Text(p.hostLabel)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    } else if let h = appState.selectedHost {
                        Text(h.name)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 16)
                .padding(.bottom, 4)
            }

            if let err = vm.errorMessage ?? appState.lastRefreshError {
                Text(err)
                    .font(.footnote)
                    .foregroundStyle(DispatchColors.danger)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 4)
            }
        }
        .background(.ultraThinMaterial)
    }

    private var searchPrompt: String {
        if appState.showsAllProfiles {
            let host = appState.selectedHost?.name ?? "host"
            return "Titles, paths & message content · \(host)"
        }
        let enabled = appState.enabledBoundProfiles
        if enabled.count == 1 {
            let name = enabled[0].displayName
            let host = enabled[0].hostLabel
            return host.isEmpty
                ? "Search \(name) (titles & content)"
                : "Search \(name) · \(host)"
        }
        if enabled.count > 1 {
            return "Search \(enabled.count) profiles (titles & content)"
        }
        return "Search sessions"
    }

    private var isSearching: Bool {
        !search.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    @ViewBuilder
    private var profileContent: some View {
        // List is the only scroll surface that pull-to-refresh attaches to.
        List {
            if appState.boundProfiles.isEmpty && !vm.isLoading {
                Section {
                    emptyListPane(
                        icon: "desktopcomputer",
                        title: "No hosts / profiles",
                        body: "Add a host in Settings (Mac Mini or client laptop), then profiles appear here."
                    )
                    .listRowBackground(Color.clear)
                }
            } else {
                let attention = appState.attentionSessions
                if !attention.isEmpty && !isSearching {
                    Section {
                        ForEach(attention) { session in
                            if let hostId = appState.selectedHost?.id {
                                NavigationLink(value: SessionRoute(hostId: hostId, sessionId: session.id)) {
                                    HStack(spacing: 10) {
                                        Image(systemName: session.status.systemImage)
                                            .foregroundStyle(DispatchColors.warning)
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(session.title)
                                                .font(.subheadline.weight(.semibold))
                                                .lineLimit(1)
                                            Text(session.status.label)
                                                .font(.caption)
                                                .foregroundStyle(.secondary)
                                        }
                                        Spacer()
                                        Text(session.status.shortLabel)
                                            .font(.caption.weight(.semibold))
                                            .padding(.horizontal, 10)
                                            .padding(.vertical, 4)
                                            .background(DispatchColors.warning.opacity(0.2))
                                            .clipShape(Capsule())
                                    }
                                }
                                .listRowBackground(DispatchColors.card)
                                .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
                            }
                        }
                    } header: {
                        HStack(spacing: 6) {
                            Image(systemName: "exclamationmark.circle.fill")
                                .foregroundStyle(DispatchColors.warning)
                            Text(attention.count == 1
                                 ? "1 session needs your attention"
                                 : "\(attention.count) sessions need your attention")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(DispatchColors.warning)
                        }
                        .textCase(nil)
                    }
                }

                Section {
                    if listMode != .archived || isSearching {
                        if appState.enabledBoundProfiles.count == 1,
                           let bound = appState.enabledBoundProfiles.first {
                            Button {
                                appState.selectBoundProfile(bound.id)
                                appState.selectedTab = .compose
                            } label: {
                                Label(
                                    "New \(bound.displayName) session",
                                    systemImage: "plus.circle.fill"
                                )
                                .font(.body.weight(.semibold))
                                .foregroundStyle(bound.uiColor)
                            }
                            .listRowBackground(DispatchColors.card)
                            .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                        } else if !appState.enabledBoundProfiles.isEmpty || isSearching {
                            Button {
                                appState.selectedTab = .compose
                            } label: {
                                Label("New session", systemImage: "plus.circle.fill")
                                    .font(.body.weight(.semibold))
                                    .foregroundStyle(DispatchColors.accent)
                            }
                            .listRowBackground(DispatchColors.card)
                            .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                        }
                    }

                    if filteredRows.isEmpty && !vm.isLoading {
                        emptyListHint
                            .listRowBackground(Color.clear)
                            .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
                    } else {
                        ForEach(filteredRows) { session in
                            if let hostId = appState.selectedHost?.id {
                                NavigationLink(value: SessionRoute(hostId: hostId, sessionId: session.id)) {
                                    SessionRowView(session: session)
                                }
                                .listRowBackground(DispatchColors.card)
                                .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
                                .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                                    if (listMode == .archived && !isSearching) || session.isArchived == true {
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
                        }
                    }
                } header: {
                    Text(listSectionHeader)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .textCase(nil)
                }

                // Disk attach: full Active (or when searching). Skip Recent to keep it tight.
                if listMode != .archived || isSearching {
                    if listMode != .recent || isSearching {
                        diskSections
                    }
                }
            }
        }
        .scrollContentBackground(.hidden)
        #if os(iOS)
        .listStyle(.insetGrouped)
        .listSectionSpacing(8)
        .contentMargins(.top, 4, for: .scrollContent)
        #else
        .listStyle(.inset)
        #endif
        .environment(\.defaultMinListRowHeight, 36)
        .refreshable { await vm.load(appState: appState) }
    }

    private func emptyListPane(icon: String, title: String, body: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(title, systemImage: icon)
                .font(.headline)
            Text(body)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Button("Open Settings") { appState.selectedTab = .settings }
                .font(.subheadline.weight(.semibold))
        }
        .padding(.vertical, 8)
    }

    private var listSectionHeader: String {
        if isSearching { return "Matches" }
        switch listMode {
        case .recent: return "Last \(Self.recentLimit)"
        case .active: return "Active"
        case .archived: return "Archived"
        }
    }

    private var sessionCountLabel: String {
        if isSearching {
            return "\(filteredRows.count) match\(filteredRows.count == 1 ? "" : "es")"
        }
        switch listMode {
        case .recent:
            let total = appState.sessions.filter { matchesSelectedProfile($0) }.count
            return "\(filteredRows.count) recent · \(total) active"
        case .active:
            return "\(filteredRows.count) chat\(filteredRows.count == 1 ? "" : "s")"
        case .archived:
            return "\(filteredRows.count) archived"
        }
    }

    @ViewBuilder
    private var emptyListHint: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(emptyModeHint)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            if isSearching {
                Text("Tried titles, paths, and message content on the host.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else if listMode == .recent, !appState.sessions.isEmpty {
                Button("Show all active") { listMode = .active }
                    .font(.subheadline.weight(.semibold))
            } else if !appState.showsAllProfiles, !appState.sessions.isEmpty, listMode != .archived {
                Text("\(appState.sessions.count) chat\(appState.sessions.count == 1 ? "" : "s") on this host under other profiles.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button("Show all profiles") {
                    appState.enableAllBoundProfiles()
                }
                .font(.subheadline.weight(.semibold))
            }
        }
    }

    private var emptyModeHint: String {
        if isSearching {
            let q = search.trimmingCharacters(in: .whitespacesAndNewlines)
            return "Nothing matched “\(q)”."
        }
        let enabled = appState.enabledBoundProfiles
        switch listMode {
        case .recent:
            if enabled.count == 1, let bound = enabled.first {
                return "No recent chats for \(bound.displayName)."
            }
            if enabled.isEmpty {
                return "No profile chips are on. Tap a chip above to filter, or turn them all on."
            }
            return "No recent chats yet. Dispatch a task or switch to Active."
        case .active:
            if enabled.count == 1, let bound = enabled.first {
                return "No active chats for \(bound.displayName). Tap New session — uses \(bound.displayName) / \(bound.backendLabel), not always Grok."
            }
            if enabled.isEmpty {
                return "No profile chips are on. Tap chips above to show sessions."
            }
            return "No active chats yet. Tap New session and choose who runs it."
        case .archived:
            return "No archived chats. Swipe left on a chat and Archive."
        }
    }

    private var connectionChip: some View {
        let live = appState.socket.isConnected
        let api = appState.hostAPIReachable
        return Text(appState.connectionLabel)
            .font(.caption.weight(.semibold))
            .foregroundStyle(live ? DispatchColors.success : (api ? DispatchColors.warning : DispatchColors.danger))
    }

    @ViewBuilder
    private var diskSections: some View {
        if let bound = appState.selectedBoundProfile {
            if bound.profile.isGrok {
                diskSection(title: "Grok on disk", items: filteredGrokDisk, kind: .grok)
            } else {
                diskSection(title: "Claude on disk", items: filteredClaudeDisk, kind: .claude)
            }
        } else if appState.showsAllProfiles {
            if !filteredGrokDisk.isEmpty {
                diskSection(title: "Grok on disk", items: filteredGrokDisk, kind: .grok)
            }
            if !filteredClaudeDisk.isEmpty {
                diskSection(title: "Claude on disk", items: filteredClaudeDisk, kind: .claude)
            }
        }
    }

    private enum DiskKind { case grok, claude }

    @ViewBuilder
    private func diskSection(title: String, items: [DiskSessionHint], kind: DiskKind) -> some View {
        Section {
            if items.isEmpty {
                Text("None found on this host yet.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .listRowBackground(Color.clear)
            } else {
                ForEach(items) { disk in
                    if kind == .grok {
                        Button {
                            Task {
                                if let route = await vm.attach(disk: disk, appState: appState) {
                                    pendingRoute = route
                                }
                            }
                        } label: {
                            diskRow(disk, badge: "Grok", color: appState.selectedBoundProfile?.uiColor ?? DispatchColors.accent)
                        }
                        .listRowBackground(DispatchColors.card)
                    } else {
                        Menu {
                            Button("Resume with this Claude profile") {
                                Task {
                                    if let route = await vm.attachClaude(disk: disk, mode: "resume-claude", appState: appState) {
                                        pendingRoute = route
                                    }
                                }
                            }
                            Button("Continue with a Grok profile") {
                                Task {
                                    if let grok = appState.boundProfiles.first(where: { $0.profile.isGrok }) {
                                        appState.selectBoundProfile(grok.id)
                                    }
                                    if let route = await vm.attachClaude(disk: disk, mode: "continue-with-grok", appState: appState) {
                                        pendingRoute = route
                                    }
                                }
                            }
                        } label: {
                            diskRow(
                                disk,
                                badge: appState.selectedBoundProfile?.displayName ?? "Claude",
                                color: appState.selectedBoundProfile?.uiColor ?? .orange
                            )
                        }
                        .listRowBackground(DispatchColors.card)
                    }
                }
            }
        } header: {
            Text(title)
        } footer: {
            Text(kind == .grok
                 ? "Grok Build TUI sessions not yet in the managed list. Tap to open for remote control. Most sessions import automatically on refresh."
                 : "Claude CLI history on this host. Tap to attach under the selected Claude profile.")
                .font(.caption2)
        }
    }

    // MARK: - Filtering (parity with Mac)

    private var filteredRows: [SessionSummary] {
        if isSearching {
            // Host-wide: merge transcript hits with local title/path matches.
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

        var rows = base.filter { matchesSelectedProfile($0) }
        rows.sort { $0.updatedAt > $1.updatedAt }
        if listMode == .recent {
            return Array(rows.prefix(Self.recentLimit))
        }
        return rows
    }

    private var filteredGrokDisk: [DiskSessionHint] { filterDisk(appState.diskSessions) }
    private var filteredClaudeDisk: [DiskSessionHint] { filterDisk(appState.claudeSessions) }

    private func matchesSelectedProfile(_ s: SessionSummary) -> Bool {
        appState.sessionMatchesSelectedProfile(s)
    }

    private func filterDisk(_ items: [DiskSessionHint]) -> [DiskSessionHint] {
        let q = search.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return items }
        return items.filter {
            ($0.title ?? "").lowercased().contains(q)
                || ($0.cwd ?? "").lowercased().contains(q)
                || $0.id.lowercased().contains(q)
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
                if !Task.isCancelled {
                    await MainActor.run {
                        // Fall back to local-only merge
                        if hostSearchHits == nil { hostSearchHits = [] }
                    }
                }
            }
        }
    }

    private func diskRow(_ disk: DiskSessionHint, badge: String, color: Color) -> some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 4) {
                Text(disk.title ?? "Session")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(2)
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
                .foregroundStyle(color)
                .background(color.opacity(0.15))
                .clipShape(Capsule())
        }
    }

    private func shortPath(_ path: String) -> String {
        if let r = path.range(of: "/Projects/") { return String(path[r.upperBound...]) }
        return (path as NSString).lastPathComponent
    }

    private func emptyPane(icon: String, title: String, body: String) -> some View {
        VStack(spacing: 14) {
            Spacer()
            Image(systemName: icon).font(.system(size: 48)).foregroundStyle(DispatchColors.accent)
            Text(title).font(.title3.bold())
            Text(body)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 36)
            DispatchButton(title: "Open Settings", icon: "gearshape") {
                appState.selectedTab = .settings
            }
            .padding(.horizontal, 40)
            Spacer()
        }
    }
}
