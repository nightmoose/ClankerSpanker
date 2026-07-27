import SwiftUI

struct DashboardView: View {
    @EnvironmentObject private var appState: AppState
    @StateObject private var vm = DashboardViewModel()
    @State private var pendingRoute: SessionRoute?
    @State private var search = ""
    @State private var showArchived = false

    var body: some View {
        NavigationStack {
            ZStack {
                DispatchBackground()
                VStack(spacing: 0) {
                    profilePicker
                        .padding(.horizontal)
                        .padding(.top, 8)

                    if let err = vm.errorMessage ?? appState.lastRefreshError {
                        Text(err)
                            .font(.footnote)
                            .foregroundStyle(DispatchColors.danger)
                            .padding(.horizontal)
                            .padding(.top, 6)
                    }

                    profileContent
                }
            }
            .navigationTitle(navigationTitle)
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
            .searchable(text: $search, prompt: searchPrompt)
            .toolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button {
                        showArchived.toggle()
                    } label: {
                        Image(systemName: showArchived ? "tray.full.fill" : "tray")
                    }
                    Button {
                        Task { await vm.load(appState: appState) }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                }
            }
            .refreshable { await vm.load(appState: appState) }
            .task { await vm.load(appState: appState) }
        }
    }

    private var navigationTitle: String {
        if showArchived { return "Archived" }
        return appState.selectedBoundProfile?.displayName ?? "ClankerSpanker"
    }

    private var searchPrompt: String {
        if showArchived { return "Search archived" }
        let name = appState.selectedBoundProfile?.displayName ?? "sessions"
        let host = appState.selectedBoundProfile?.hostLabel ?? ""
        return host.isEmpty ? "Search \(name)" : "Search \(name) · \(host)"
    }

    // MARK: - Colored profile chips (per host)

    private var profilePicker: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(appState.boundProfiles) { bound in
                    let selected = bound.id == appState.selectedBoundProfileId
                    Button {
                        appState.selectBoundProfile(bound.id)
                        showArchived = false
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 6) {
                                Circle()
                                    .fill(bound.uiColor)
                                    .frame(width: 8, height: 8)
                                Text(bound.displayName)
                                    .font(.subheadline.weight(selected ? .bold : .semibold))
                                Text(bound.backendLabel)
                                    .font(.caption2.weight(.bold))
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(bound.uiColor.opacity(selected ? 0.35 : 0.18))
                                    .clipShape(Capsule())
                            }
                            Text(bound.hostLabel)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .foregroundStyle(selected ? Color.primary : Color.secondary)
                        .background(
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .fill(selected ? bound.uiColor.opacity(0.22) : Color.white.opacity(0.06))
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .stroke(selected ? bound.uiColor : Color.white.opacity(0.08), lineWidth: selected ? 1.5 : 1)
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.vertical, 4)
        }
    }

    @ViewBuilder
    private var profileContent: some View {
        if appState.boundProfiles.isEmpty && !vm.isLoading {
            emptyPane(
                icon: "desktopcomputer",
                title: "No hosts / profiles",
                body: "Add a host in Settings (Mac Mini or client laptop), then profiles appear here."
            )
        } else if showArchived {
            sessionList(
                rows: filteredArchived,
                emptyTitle: "No archived chats",
                emptyBody: "Swipe left on a chat and Archive.",
                unarchive: true
            )
        } else {
            List {
                Section {
                    HStack {
                        Text("\(filteredActive.count) chat\(filteredActive.count == 1 ? "" : "s")")
                        Spacer()
                        Text(appState.connectionLabel)
                            .foregroundStyle(appState.socket.isConnected ? DispatchColors.success : .secondary)
                        if let p = appState.selectedBoundProfile {
                            Text(p.hostLabel)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .listRowBackground(Color.clear)
                }

                Section {
                    if let bound = appState.selectedBoundProfile {
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
                    }

                    if filteredActive.isEmpty && !vm.isLoading {
                        Text("No active chats yet. Tap New session above — it uses the selected profile (\(appState.selectedBoundProfile.map { "\($0.displayName) / \($0.backendLabel)" } ?? "profile")), not always Grok.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .listRowBackground(Color.clear)
                    } else {
                        ForEach(filteredActive) { session in
                            if let hostId = appState.selectedHost?.id {
                                NavigationLink(value: SessionRoute(hostId: hostId, sessionId: session.id)) {
                                    SessionRowView(session: session)
                                }
                                .listRowBackground(DispatchColors.card)
                                .swipeActions(edge: .trailing, allowsFullSwipe: true) {
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
                } header: {
                    Text("Active")
                }

                if let bound = appState.selectedBoundProfile {
                    if bound.profile.isGrok {
                        diskSection(title: "Grok on disk", items: filteredGrokDisk, kind: .grok)
                    } else {
                        diskSection(title: "Claude on disk", items: filteredClaudeDisk, kind: .claude)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .listStyle(.insetGrouped)
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
            if let b = appState.selectedBoundProfile {
                Text("Host: \(b.hostLabel) · \(b.host.baseURL)")
                    .font(.caption2)
            }
        }
    }

    private func sessionList(rows: [SessionSummary], emptyTitle: String, emptyBody: String, unarchive: Bool) -> some View {
        Group {
            if rows.isEmpty && !vm.isLoading {
                emptyPane(icon: "tray", title: emptyTitle, body: emptyBody)
            } else {
                List {
                    ForEach(rows) { session in
                        if let hostId = appState.selectedHost?.id {
                            NavigationLink(value: SessionRoute(hostId: hostId, sessionId: session.id)) {
                                SessionRowView(session: session)
                            }
                            .listRowBackground(DispatchColors.card)
                            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                                if unarchive {
                                    Button {
                                        Task { await vm.unarchive(sessionId: session.id, appState: appState) }
                                    } label: {
                                        Label("Unarchive", systemImage: "tray.and.arrow.up")
                                    }
                                    .tint(DispatchColors.accent)
                                }
                            }
                        }
                    }
                }
                .scrollContentBackground(.hidden)
                .listStyle(.insetGrouped)
            }
        }
    }

    private var filteredActive: [SessionSummary] {
        filterSessions(appState.sessions.filter { matchesSelectedProfile($0) })
    }

    private var filteredArchived: [SessionSummary] {
        filterSessions(appState.archivedSessions.filter { matchesSelectedProfile($0) })
    }

    private var filteredGrokDisk: [DiskSessionHint] { filterDisk(appState.diskSessions) }
    private var filteredClaudeDisk: [DiskSessionHint] { filterDisk(appState.claudeSessions) }

    private func matchesSelectedProfile(_ s: SessionSummary) -> Bool {
        guard let bound = appState.selectedBoundProfile else { return true }
        if let sp = s.profileId { return sp == bound.profile.id }
        let backend = s.backend ?? (s.model.lowercased().contains("claude") ? "claude" : "grok")
        return backend == bound.profile.backend
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

    private func filterDisk(_ items: [DiskSessionHint]) -> [DiskSessionHint] {
        let q = search.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return items }
        return items.filter {
            ($0.title ?? "").lowercased().contains(q)
                || ($0.cwd ?? "").lowercased().contains(q)
                || $0.id.lowercased().contains(q)
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
