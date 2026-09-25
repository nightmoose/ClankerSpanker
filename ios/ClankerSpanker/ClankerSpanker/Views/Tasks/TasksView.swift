import SwiftUI

struct TasksView: View {
    @EnvironmentObject private var appState: AppState
    @State private var tasks: [SessionTask] = []
    @State private var showDone: Bool = false
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var pendingRoute: SessionRoute?
    @State private var search = ""
    @State private var showSearchField = false
    @FocusState private var searchFocused: Bool

    private let tasksSearchPrompt = "Search tasks & sessions"

    private var isSearching: Bool {
        !search.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Open/done filter, then optional text search on task body + session title.
    private var filtered: [SessionTask] {
        let base = showDone ? tasks : tasks.filter { !$0.isDone }
        let q = search.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return base }
        return base.filter { task in
            task.text.localizedCaseInsensitiveContains(q)
                || sessionTitle(for: task).localizedCaseInsensitiveContains(q)
        }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                DispatchBackground()
                VStack(spacing: 0) {
                    tasksChrome
                    content
                }
            }
            .navigationTitle("")
            #if os(iOS)
            .toolbar(.hidden, for: .navigationBar)
            #endif
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
            .onReceive(NotificationCenter.default.publisher(for: .dispatchSocketEvent)) { note in
                guard let data = note.object as? Data,
                      let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let event = root["event"] as? [String: Any],
                      let type = event["type"] as? String
                else { return }
                if type.hasPrefix("task.") {
                    Task { await load() }
                }
            }
            .onChange(of: appState.selectedHost?.id) { _, _ in
                Task { await load() }
            }
            .onChange(of: appState.tabRefreshTick) { _, _ in
                guard appState.selectedTab == .tasks else { return }
                Task { await load() }
            }
        }
    }

    /// Sticky controls under the app tab strip — matches Sessions / Projects.
    private var tasksChrome: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Toggle(isOn: $showDone) {
                    Label(
                        showDone ? "Showing done" : "Open only",
                        systemImage: showDone ? "checkmark.circle.fill" : "circle"
                    )
                    .font(.subheadline.weight(.semibold))
                    .labelStyle(.titleAndIcon)
                }
                .toggleStyle(.button)
                .tint(showDone ? DispatchColors.accent : .secondary)
                .help("Include completed tasks")

                Spacer(minLength: 8)

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
                .accessibilityLabel("Search tasks")
            }
            .padding(.horizontal, 12)
            .padding(.top, 4)
            .padding(.bottom, showSearchField || isSearching ? 4 : 6)

            if showSearchField || isSearching {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass")
                        .foregroundStyle(.secondary)
                    TextField(tasksSearchPrompt, text: $search)
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

            if appState.selectedHost != nil, !tasks.isEmpty || isLoading {
                HStack(spacing: 8) {
                    Text(statusLabel)
                    Spacer(minLength: 8)
                    if let host = appState.selectedHost {
                        Text(host.name)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 16)
                .padding(.bottom, 4)
            }

            if let err = errorMessage, !tasks.isEmpty {
                Text(err)
                    .font(.footnote)
                    .foregroundStyle(DispatchColors.danger)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 4)
            }
        }
        .background(.ultraThinMaterial)
    }

    private var statusLabel: String {
        let open = tasks.filter { !$0.isDone }.count
        let done = tasks.count - open
        if isSearching {
            return "\(filtered.count) match\(filtered.count == 1 ? "" : "es")"
        }
        if showDone {
            return "\(open) open · \(done) done"
        }
        return "\(open) open task\(open == 1 ? "" : "s")"
    }

    @ViewBuilder
    private var content: some View {
        if appState.selectedHost == nil {
            empty(icon: "desktopcomputer", title: "No host", body: "Pick a host in Settings.")
        } else if isLoading && tasks.isEmpty {
            ProgressView("Loading tasks…").frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let err = errorMessage, tasks.isEmpty {
            empty(icon: "exclamationmark.triangle", title: "Couldn't load", body: err)
        } else if filtered.isEmpty {
            empty(
                icon: isSearching ? "magnifyingglass" : (showDone ? "checkmark.seal" : "checklist"),
                title: isSearching
                    ? "No matches"
                    : (showDone ? "Nothing done yet" : "No open tasks"),
                body: isSearching
                    ? "Nothing matched “\(search.trimmingCharacters(in: .whitespacesAndNewlines))”."
                    : "Long-press any message in a session to capture a todo."
            )
        } else {
            List {
                ForEach(filtered) { task in
                    row(task)
                        .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
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
    }

    private func row(_ task: SessionTask) -> some View {
        Button {
            openSource(task)
        } label: {
            HStack(alignment: .top, spacing: 10) {
                Button {
                    Task { await toggle(task) }
                } label: {
                    Image(systemName: task.isDone ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(task.isDone ? DispatchColors.accent : .secondary)
                        .font(.body)
                }
                .buttonStyle(.plain)

                VStack(alignment: .leading, spacing: 3) {
                    Text(task.text)
                        .font(.body.weight(.medium))
                        .strikethrough(task.isDone)
                        .foregroundStyle(task.isDone ? .secondary : .primary)
                        .multilineTextAlignment(.leading)
                        .lineLimit(nil)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: 6) {
                        Image(systemName: "text.bubble").font(.caption2).foregroundStyle(.tertiary)
                        Text(sessionTitle(for: task))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                        if task.sourceMessageId != nil {
                            Text("· original message")
                                .font(.caption2)
                                .foregroundStyle(DispatchColors.accent)
                        }
                    }
                }
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .listRowBackground(DispatchColors.card)
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            Button(role: .destructive) {
                Task { await delete(task) }
            } label: { Label("Delete", systemImage: "trash") }
        }
    }

    private func empty(icon: String, title: String, body: String) -> some View {
        VStack(spacing: 14) {
            Spacer()
            Image(systemName: icon).font(.system(size: 48)).foregroundStyle(DispatchColors.accent)
            Text(title).font(.title3.bold())
            Text(body).font(.subheadline).foregroundStyle(.secondary)
                .multilineTextAlignment(.center).padding(.horizontal, 36)
            Spacer()
        }
    }

    private func sessionTitle(for task: SessionTask) -> String {
        (appState.sessions + appState.archivedSessions)
            .first(where: { $0.id == task.sourceSessionId })?.title ?? "(session)"
    }

    private func openSource(_ task: SessionTask) {
        // Route to the session's own host (RFC-024) so opening a task from
        // host B doesn't land on host A's session list.
        let host = appState.endpoint(forSessionId: task.sourceSessionId) ?? appState.selectedHost
        guard let host else { return }
        pendingRoute = SessionRoute(
            hostId: host.id,
            sessionId: task.sourceSessionId,
            messageId: task.sourceMessageId
        )
    }

    /// RFC-024: fan out /tasks across every host so tasks from all hosts
    /// appear in the aggregate list. Route mutations back to the host that
    /// owns each task's source session via `appState.endpoint(forSessionId:)`.
    private func load() async {
        let hosts = appState.hosts.filter { !$0.loadToken().isEmpty }
        guard !hosts.isEmpty else {
            tasks = []
            errorMessage = "Add a host in Settings"
            return
        }
        isLoading = true
        defer { isLoading = false }

        let api = appState.api
        struct Bundle: Sendable { let host: HostEndpoint; let tasks: [SessionTask]; let error: String? }
        let bundles: [Bundle] = await withTaskGroup(of: Bundle.self) { group in
            for host in hosts {
                group.addTask {
                    do {
                        let list = try await api.listTasks(host: host)
                        return Bundle(host: host, tasks: list, error: nil)
                    } catch let e as APIError {
                        if case .http(let code, let body) = e, code == 404 {
                            return Bundle(
                                host: host, tasks: [],
                                error: "\(host.name): needs a newer host build for /tasks"
                            )
                        }
                        return Bundle(host: host, tasks: [], error: "\(host.name): \(e.localizedDescription)")
                    } catch {
                        return Bundle(host: host, tasks: [], error: "\(host.name): \(error.localizedDescription)")
                    }
                }
            }
            var out: [Bundle] = []
            for await b in group { out.append(b) }
            return out
        }

        tasks = bundles.flatMap(\.tasks)
        let failures = bundles.compactMap(\.error)
        if failures.isEmpty {
            errorMessage = nil
        } else if failures.count == bundles.count {
            errorMessage = failures.first
        } else {
            errorMessage = failures.joined(separator: " · ")
        }
    }

    private func toggle(_ task: SessionTask) async {
        guard let host = appState.endpoint(forSessionId: task.sourceSessionId) else { return }
        do {
            let updated = try await appState.api.updateTask(
                sessionId: task.sourceSessionId,
                taskId: task.id,
                status: task.isDone ? "open" : "done",
                host: host
            )
            if let idx = tasks.firstIndex(where: { $0.id == updated.id }) { tasks[idx] = updated }
        } catch { errorMessage = error.localizedDescription }
    }

    private func delete(_ task: SessionTask) async {
        guard let host = appState.endpoint(forSessionId: task.sourceSessionId) else { return }
        do {
            try await appState.api.deleteTask(
                sessionId: task.sourceSessionId,
                taskId: task.id,
                host: host
            )
            tasks.removeAll { $0.id == task.id }
        } catch { errorMessage = error.localizedDescription }
    }
}
