import Foundation
import SwiftUI
import Combine
#if os(iOS)
import UIKit
#endif

@MainActor
final class AppState: ObservableObject {
    @Published var selectedTab: AppTab = .sessions
    /// Bumped when the user re-taps the already-selected top tab — views
    /// treat that as "refresh this surface" (no standalone refresh buttons).
    @Published private(set) var tabRefreshTick: UInt = 0
    @Published var isConfigured: Bool = false
    @Published private(set) var connectionLabel: String = "Offline"
    /// True after a successful sessions REST fetch for the active host.
    @Published private(set) var hostAPIReachable: Bool = false

    let api = APIClient()
    let socket = WebSocketClient()

    /// Registered host machines.
    @Published var hosts: [HostEndpoint] = []
    /// Profiles from all hosts (colored nav chips) — one per profile id per endpoint.
    @Published var boundProfiles: [BoundProfile] = []
    /// Primary/focus profile for compose defaults + host selection.
    @Published var selectedBoundProfileId: String?
    /// Multi-select filter: bound-profile ids whose chips are ON.
    /// All on ⇒ show every session. Subset ⇒ filter. Empty after load is
    /// normalized to all-on (see `normalizeEnabledProfiles`).
    @Published var enabledBoundProfileIds: Set<String> = []

    /// macOS command center: session selected in the middle list (inline detail).
    @Published var macSelectedSessionId: String?

    /// macOS right-side file viewer state. `showMacViewer` controls whether the
    /// pane is visible; `macViewerFilePath` triggers loading a specific file
    /// (set from anywhere: diff/tool call taps, drag-and-drop, etc.).
    @Published var showMacViewer: Bool = false
    @Published var macViewerFilePath: String?

    /// Open a file in the right-side viewer (Mac only; no-op elsewhere).
    /// Also opens the viewer pane if hidden.
    func openInViewer(_ path: String) {
        macViewerFilePath = path
        showMacViewer = true
    }

    /// When set, Dispatch applies this once (project / path / draft) then clears it.
    @Published var composePrefill: ComposePrefill?

    /// Open Dispatch with a project (or freeform path) already selected.
    func openCompose(projectId: String? = nil, cwd: String? = nil, title: String? = nil, prompt: String? = nil) {
        composePrefill = ComposePrefill(projectId: projectId, cwd: cwd, title: title, prompt: prompt)
        selectedTab = .compose
    }

    /// Top tab strip: switch tabs, or refresh when the same tab is tapped again.
    func activateTab(_ tab: AppTab) {
        if selectedTab == tab {
            tabRefreshTick &+= 1
        } else {
            selectedTab = tab
        }
    }

    /// Sessions for the currently selected host (filtered by profile in the dashboard).
    @Published var sessions: [SessionSummary] = []
    @Published var archivedSessions: [SessionSummary] = []
    @Published var diskSessions: [DiskSessionHint] = []
    @Published var claudeSessions: [DiskSessionHint] = []
    @Published var agySessions: [DiskSessionHint] = []
    @Published var lastRefreshError: String?

    private var cancellables = Set<AnyCancellable>()
    /// Coalesce socket-driven list refreshes. A live Grok turn emits hundreds
    /// of events; refetching GET /sessions on each one is what made the Mac
    /// client crawl until relaunch.
    private var sessionRefreshTask: Task<Void, Never>?
    #if os(iOS)
    private var pendingDeviceToken: String?
    private var lastPushRegistration: String?
    #endif

    init() {
        reloadHosts()
        var wasConnected = false
        socket.$isConnected
            .receive(on: RunLoop.main)
            .sink { [weak self] connected in
                self?.updateConnectionLabel()
                // Emit a reconnect notification so open SessionDetailViewModels
                // can call the event-replay endpoint and catch anything that
                // fired during the WS gap.
                if connected && !wasConnected {
                    NotificationCenter.default.post(
                        name: .dispatchSocketReconnected,
                        object: nil
                    )
                }
                wasConnected = connected
            }
            .store(in: &cancellables)

        socket.onEvent = { [weak self] data in
            self?.handleSocketData(data)
        }

        NotificationCenter.default.publisher(for: .dispatchNotificationAction)
            .compactMap { $0.object as? [String: Any] }
            .sink { [weak self] payload in
                Task { @MainActor in
                    self?.handleNotificationAction(payload)
                }
            }
            .store(in: &cancellables)

        #if os(iOS)
        NotificationCenter.default.publisher(for: .dispatchDeviceToken)
            .compactMap { $0.object as? String }
            .sink { [weak self] token in
                Task { @MainActor in
                    self?.pendingDeviceToken = token
                    self?.registerPushIfNeeded()
                }
            }
            .store(in: &cancellables)
        #endif
    }

    #if os(iOS)
    /// Upload the APNs device token to the selected host (once per token+host).
    private func registerPushIfNeeded() {
        guard let token = pendingDeviceToken, let host = selectedHost else { return }
        let key = "\(host.id.uuidString)|\(token)"
        if lastPushRegistration == key { return }
        lastPushRegistration = key
        let name = UIDevice.current.name
        Task {
            do {
                try await api.registerPush(
                    token: token,
                    clientHostId: host.id.uuidString,
                    name: name,
                    host: host
                )
            } catch {
                lastPushRegistration = nil
            }
        }
    }
    #endif

    /// Handle Approve/Reject taps that came from the notification action
    /// buttons. Looks up the host from userInfo, then calls the same REST
    /// endpoints the in-app buttons use.
    private func handleNotificationAction(_ payload: [String: Any]) {
        let action = payload["action"] as? String ?? ""
        guard let info = payload["userInfo"] as? [String: Any],
              let kind = info["kind"] as? String,
              let sessionId = info["sessionId"] as? String
        else { return }
        let host: HostEndpoint? = {
            if let hostIdString = info["hostId"] as? String,
               let hostId = UUID(uuidString: hostIdString),
               let match = hosts.first(where: { $0.id == hostId }) {
                return match
            }
            return selectedHost ?? hosts.first
        }()
        guard let host else { return }

        switch kind {
        case "approval":
            guard let approvalId = info["approvalId"] as? String else { return }
            Task {
                do {
                    if action == NotificationService.approveActionId {
                        _ = try await api.approve(
                            sessionId: sessionId,
                            approvalId: approvalId,
                            comment: nil,
                            host: host
                        )
                    } else if action == NotificationService.rejectActionId {
                        _ = try await api.reject(
                            sessionId: sessionId,
                            approvalId: approvalId,
                            comment: nil,
                            host: host
                        )
                    }
                    // Default tap and Approve/Reject both refresh so the
                    // home-screen badge drops when the work is done.
                    await self.refreshSessions()
                } catch {
                    NotificationService.notify(
                        title: "Couldn't resolve approval",
                        body: error.localizedDescription
                    )
                }
            }
        case "question":
            // No inline actions — just refresh so the user finds the session.
            Task { await refreshSessions() }
        default:
            break
        }
    }

    private func updateConnectionLabel() {
        if socket.isConnected {
            connectionLabel = "Live"
        } else if hostAPIReachable {
            connectionLabel = "API up"
        } else {
            connectionLabel = "Offline"
        }
    }

    #if os(macOS)
    /// Bricklayer-style: on the machine that owns the gateway, wire ourselves up automatically.
    /// Reads `~/.grok-dispatch/config.json`, starts host if needed, registers localhost + token.
    func ensureLocalHostOnMac() async throws {
        let hostCtrl = LocalHostController.shared
        await hostCtrl.refreshStatus()

        if !hostCtrl.apiReachable {
            // Connect only. Kick the standalone repo LaunchAgent; never
            // spawn node or install the Application Support copy.
            hostCtrl.start()
            for _ in 0..<40 {
                try? await Task.sleep(nanoseconds: 250_000_000)
                await hostCtrl.refreshStatus()
                if hostCtrl.apiReachable { break }
            }
        }

        guard hostCtrl.apiReachable else {
            throw APIError.transport(
                NSError(
                    domain: "ClankerSpanker",
                    code: 1,
                    userInfo: [
                        NSLocalizedDescriptionKey:
                            "Local host not reachable at \(hostCtrl.localBaseURL). The gateway is the standalone LaunchAgent com.nightmoose.grok-dispatch-host, not this app.",
                    ]
                )
            )
        }

        guard let token = hostCtrl.readHostToken(), !token.isEmpty else {
            throw APIError.notConfigured
        }

        let url = hostCtrl.localBaseURL
        // Reuse existing localhost host if present; otherwise create
        if let existing = hosts.first(where: { isLoopbackURL($0.baseURL) }) {
            var h = existing
            h.baseURL = url
            if h.name.isEmpty || h.name == "Primary" { h.name = "This Mac" }
            upsertHost(h, token: token)
        } else {
            let h = HostEndpoint(name: "This Mac", baseURL: url)
            upsertHost(h, token: token)
        }

        // Prefer local host for session list
        if let local = hosts.first(where: { isLoopbackURL($0.baseURL) }) {
            socket.connect(host: local)
        }
    }

    private func isLoopbackURL(_ raw: String) -> Bool {
        guard let u = URL(string: raw), let host = u.host?.lowercased() else { return false }
        return host == "127.0.0.1" || host == "localhost" || host == "::1"
    }
    #endif

    /// Profiles shown in the chip bar (hides the leftover NightMoose Bot chip).
    var visibleBoundProfiles: [BoundProfile] {
        boundProfiles.filter { !$0.profile.isHiddenChip }
    }

    /// True when every known profile chip is ON (or none loaded yet).
    var showsAllProfiles: Bool {
        let allIds = Set(visibleBoundProfiles.map(\.id))
        guard !allIds.isEmpty else { return true }
        return allIds.isSubset(of: enabledBoundProfileIds)
    }

    /// Sessions currently blocked waiting for the user (approve/answer).
    /// Union of the active list and any archived-but-still-pending items.
    /// Used to drive the "needs your attention" inbox banner + tab badge.
    var attentionSessions: [SessionSummary] {
        let all = sessions + archivedSessions
        var seen = Set<String>()
        var out: [SessionSummary] = []
        for s in all {
            guard !seen.contains(s.id) else { continue }
            if s.status == .awaitingApproval || s.status == .awaitingQuestion {
                seen.insert(s.id)
                out.append(s)
            }
        }
        return out.sorted { $0.updatedAt > $1.updatedAt }
    }

    /// Focus profile for compose / host: last toggled-on chip, else first enabled.
    var selectedBoundProfile: BoundProfile? {
        if let id = selectedBoundProfileId,
           id != HostStore.allProfilesId,
           let hit = boundProfiles.first(where: { $0.id == id }),
           enabledBoundProfileIds.contains(id) || showsAllProfiles {
            return hit
        }
        return boundProfiles.first { enabledBoundProfileIds.contains($0.id) }
            ?? boundProfiles.first
    }

    var selectedHost: HostEndpoint? {
        if let h = selectedBoundProfile?.host { return h }
        // All-on / no focus yet: prefer first host that has a token
        return hosts.first(where: { !$0.loadToken().isEmpty }) ?? hosts.first
    }

    /// Bound profiles whose chips are currently ON (filter set).
    var enabledBoundProfiles: [BoundProfile] {
        boundProfiles.filter { enabledBoundProfileIds.contains($0.id) }
    }

    // MARK: - Host registry

    func reloadHosts() {
        hosts = HostStore.loadHosts()
        isConfigured = !hosts.isEmpty && hosts.contains { !$0.loadToken().isEmpty }
        selectedBoundProfileId = HostStore.selectedBoundProfileId
        loadEnabledProfilesFromStore()
        if isConfigured, let host = selectedHost {
            socket.connect(host: host)
        } else {
            socket.disconnect()
        }
    }

    /// Restore multi-select chip state. Migrates legacy single-select "All".
    private func loadEnabledProfilesFromStore() {
        let saved = HostStore.enabledBoundProfileIds
        if !saved.isEmpty {
            enabledBoundProfileIds = Set(saved)
            return
        }
        // Legacy: single chip or All sentinel
        if let legacy = HostStore.selectedBoundProfileId,
           legacy != HostStore.allProfilesId {
            enabledBoundProfileIds = [legacy]
        } else {
            // Empty ⇒ enable-all once profiles arrive
            enabledBoundProfileIds = []
        }
    }

    private func persistEnabledProfiles() {
        HostStore.enabledBoundProfileIds = Array(enabledBoundProfileIds).sorted()
    }

    func saveHosts(_ list: [HostEndpoint]) {
        HostStore.saveHosts(list)
        hosts = list
        isConfigured = !list.isEmpty && list.contains { !$0.loadToken().isEmpty }
        UserDefaults.standard.set(true, forKey: "hasCompletedOnboarding")
        if let host = selectedHost ?? list.first {
            socket.connect(host: host)
        }
    }

    func upsertHost(_ host: HostEndpoint, token: String) {
        var list = hosts
        if let idx = list.firstIndex(where: { $0.id == host.id }) {
            list[idx] = host
        } else {
            list.append(host)
        }
        host.saveToken(token)
        // Also keep legacy keys in sync for first host (deep links / old code paths)
        if list.count == 1 || list.first?.id == host.id {
            KeychainHelper.save(string: host.baseURL, key: KeychainHelper.Keys.hostURL)
            KeychainHelper.save(string: token, key: KeychainHelper.Keys.hostToken)
        }
        saveHosts(list)
    }

    func removeHost(id: UUID) {
        var list = hosts
        if let h = list.first(where: { $0.id == id }) {
            h.deleteToken()
        }
        list.removeAll { $0.id == id }
        saveHosts(list)
        Task { await refreshSessions() }
    }

    func clearConfiguration() {
        for h in hosts { h.deleteToken() }
        hosts = []
        HostStore.saveHosts([])
        KeychainHelper.delete(key: KeychainHelper.Keys.hostURL)
        KeychainHelper.delete(key: KeychainHelper.Keys.hostToken)
        KeychainHelper.delete(key: KeychainHelper.Keys.xaiAPIKey)
        UserDefaults.standard.removeObject(forKey: "hasCompletedOnboarding")
        sessions = []
        archivedSessions = []
        boundProfiles = []
        enabledBoundProfileIds = []
        selectedBoundProfileId = nil
        HostStore.enabledBoundProfileIds = []
        HostStore.selectedBoundProfileId = nil
        isConfigured = false
        socket.disconnect()
        NotificationService.setAppIconBadge(0)
    }

    /// Legacy single-host save (onboarding + deep link).
    func saveConfiguration(hostURL: String, hostToken: String, xaiKey: String?) {
        let host = HostEndpoint(name: "Primary", baseURL: hostURL)
        if let existing = hosts.first {
            var h = existing
            h.baseURL = host.baseURL
            if h.name.isEmpty { h.name = "Primary" }
            upsertHost(h, token: hostToken)
        } else {
            upsertHost(host, token: hostToken)
        }
        if let xaiKey, !xaiKey.isEmpty {
            KeychainHelper.save(string: xaiKey, key: KeychainHelper.Keys.xaiAPIKey)
        }
    }

    func handleDeepLink(_ url: URL) {
        guard url.scheme == "clankerspanker" || url.scheme == "grokdispatch" else { return }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let hostURL = items.first(where: { $0.name == "url" })?.value
        let token = items.first(where: { $0.name == "token" })?.value
        let name = items.first(where: { $0.name == "name" })?.value ?? "Primary"
        guard let hostURL, let token, !hostURL.isEmpty, !token.isEmpty else { return }
        let host = HostEndpoint(name: name, baseURL: hostURL)
        upsertHost(host, token: token)
        Task {
            try? await api.validate(host: host)
            await refreshSessions()
        }
    }

    /// Toggle a filter chip on/off. Turning one on also focuses it for compose.
    func toggleBoundProfile(_ id: String) {
        guard id != HostStore.allProfilesId else {
            enableAllBoundProfiles()
            return
        }
        if enabledBoundProfileIds.contains(id) {
            enabledBoundProfileIds.remove(id)
            // Keep focus on something still enabled
            if selectedBoundProfileId == id {
                selectedBoundProfileId = enabledBoundProfileIds.first
                HostStore.selectedBoundProfileId = selectedBoundProfileId
            }
        } else {
            enabledBoundProfileIds.insert(id)
            selectedBoundProfileId = id
            HostStore.selectedBoundProfileId = id
        }
        persistEnabledProfiles()
        if let host = selectedHost {
            socket.connect(host: host)
        }
        Task { await refreshSessions() }
    }

    /// Turn every profile chip ON (filter = show all).
    func enableAllBoundProfiles() {
        enabledBoundProfileIds = Set(boundProfiles.map(\.id))
        if selectedBoundProfileId == nil || selectedBoundProfileId == HostStore.allProfilesId
            || !(enabledBoundProfileIds.contains(selectedBoundProfileId ?? "")) {
            selectedBoundProfileId = boundProfiles.first?.id
            HostStore.selectedBoundProfileId = selectedBoundProfileId
        }
        persistEnabledProfiles()
        if let host = selectedHost {
            socket.connect(host: host)
        }
        Task { await refreshSessions() }
    }

    /// Focus a profile and ensure its chip is ON (compose, transfer, attach).
    /// Passing `HostStore.allProfilesId` enables every chip.
    func selectBoundProfile(_ id: String) {
        if id == HostStore.allProfilesId {
            enableAllBoundProfiles()
            return
        }
        enabledBoundProfileIds.insert(id)
        selectedBoundProfileId = id
        HostStore.selectedBoundProfileId = id
        persistEnabledProfiles()
        if let host = selectedHost {
            socket.connect(host: host)
        }
        Task { await refreshSessions() }
    }

    /// Whether a session belongs under the currently enabled profile chips.
    /// All chips ON ⇒ everything. Subset ⇒ exact `profileId` match against any
    /// enabled profile. When several profiles share a backend (Personal + FullScore),
    /// only exact `profileId` matches count — never "any Claude under any Claude chip".
    func sessionMatchesSelectedProfile(_ s: SessionSummary) -> Bool {
        if showsAllProfiles { return true }
        let enabled = enabledBoundProfiles
        guard !enabled.isEmpty else { return false }

        if let sp = s.profileId, !sp.isEmpty {
            if enabled.contains(where: { $0.profile.id == sp }) { return true }
            // Legacy hunter chip: those sessions belong under NightMoose now.
            if sp == "nightmoose-bot" {
                return enabled.contains { $0.profile.id == "nightmoose" }
            }
            return false
        }

        // Untagged session: only attach if exactly one enabled profile owns that backend
        let backend = s.backend ?? Self.inferredBackend(from: s.model)
        let sameBackend = enabled.filter { $0.profile.backend == backend }
        if sameBackend.count == 1 {
            return true
        }
        return false
    }

    /// After profiles load: prune dead ids, migrate empty → all-on.
    private func normalizeEnabledProfiles() {
        let allIds = Set(visibleBoundProfiles.map(\.id))
        if allIds.isEmpty {
            enabledBoundProfileIds = []
            persistEnabledProfiles()
            return
        }
        if enabledBoundProfileIds.isEmpty {
            // First launch / legacy All / no saved multi-select
            enabledBoundProfileIds = allIds
        } else {
            enabledBoundProfileIds = enabledBoundProfileIds.intersection(allIds)
            if enabledBoundProfileIds.isEmpty {
                enabledBoundProfileIds = allIds
            }
        }
        // Drop legacy All sentinel / hidden bot chip from focus id
        if selectedBoundProfileId == HostStore.allProfilesId
            || selectedBoundProfileId == "nightmoose-bot"
            || selectedBoundProfileId == nil
            || !allIds.contains(selectedBoundProfileId ?? "") {
            selectedBoundProfileId = enabledBoundProfileIds.first ?? visibleBoundProfiles.first?.id
            HostStore.selectedBoundProfileId = selectedBoundProfileId
        }
        persistEnabledProfiles()
    }

    /// Best-effort backend guess for legacy sessions missing `backend`.
    private static func inferredBackend(from model: String) -> String {
        let m = model.lowercased()
        if m.contains("claude") { return "claude" }
        if m.contains("gemini") || m.contains("antigravity") || m == "agy" { return "antigravity" }
        return "grok"
    }

    /// Re-fetch profile usage only (Claude 5h/weekly). Safe to call on a timer.
    func refreshProfileUsage() async {
        guard !hosts.isEmpty else { return }
        var next = boundProfiles
        var changed = false
        for host in hosts {
            guard !host.loadToken().isEmpty else { continue }
            do {
                let p = try await api.profiles(host: host, includeUsage: true)
                for prof in p.profiles {
                    if let idx = next.firstIndex(where: {
                        $0.host.endpointKey == host.endpointKey && $0.profile.id == prof.id
                    }) {
                        if next[idx].profile.usage != prof.usage {
                            next[idx].profile.usage = prof.usage
                            changed = true
                        }
                    }
                }
            } catch {
                // Soft-fail — keep last known usage
            }
        }
        if changed { boundProfiles = next }
    }

    /// Guards concurrent / cancelled refreshes so a cancelled pull-to-refresh
    /// cannot wipe `boundProfiles` after a newer refresh already succeeded.
    private var refreshSessionsGeneration: UInt = 0

    /// Home-screen / Dock count: sessions awaiting approval or a question.
    @discardableResult
    private func syncAppIconBadge(including sessionId: String? = nil) -> Int {
        var ids = Set(attentionSessions.map(\.id))
        if let sessionId { ids.insert(sessionId) }
        let count = ids.count
        NotificationService.setAppIconBadge(count)
        return count
    }

    private func scheduleSessionRefresh() {
        sessionRefreshTask?.cancel()
        sessionRefreshTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 800_000_000)
            guard !Task.isCancelled else { return }
            await self?.refreshSessions()
        }
    }

    /// Refresh profiles from all hosts; sessions for the selected host.
    func refreshSessions() async {
        defer {
            syncAppIconBadge()
            #if os(iOS)
            registerPushIfNeeded()
            #endif
        }
        refreshSessionsGeneration &+= 1
        let generation = refreshSessionsGeneration

        // Collapse any ghost duplicate host rows (same machine added twice).
        let cleaned = HostStore.dedupeHosts(hosts)
        if cleaned.map(\.id) != hosts.map(\.id) {
            HostStore.saveHosts(cleaned)
            hosts = cleaned
        }

        guard !hosts.isEmpty else {
            lastRefreshError = "Add a host in Settings"
            sessions = []
            archivedSessions = []
            boundProfiles = []
            hostAPIReachable = false
            updateConnectionLabel()
            return
        }

        // Prefer loopback host when present (this machine is the gateway)
        let orderedHosts: [HostEndpoint] = {
            let local = hosts.filter(\.isLoopback)
            let remote = hosts.filter { !$0.isLoopback }
            return local + remote
        }()

        var merged: [BoundProfile] = []
        var errors: [String] = []
        var firstWorkingHost: HostEndpoint?
        var seenEndpoints = Set<String>()
        var seenProfileKeys = Set<String>() // endpointKey|profileId
        var sawCancel = false

        for host in orderedHosts {
            let token = host.loadToken()
            if token.isEmpty {
                errors.append("\(host.name): no token")
                continue
            }
            // Skip second entry for the same machine even if IDs differ.
            if seenEndpoints.contains(host.endpointKey) { continue }
            do {
                // Fast profile list first (no Anthropic OAuth). Usage attached right after.
                let p = try await api.profiles(host: host, includeUsage: false)
                if generation != refreshSessionsGeneration { return }
                seenEndpoints.insert(host.endpointKey)
                for prof in p.profiles {
                    let key = "\(host.endpointKey)|\(prof.id)"
                    guard !seenProfileKeys.contains(key) else { continue }
                    seenProfileKeys.insert(key)
                    merged.append(BoundProfile(host: host, profile: prof))
                }
                if firstWorkingHost == nil { firstWorkingHost = host }
            } catch {
                // Ignore cancellation noise from SwiftUI task teardown / overlapping refresh
                let msg = error.localizedDescription
                if msg.lowercased().contains("cancel") {
                    sawCancel = true
                    continue
                }
                errors.append("\(host.name): \(msg)")
            }
        }

        if generation != refreshSessionsGeneration { return }

        // Never replace a good chip strip with [] because requests cancelled mid-refresh
        // (classic bug: pull on chips → refreshable → empty "No hosts / profiles").
        if !merged.isEmpty {
            boundProfiles = merged.sorted { a, b in
                if a.profile.isGrok != b.profile.isGrok { return a.profile.isGrok && !b.profile.isGrok }
                return a.displayName.localizedCaseInsensitiveCompare(b.displayName) == .orderedAscending
            }
            await refreshProfileUsage()
            if generation != refreshSessionsGeneration { return }
            normalizeEnabledProfiles()
        } else if boundProfiles.isEmpty {
            // Truly nothing — only when we had nothing to keep
            normalizeEnabledProfiles()
            if !sawCancel {
                lastRefreshError = errors.first ?? "No profiles from host"
            }
        }
        // else: keep existing boundProfiles

        // Session host: selected profile's host, else first working, else first configured
        let host = selectedHost ?? firstWorkingHost ?? orderedHosts.first
        guard let host else {
            if !sawCancel {
                lastRefreshError = errors.first ?? "No host"
                hostAPIReachable = false
                updateConnectionLabel()
            }
            return
        }

        do {
            let response = try await api.sessions(host: host)
            if generation != refreshSessionsGeneration { return }
            sessions = Self.dedupeSessions(response.sessions)
            archivedSessions = Self.dedupeSessions(response.archivedSessions ?? [])
            diskSessions = response.diskSessions ?? []
            claudeSessions = response.claudeSessions ?? []
            agySessions = response.agySessions ?? []
            hostAPIReachable = true
            lastRefreshError = errors.isEmpty ? nil : errors.joined(separator: " · ")
            socket.connect(host: host)
            updateConnectionLabel()
        } catch {
            if generation != refreshSessionsGeneration { return }
            let msg = error.localizedDescription
            if !msg.lowercased().contains("cancel") {
                lastRefreshError = msg
                hostAPIReachable = false
                updateConnectionLabel()
            }
        }
    }

    /// Collapse accidental double-imports (same Grok/Claude session under two Dispatch ids).
    private static func dedupeSessions(_ items: [SessionSummary]) -> [SessionSummary] {
        var seenIds = Set<String>()
        var seenGrok = Set<String>()
        var seenClaude = Set<String>()
        var seenAgy = Set<String>()
        var out: [SessionSummary] = []
        // Newest first so we keep the freshest wrapper
        let sorted = items.sorted {
            ($0.updatedAt) > ($1.updatedAt)
        }
        for s in sorted {
            if seenIds.contains(s.id) { continue }
            if let g = s.grokSessionId, !g.isEmpty {
                if seenGrok.contains(g) { continue }
                seenGrok.insert(g)
            }
            if let c = s.claudeSessionId, !c.isEmpty {
                if seenClaude.contains(c) { continue }
                seenClaude.insert(c)
            }
            if let a = s.antigravityConversationId, !a.isEmpty {
                if seenAgy.contains(a) { continue }
                seenAgy.insert(a)
            }
            seenIds.insert(s.id)
            out.append(s)
        }
        return out
    }

    private func handleSocketData(_ data: Data) {
        guard
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let event = obj["event"] as? [String: Any],
            let type = event["type"] as? String
        else { return }

        switch type {
        case "session.created", "session.updated", "session.completed", "session.failed",
             "approval.needed", "approval.resolved", "question.needed", "question.answered":
            scheduleSessionRefresh()
            let sessionId = event["sessionId"] as? String
            let payload = event["payload"] as? [String: Any]
            let hostId = selectedHost?.id.uuidString
            let sessionTitle: String = {
                if let sid = sessionId,
                   let s = (sessions + archivedSessions).first(where: { $0.id == sid }) {
                    return s.title
                }
                return "Session"
            }()

            if type == "approval.needed",
               let sid = sessionId,
               let hostId,
               let approvalId = payload?["id"] as? String {
                let approvalTitle = (payload?["title"] as? String) ?? "Approval required"
                let badge = syncAppIconBadge(including: sid)
                NotificationService.notifyApproval(
                    sessionId: sid,
                    hostId: hostId,
                    approvalId: approvalId,
                    sessionTitle: sessionTitle,
                    approvalTitle: approvalTitle,
                    badge: badge
                )
            }
            if type == "question.needed",
               let sid = sessionId,
               let hostId {
                let qTitle = (payload?["title"] as? String) ?? "Answers needed"
                let badge = syncAppIconBadge(including: sid)
                NotificationService.notifyQuestion(
                    sessionId: sid,
                    hostId: hostId,
                    sessionTitle: sessionTitle,
                    questionTitle: qTitle,
                    badge: badge
                )
            }
            if type == "session.updated" || type == "session.completed" {
                if let status = payload?["status"] as? String,
                   status == "idle" || status == "completed" {
                    NotificationService.notify(
                        title: "\(sessionTitle) is waiting on you",
                        body: "Reply in the session, or open diffs/approvals."
                    )
                }
            }
        default:
            break
        }

        NotificationCenter.default.post(name: .dispatchSocketEvent, object: data)
    }
}

extension Notification.Name {
    static let dispatchSocketEvent = Notification.Name("dispatchSocketEvent")
    static let dispatchSocketReconnected = Notification.Name("dispatchSocketReconnected")
    /// Posted by AppDelegate when the user taps an Approve/Reject action on a
    /// notification. Object is `[String: Any]` with `action` and `userInfo`.
    static let dispatchNotificationAction = Notification.Name("dispatchNotificationAction")
    /// Hex APNs device token from AppDelegate. Object is `String`.
    static let dispatchDeviceToken = Notification.Name("dispatchDeviceToken")
    static let macShowCompose = Notification.Name("macShowCompose")
    static let macShowNewBot = Notification.Name("macShowNewBot")
    static let macShowHost = Notification.Name("macShowHost")
    static let macShowSettings = Notification.Name("macShowSettings")
}
