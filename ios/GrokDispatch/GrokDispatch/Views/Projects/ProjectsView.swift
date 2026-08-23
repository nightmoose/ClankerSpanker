import SwiftUI

/// Project-centric home: start new sessions or jump into existing ones for a folder.
/// Search is host-wide (titles, paths, transcript content) — not just project names.
struct ProjectsView: View {
    @EnvironmentObject private var appState: AppState
    @State private var projects: [ProjectInfo] = []
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var search = ""
    @State private var pendingRoute: SessionRoute?
    /// Host `?q=` hits (full summaries). nil = not searching / not loaded yet.
    @State private var hostSearchHits: [SessionSummary]? = nil
    @State private var contentSearchTask: Task<Void, Never>? = nil
    @State private var isSearchingHost = false

    /// Sheets driven by an item so we can distinguish new vs. edit.
    enum ProjectSheet: Identifiable {
        case new
        case edit(ProjectInfo)
        case importCandidates([ProjectInfo])
        var id: String {
            switch self {
            case .new: return "new"
            case .edit(let p): return "edit-\(p.id)"
            case .importCandidates: return "import"
            }
        }
    }
    @State private var activeSheet: ProjectSheet?
    @State private var isDiscovering = false
    @State private var deletionCandidate: ProjectInfo?
    @State private var showSearchField = false
    @FocusState private var searchFocused: Bool

    private let projectsSearchPrompt = "Search projects & sessions (titles, paths, messages)"

    var body: some View {
        NavigationStack {
            ZStack {
                DispatchBackground()
                VStack(spacing: 0) {
                    projectsChrome
                    content
                }
            }
            .navigationTitle("")
            #if os(iOS)
            .toolbar(.hidden, for: .navigationBar)
            #endif
            .onChange(of: search) { _, newValue in
                scheduleContentSearch(newValue)
            }
            .onChange(of: appState.tabRefreshTick) { _, _ in
                guard appState.selectedTab == .projects else { return }
                Task { await load() }
            }
            .sheet(item: $activeSheet) { sheet in
                sheetContent(for: sheet)
            }
            .confirmationDialog(
                deletionCandidate.map { "Delete “\($0.name)”?" } ?? "Delete project?",
                isPresented: Binding(
                    get: { deletionCandidate != nil },
                    set: { if !$0 { deletionCandidate = nil } }
                ),
                titleVisibility: .visible,
                presenting: deletionCandidate
            ) { project in
                Button("Archive", role: .destructive) {
                    Task { await softDelete(project) }
                }
                Button("Delete permanently", role: .destructive) {
                    Task { await hardDelete(project) }
                }
                Button("Cancel", role: .cancel) {}
            } message: { _ in
                Text("Archive hides it from active lists (sessions keep their reference). Delete permanently removes the project record and its uploaded attachments.")
            }
            .navigationDestination(item: $pendingRoute) { route in
                if let host = appState.hosts.first(where: { $0.id == route.hostId }) {
                    SessionDetailView(
                        sessionId: route.sessionId,
                        host: host,
                        scrollToMessageId: route.messageId
                    )
                } else {
                    Text("Host no longer available").foregroundStyle(.secondary)
                }
            }
            .task { await load() }
            .onChange(of: appState.selectedHost?.id) { _, _ in
                Task { await load() }
            }
        }
    }

    private var isSearching: Bool {
        !search.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Sticky actions + search (outside List so pull-to-refresh doesn't fight chrome).
    private var projectsChrome: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Button {
                    activeSheet = .new
                } label: {
                    Image(systemName: "plus.circle.fill")
                        .font(.title3)
                        .foregroundStyle(DispatchColors.accent)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("New project")

                Button {
                    Task { await runDiscover() }
                } label: {
                    Image(systemName: "sparkle.magnifyingglass")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(isDiscovering ? .secondary : DispatchColors.accent)
                }
                .buttonStyle(.plain)
                .disabled(isDiscovering)
                .accessibilityLabel("Import from disk")

                Spacer(minLength: 8)

                if isDiscovering {
                    ProgressView()
                        .controlSize(.small)
                }

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
                .accessibilityLabel("Search projects")
            }
            .padding(.horizontal, 12)
            .padding(.top, 4)
            .padding(.bottom, showSearchField || isSearching ? 4 : 6)

            if showSearchField || isSearching {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass")
                        .foregroundStyle(.secondary)
                    TextField(projectsSearchPrompt, text: $search)
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

            if let err = errorMessage, !projects.isEmpty {
                Text(err)
                    .font(.footnote)
                    .foregroundStyle(DispatchColors.danger)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 4)
            }
        }
        .background(.ultraThinMaterial)
    }

    @ViewBuilder
    private var content: some View {
        if appState.hosts.isEmpty {
            emptyPane(
                icon: "desktopcomputer",
                title: "No host",
                body: "Add a host in Settings, then projects from that machine appear here."
            )
        } else if isLoading && projects.isEmpty && !isSearching {
            ProgressView("Loading projects…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let err = errorMessage, projects.isEmpty, !isSearching {
            emptyPane(icon: "exclamationmark.triangle", title: "Couldn’t load projects", body: err)
        } else if isSearching {
            searchResultsList
        } else if projects.isEmpty {
            emptyProjectsPane
        } else {
            browseProjectsList
        }
    }

    // MARK: - Browse (no query)

    private var browseProjectsList: some View {
        List {
            Section {
                HStack {
                    Text("\(projects.count) project\(projects.count == 1 ? "" : "s")")
                    Spacer()
                    if let host = appState.selectedHost {
                        Text(host.name)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 2, leading: 16, bottom: 2, trailing: 16))
            }

            ForEach(sortedProjects) { project in
                projectSection(project, sessions: browseSessions(for: project), searching: false)
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
        .refreshable { await load() }
    }

    // MARK: - Search results

    private var searchResultsList: some View {
        let hits = sessionHits
        let projectGroups = groupedHits(hits)
        let orphan = orphanHits(hits)

        return List {
            Section {
                HStack {
                    if isSearchingHost {
                        ProgressView()
                            .controlSize(.small)
                    }
                    Text(searchCountLabel(hits: hits, projects: projectGroups.count))
                    Spacer()
                    if let host = appState.selectedHost {
                        Text(host.name)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 2, leading: 16, bottom: 2, trailing: 16))
            }

            if hits.isEmpty && projectNameMatches.isEmpty && !isSearchingHost {
                Section {
                    Text("Nothing matched “\(search.trimmingCharacters(in: .whitespacesAndNewlines))”. Tries titles, paths, project names, and message content on the host.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .listRowBackground(Color.clear)
                }
            }

            // Projects whose name/path matched even if no session hit yet
            ForEach(projectNameMatches) { project in
                let sessions = hits.filter { cwdMatchesProject($0.cwd, projectPath: project.path, projectId: project.id, sessionProjectId: $0.projectId) }
                projectSection(project, sessions: Array(sessions.prefix(Self.sessionCap)), searching: true)
            }

            // Projects that only showed up because a session hit lives there
            ForEach(projectGroups.filter { !projectNameMatches.contains($0.project) }) { group in
                projectSection(group.project, sessions: Array(group.sessions.prefix(Self.sessionCap)), searching: true)
            }

            if !orphan.isEmpty {
                Section {
                    ForEach(orphan.prefix(40)) { session in
                        sessionRow(session)
                    }
                } header: {
                    Text("Other sessions")
                } footer: {
                    Text("Matched chats whose working directory isn’t under a configured project.")
                        .font(.caption2)
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
        .refreshable { await load() }
    }

    private func searchCountLabel(hits: [SessionSummary], projects: Int) -> String {
        let p = projectNameMatches.count + projects
        if isSearchingHost && hits.isEmpty {
            return "Searching host…"
        }
        return "\(hits.count) session\(hits.count == 1 ? "" : "s") · \(p) project\(p == 1 ? "" : "s")"
    }

    // MARK: - Sections / rows

    @ViewBuilder
    private func projectSection(_ project: ProjectInfo, sessions: [SessionSummary], searching: Bool) -> some View {
        Section {
            Button {
                appState.openCompose(projectId: project.id)
            } label: {
                Label("New session here", systemImage: "plus.circle.fill")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(DispatchColors.accent)
            }
            .listRowBackground(DispatchColors.card)
            // NB: swipe actions on Section headers aren't a SwiftUI thing —
            // the project's Edit / Delete surface lives in the ellipsis
            // menu in the header below.

            if sessions.isEmpty {
                Text(searching ? "No sessions matched in this folder." : "No active or recent chats in this folder yet.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .listRowBackground(Color.clear)
            } else {
                ForEach(sessions) { session in
                    sessionRow(session)
                }
            }
        } header: {
            HStack(spacing: 8) {
                Circle()
                    .fill(Color(hex: project.color ?? "") ?? DispatchColors.accent)
                    .frame(width: 8, height: 8)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(project.name)
                        if project.isArchived {
                            Text("archived")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 1)
                                .background(Color.white.opacity(0.08))
                                .clipShape(Capsule())
                        }
                    }
                    Text(project.effectivePaths.map(shortPath).joined(separator: " · "))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .textCase(nil)
                        .lineLimit(2)
                }
                Spacer(minLength: 8)
                Menu {
                    Button {
                        activeSheet = .edit(project)
                    } label: {
                        Label("Edit project…", systemImage: "pencil")
                    }
                    Divider()
                    Button(role: .destructive) {
                        deletionCandidate = project
                    } label: {
                        Label("Delete project…", systemImage: "trash")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .font(.body)
                        .foregroundStyle(DispatchColors.accent)
                        .contentShape(Rectangle())
                        .frame(width: 36, height: 32, alignment: .trailing)
                }
                .menuStyle(.button)
                .buttonStyle(.plain)
                .accessibilityLabel("Project actions")
            }
        } footer: {
            if !searching, sessions.count >= Self.sessionCap {
                Text("Showing \(Self.sessionCap) most recent. Search to find older chats.")
                    .font(.caption2)
            }
        }
    }

    @ViewBuilder
    private func sessionRow(_ session: SessionSummary) -> some View {
        if let hostId = appState.selectedHost?.id {
            Button {
                pendingRoute = SessionRoute(hostId: hostId, sessionId: session.id)
            } label: {
                HStack(alignment: .center, spacing: 12) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(session.title)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.primary)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                        HStack(spacing: 6) {
                            if let name = session.profileName, !name.isEmpty {
                                Text(name)
                                    .font(.caption2.weight(.bold))
                                    .foregroundStyle(
                                        Color(hex: session.profileColor ?? "")
                                            ?? DispatchColors.accent
                                    )
                            }
                            Text(session.status.shortLabel)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                            if session.isArchived {
                                Text("Archived")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        Text(shortPath(session.cwd))
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 8)
                    StatusBadge(status: session.status, compact: true)
                }
            }
            .listRowBackground(DispatchColors.card)
        }
    }

    // MARK: - Data

    private static let sessionCap = 12

    private var sortedProjects: [ProjectInfo] {
        projects.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    /// Projects whose name or path match the query.
    private var projectNameMatches: [ProjectInfo] {
        let q = search.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return [] }
        let toks = SessionSearch.tokens(from: q)
        return sortedProjects.filter { p in
            let hay = "\(p.name)\n\(p.path)\n\(p.id)".lowercased()
            if toks.isEmpty { return hay.contains(q) }
            return toks.allSatisfy { hay.contains($0) }
        }
    }

    private var localPool: [SessionSummary] {
        appState.sessions + appState.archivedSessions
    }

    /// All session hits (host content + local titles/paths/previews).
    private var sessionHits: [SessionSummary] {
        SessionSearch.mergeHits(
            hostHits: hostSearchHits,
            localPool: localPool,
            query: search
        )
    }

    private struct ProjectHitGroup: Identifiable {
        var id: String { project.id }
        var project: ProjectInfo
        var sessions: [SessionSummary]
    }

    private func groupedHits(_ hits: [SessionSummary]) -> [ProjectHitGroup] {
        var groups: [String: ProjectHitGroup] = [:]
        for project in projects {
            let matched = hits.filter {
                cwdMatchesProject($0.cwd, projectPath: project.path, projectId: project.id, sessionProjectId: $0.projectId)
            }
            if !matched.isEmpty {
                groups[project.id] = ProjectHitGroup(
                    project: project,
                    sessions: matched.sorted { $0.updatedAt > $1.updatedAt }
                )
            }
        }
        return groups.values.sorted {
            $0.project.name.localizedCaseInsensitiveCompare($1.project.name) == .orderedAscending
        }
    }

    private func orphanHits(_ hits: [SessionSummary]) -> [SessionSummary] {
        hits.filter { s in
            !projects.contains {
                cwdMatchesProject(s.cwd, projectPath: $0.path, projectId: $0.id, sessionProjectId: s.projectId)
            }
        }
        .sorted { $0.updatedAt > $1.updatedAt }
    }

    /// Browse mode: recent sessions under a project (uncapped filter source for counts).
    private func browseSessions(for project: ProjectInfo) -> [SessionSummary] {
        let matched = localPool
            .filter {
                cwdMatchesProject($0.cwd, projectPath: project.path, projectId: project.id, sessionProjectId: $0.projectId)
            }
            .sorted { $0.updatedAt > $1.updatedAt }
        return Array(matched.prefix(Self.sessionCap))
    }

    private func cwdMatchesProject(
        _ cwd: String,
        projectPath: String,
        projectId: String,
        sessionProjectId: String?
    ) -> Bool {
        if let sessionProjectId, sessionProjectId == projectId { return true }
        let c = (cwd as NSString).standardizingPath
        let p = (projectPath as NSString).standardizingPath
        if c == p { return true }
        if c.hasPrefix(p + "/") || c.hasPrefix(p + "\\") { return true }
        // Last path component under Projects/ for ~/Projects/Foo variants
        let cLast = (c as NSString).lastPathComponent
        let pLast = (p as NSString).lastPathComponent
        if !pLast.isEmpty, cLast == pLast, c.contains("/Projects/") || c.contains("\\Projects\\") {
            return true
        }
        return false
    }

    private func scheduleContentSearch(_ raw: String) {
        contentSearchTask?.cancel()
        let q = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard q.count >= 2 else {
            hostSearchHits = nil
            isSearchingHost = false
            return
        }
        isSearchingHost = true
        contentSearchTask = Task {
            try? await Task.sleep(nanoseconds: 250_000_000)
            guard !Task.isCancelled else { return }
            guard let host = appState.selectedHost else {
                await MainActor.run {
                    hostSearchHits = []
                    isSearchingHost = false
                }
                return
            }
            do {
                let response = try await appState.api.sessions(host: host, query: q)
                guard !Task.isCancelled else { return }
                var hits = response.sessions
                hits.append(contentsOf: response.archivedSessions ?? [])
                await MainActor.run {
                    hostSearchHits = hits
                    isSearchingHost = false
                }
            } catch {
                guard !Task.isCancelled else { return }
                await MainActor.run {
                    // Keep local-only matches; don't wipe with nil forever
                    if hostSearchHits == nil { hostSearchHits = [] }
                    isSearchingHost = false
                }
            }
        }
    }

    private func load() async {
        guard let host = appState.selectedHost else {
            projects = []
            errorMessage = "Select a host / profile first"
            return
        }
        isLoading = true
        defer { isLoading = false }
        do {
            async let sessionsRefresh: () = appState.refreshSessions()
            let response = try await appState.api.projects(host: host)
            _ = await sessionsRefresh
            projects = response.projects
            errorMessage = nil
            // Re-run search against fresh session pool
            if isSearching {
                scheduleContentSearch(search)
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func shortPath(_ path: String) -> String {
        if let r = path.range(of: "/Projects/") { return String(path[r.upperBound...]) }
        if path.hasPrefix(NSHomeDirectory()) {
            return "~" + path.dropFirst(NSHomeDirectory().count)
        }
        return path
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
            Spacer()
        }
    }

    // MARK: - Empty state + sheets + CRUD handlers

    @ViewBuilder
    private var emptyProjectsPane: some View {
        VStack(spacing: 14) {
            Spacer()
            Image(systemName: "folder.badge.plus")
                .font(.system(size: 48))
                .foregroundStyle(DispatchColors.accent)
            Text("No projects yet")
                .font(.title3.bold())
            Text("Projects group sessions across profiles and hold shared paths + attachments. Create one to get started, or import folders already on this Mac.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 36)
            HStack(spacing: 12) {
                Button {
                    activeSheet = .new
                } label: {
                    Label("New project", systemImage: "plus.circle.fill")
                        .padding(.horizontal, 6)
                }
                .buttonStyle(.borderedProminent)
                Button {
                    Task { await runDiscover() }
                } label: {
                    Label(isDiscovering ? "Scanning…" : "Import from disk…", systemImage: "sparkle.magnifyingglass")
                        .padding(.horizontal, 6)
                }
                .buttonStyle(.bordered)
                .disabled(isDiscovering)
            }
            .padding(.top, 6)
            Spacer()
        }
    }

    @ViewBuilder
    private func sheetContent(for sheet: ProjectSheet) -> some View {
        if let host = appState.selectedHost {
            switch sheet {
            case .new:
                ProjectEditorView(
                    mode: .new,
                    host: host,
                    onSaved: { saved in
                        projects.append(saved)
                        activeSheet = nil
                        Task { await load() }
                    },
                    onCancel: { activeSheet = nil }
                )
                .environmentObject(appState)
            case .edit(let p):
                ProjectEditorView(
                    mode: .edit(p),
                    host: host,
                    onSaved: { saved in
                        if let idx = projects.firstIndex(where: { $0.id == saved.id }) {
                            projects[idx] = saved
                        }
                        activeSheet = nil
                        Task { await load() }
                    },
                    onCancel: { activeSheet = nil }
                )
                .environmentObject(appState)
            case .importCandidates(let candidates):
                ProjectImportSheet(
                    candidates: candidates,
                    host: host,
                    onDone: {
                        activeSheet = nil
                        Task { await load() }
                    },
                    onCancel: { activeSheet = nil }
                )
                .environmentObject(appState)
            }
        } else {
            Text("Select a host first").padding()
        }
    }

    // MARK: - CRUD actions

    private func softDelete(_ project: ProjectInfo) async {
        guard let host = appState.selectedHost else { return }
        do {
            _ = try await appState.api.updateProject(id: project.id, archived: true, host: host)
        } catch {
            errorMessage = error.localizedDescription
        }
        deletionCandidate = nil
        await load()
    }

    private func hardDelete(_ project: ProjectInfo) async {
        guard let host = appState.selectedHost else { return }
        do {
            try await appState.api.deleteProject(id: project.id, hard: true, host: host)
        } catch {
            errorMessage = error.localizedDescription
        }
        deletionCandidate = nil
        await load()
    }

    private func runDiscover() async {
        guard let host = appState.selectedHost else { return }
        isDiscovering = true
        defer { isDiscovering = false }
        do {
            let candidates = try await appState.api.discoverProjects(host: host)
            if candidates.isEmpty {
                errorMessage = "No new candidates found on this host."
            } else {
                activeSheet = .importCandidates(candidates)
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

// MARK: - Import candidates sheet

/// Simple "pick which to add" list surfaced by the /projects/discover endpoint.
/// User taps rows to toggle inclusion, then Import creates them.
private struct ProjectImportSheet: View {
    let candidates: [ProjectInfo]
    let host: HostEndpoint
    var onDone: () -> Void
    var onCancel: () -> Void

    @EnvironmentObject private var appState: AppState

    @State private var selected: Set<String>
    @State private var isImporting = false
    @State private var errorMessage: String?

    init(candidates: [ProjectInfo], host: HostEndpoint, onDone: @escaping () -> Void, onCancel: @escaping () -> Void) {
        self.candidates = candidates
        self.host = host
        self.onDone = onDone
        self.onCancel = onCancel
        self._selected = State(initialValue: Set(candidates.map { $0.id }))
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(candidates) { c in
                        Button {
                            if selected.contains(c.id) { selected.remove(c.id) } else { selected.insert(c.id) }
                        } label: {
                            HStack(spacing: 10) {
                                Image(systemName: selected.contains(c.id) ? "checkmark.circle.fill" : "circle")
                                    .foregroundStyle(selected.contains(c.id) ? DispatchColors.accent : .secondary)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(c.name).font(.body.weight(.semibold))
                                    Text(c.primaryPath)
                                        .font(.system(.caption, design: .monospaced))
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                        .truncationMode(.middle)
                                }
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                } footer: {
                    Text("Only paths that exist on the host and aren't already projects show up here. Uncheck any you don't want.")
                        .font(.caption2)
                }
                if let err = errorMessage {
                    Section {
                        Text(err).font(.caption).foregroundStyle(DispatchColors.danger)
                    }
                }
            }
            .navigationTitle("Import projects")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel).disabled(isImporting)
                }
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        Task { await runImport() }
                    } label: {
                        if isImporting {
                            ProgressView().controlSize(.small)
                        } else {
                            Text("Import \(selected.count)")
                                .fontWeight(.semibold)
                        }
                    }
                    .disabled(isImporting || selected.isEmpty)
                }
            }
        }
    }

    private func runImport() async {
        errorMessage = nil
        isImporting = true
        defer { isImporting = false }
        var failed: [String] = []
        for c in candidates where selected.contains(c.id) {
            do {
                _ = try await appState.api.createProject(
                    name: c.name,
                    paths: c.effectivePaths,
                    color: c.color,
                    defaultProfileId: c.defaultProfileId,
                    host: host
                )
            } catch {
                failed.append("\(c.name): \(error.localizedDescription)")
            }
        }
        if !failed.isEmpty {
            errorMessage = "Some imports failed:\n" + failed.joined(separator: "\n")
        } else {
            onDone()
        }
    }
}
