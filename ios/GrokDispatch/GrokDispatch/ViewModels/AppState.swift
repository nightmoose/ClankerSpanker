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
    /// One WS connection per registered host (RFC-024). Replaces the single
    /// `WebSocketClient` that was bound to `selectedHost` and hid all events
    /// from every other host until the user switched.
    let socketPool = HostSocketPool()

    /// Mirror of `socketPool.anyConnected` so SwiftUI views bound to
    /// `@EnvironmentObject appState: AppState` re-render when the merged
    /// connection state flips. (Views can't observe nested ObservableObjects
    /// through the parent's objectWillChange.)
    @Published private(set) var isSocketLive: Bool = false

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
    /// Set of `hostId|token` pairs already registered with the host. Set
    /// (not single string) because RFC-024 fans out APNs registration to
    /// every host so pushes fire from whichever host owns the session.
    private var lastPushRegistrations: Set<String> = []
    #endif

    init() {
        socketPool.onEvent = { [weak self] hostId, data in
            self?.handleSocketData(data, hostId: hostId)
        }
        socketPool.onReconnect = { hostId in
            // Include hostId in userInfo so per-host replay logic can filter;
            // legacy consumers that ignore userInfo still trigger their
            // existing "reconnect happened" behavior.
            NotificationCenter.default.post(
                name: .dispatchSocketReconnected,
                object: hostId.uuidString
            )
        }
        socketPool.$connected
            .receive(on: RunLoop.main)
            .sink { [weak self] connectedMap in
                guard let self else { return }
                self.isSocketLive = connectedMap.values.contains(where: { $0 })
                self.updateConnectionLabel()
            }
            .store(in: &cancellables)

        reloadHosts()

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
    /// Upload the APNs device token to **every** configured host so kill-state
    /// pushes can fire from any host that owns a session (RFC-024). Before
    /// RFC-024 only `selectedHost` was told, so secondary hosts' approvals
    /// never woke the phone from a killed state.
    private func registerPushIfNeeded() {
        guard let token = pendingDeviceToken else { return }
        let name = UIDevice.current.name
        for host in hosts {
            guard !host.loadToken().isEmpty else { continue }
            let key = "\(host.id.uuidString)|\(token)"
            if lastPushRegistrations.contains(key) { continue }
            lastPushRegistrations.insert(key)
            Task { [api, weak self] in
                do {
                    try await api.registerPush(
                        token: token,
                        clientHostId: host.id.uuidString,
                        name: name,
                        host: host
                    )
                } catch {
                    // Roll back the "already registered" marker so the next
                    // refresh retries this host without touching the others.
                    await MainActor.run {
                        self?.lastPushRegistrations.remove(key)
                    }
                }
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
        // RFC-024: notification action routes strictly by the embedded hostId.
        // The old `selectedHost` fallback silently sent Approve to the wrong
        // host when a user tapped a notification for host B while chips were
        // on host A. If the notification is legacy (no hostId), we still
        // best-effort fall back so old queued taps don't dead-end.
        let host: HostEndpoint? = {
            if let hostIdString = info["hostId"] as? String {
                guard
                    let hostId = UUID(uuidString: hostIdString),
                    let match = hosts.first(where: { $0.id == hostId })
                else {
                    NotificationService.notify(
                        title: "Notification stale",
                        body: "That host is no longer registered."
                    )
                    return nil
                }
                return match
            }
            return selectedHost ?? hosts.first
        }()
        guard let host else { return }

        // RFC-035: a plain tap on the banner opens that session on its own host
        // (it used to only refresh, leaving you wherever you were).
        if action == "com.apple.UNNotificationDefaultActionIdentifier" {
            selectedTab = .sessions
            notificationRoute = SessionRoute(hostId: host.id, sessionId: sessionId)
        }

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
        if isSocketLive {
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
        // Reuse existing localhost host if present; otherwise create.
        // RFC-024: never overwrite a user's remote-host selection on Mac
        // startup — before, this seeded "This Mac" and forced the socket
        // onto loopback every launch, wiping any remote selection.
        if let existing = hosts.first(where: { isLoopbackURL($0.baseURL) }) {
            var h = existing
            h.baseURL = url
            if h.name.isEmpty || h.name == "Primary" { h.name = "This Mac" }
            upsertHost(h, token: token)
        } else if hosts.isEmpty {
            let h = HostEndpoint(name: "This Mac", baseURL: url)
            upsertHost(h, token: token)
        }
        // Socket wiring is handled by the pool via `saveHosts` → `syncSocketPool()`.
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
    /// RFC-024: dedupe by `(hostId, id)` so two hosts holding the same
    /// imported session id both surface if they both need attention.
    var attentionSessions: [SessionSummary] {
        let all = sessions + archivedSessions
        var seen = Set<String>()
        var out: [SessionSummary] = []
        for s in all {
            let key = s.routeKey
            guard !seen.contains(key) else { continue }
            if s.status == .awaitingApproval || s.status == .awaitingQuestion {
                seen.insert(key)
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
        syncSocketPool()
    }

    /// Reconcile the WS pool with the current host list (RFC-024). Called on
    /// every mutation of `hosts` (add, remove, token change, clear).
    private func syncSocketPool() {
        if isConfigured {
            socketPool.sync(with: hosts)
        } else {
            socketPool.disconnectAll()
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
        syncSocketPool()
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
        syncSocketPool()
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

    /// A `clankerspanker://configure` link waiting for the user to confirm
    /// (RFC-026). Links can arrive from anywhere — a message, a web page — so
    /// they never add or change a host silently.
    struct PendingHostLink: Identifiable, Equatable {
        let id = UUID()
        let baseURL: String
        let token: String
        let name: String
        /// Set when a host with the same address already exists: the link
        /// updates that host's token instead of adding a duplicate.
        let existingHostId: UUID?
        let existingName: String?
    }

    @Published var pendingHostLink: PendingHostLink?

    /// Session to open because a notification was tapped (RFC-035). The
    /// sessions list consumes it and clears it.
    @Published var notificationRoute: SessionRoute?

    func handleDeepLink(_ url: URL) {
        guard url.scheme == "clankerspanker" || url.scheme == "grokdispatch" else { return }
        // First run: OnboardingView owns the link (it fills the form the user
        // is already looking at).
        guard isConfigured else { return }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let hostURL = items.first(where: { $0.name == "url" })?.value
        let token = items.first(where: { $0.name == "token" })?.value
        let rawName = items.first(where: { $0.name == "name" })?.value ?? ""
        guard let hostURL, let token, !hostURL.isEmpty, !token.isEmpty else { return }
        let candidate = HostEndpoint(name: rawName, baseURL: hostURL)
        let existing = Self.existingHost(matching: candidate, in: hosts)
        pendingHostLink = PendingHostLink(
            baseURL: candidate.baseURL,
            token: token,
            name: rawName.isEmpty ? (URL(string: candidate.baseURL)?.host ?? "Host") : rawName,
            existingHostId: existing?.id,
            existingName: existing?.name
        )
    }

    /// A configure link updates the host saved at the same address instead of
    /// adding a duplicate (RFC-026). Pure, tested.
    nonisolated static func existingHost(matching candidate: HostEndpoint, in hosts: [HostEndpoint]) -> HostEndpoint? {
        hosts.first(where: { $0.endpointKey == candidate.endpointKey })
    }

    func confirmPendingHostLink() {
        guard let link = pendingHostLink else { return }
        pendingHostLink = nil
        let host: HostEndpoint
        if let id = link.existingHostId, var existing = hosts.first(where: { $0.id == id }) {
            existing.baseURL = link.baseURL
            if existing.name.isEmpty || existing.name == "Primary" { existing.name = link.name }
            host = existing
        } else {
            host = HostEndpoint(name: link.name, baseURL: link.baseURL)
        }
        upsertHost(host, token: link.token)
        Task {
            try? await api.validate(host: host)
            await refreshSessions()
        }
    }

    func cancelPendingHostLink() {
        pendingHostLink = nil
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
        // Chip toggles change `selectedHost` but not the host list — the
        // pool is already connected to every host; refresh session data.
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
        // Chip toggles change `selectedHost` but not the host list — the
        // pool is already connected to every host; refresh session data.
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
        // Chip toggles change `selectedHost` but not the host list — the
        // pool is already connected to every host; refresh session data.
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

    /// Re-fetch profile usage only (Claude 5h/weekly) from every host in
    /// parallel with a per-host timeout, so one wedged secondary doesn't
    /// stall the 60s poll for the healthy hosts (RFC-024).
    func refreshProfileUsage() async {
        guard !hosts.isEmpty else { return }
        let hostList = hosts.filter { !$0.loadToken().isEmpty }
        guard !hostList.isEmpty else { return }

        struct Bundle: Sendable { let endpointKey: String; let profiles: [AgentProfile] }
        let api = self.api
        let bundles: [Bundle] = await withTaskGroup(of: Bundle?.self) { group in
            for host in hostList {
                group.addTask {
                    // Per-host timeout: 4s. Longer than a healthy round-trip,
                    // short enough that N hosts * 4s stays below the 60s poll.
                    return await withTaskGroup(of: Bundle?.self) { inner in
                        inner.addTask {
                            do {
                                let p = try await api.profiles(host: host, includeUsage: true)
                                return Bundle(endpointKey: host.endpointKey, profiles: p.profiles)
                            } catch {
                                return nil
                            }
                        }
                        inner.addTask {
                            try? await Task.sleep(nanoseconds: 4_000_000_000)
                            return nil
                        }
                        let first = await inner.next() ?? nil
                        inner.cancelAll()
                        return first
                    }
                }
            }
            var out: [Bundle] = []
            for await b in group {
                if let b { out.append(b) }
            }
            return out
        }

        var next = boundProfiles
        var changed = false
        for b in bundles {
            for prof in b.profiles {
                if let idx = next.firstIndex(where: {
                    $0.host.endpointKey == b.endpointKey && $0.profile.id == prof.id
                }) {
                    if next[idx].profile.usage != prof.usage {
                        next[idx].profile.usage = prof.usage
                        changed = true
                    }
                }
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

    /// When the currently debounced refresh was first requested (RFC-038).
    private var sessionRefreshPendingSince: Date?

    /// Debounced full refresh. RFC-038: a busy session emits events faster
    /// than 800 ms, which kept restarting the debounce so the list never
    /// refreshed until things went quiet. Cap the wait at 3 s.
    private func scheduleSessionRefresh() {
        let now = Date()
        if let since = sessionRefreshPendingSince, now.timeIntervalSince(since) >= 3, sessionRefreshTask != nil {
            return // a refresh is already due; let it fire
        }
        if sessionRefreshPendingSince == nil { sessionRefreshPendingSince = now }
        sessionRefreshTask?.cancel()
        sessionRefreshTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 800_000_000)
            guard !Task.isCancelled else { return }
            self?.sessionRefreshPendingSince = nil
            self?.sessionRefreshTask = nil
            await self?.refreshSessions()
        }
    }

    /// RFC-038: apply the status an event implies to the list row right away,
    /// so the sidebar agrees with the session header without waiting for a
    /// refetch. The debounced refresh still reconciles everything else.
    /// Status a socket event implies for its session row (RFC-038). Pure, tested.
    nonisolated static func liveStatus(forEvent type: String, payload: [String: Any]?) -> SessionStatus? {
        switch type {
        case "approval.needed": return .awaitingApproval
        case "question.needed": return .awaitingQuestion
        case "approval.resolved", "question.answered": return .running
        default:
            guard let raw = payload?["status"] as? String else { return nil }
            return SessionStatus(rawValue: raw)
        }
    }

    private func applyLiveStatus(type: String, payload: [String: Any]?, sessionId: String, hostId: String) {
        guard let status = Self.liveStatus(forEvent: type, payload: payload) else { return }
        func patch(_ list: inout [SessionSummary]) {
            for i in list.indices where list[i].id == sessionId && (list[i].hostId == hostId || list[i].hostId == nil) {
                if list[i].status != status { list[i].status = status }
            }
        }
        patch(&sessions)
        patch(&archivedSessions)
    }

    /// Refresh profiles + sessions from **every** configured host (RFC-024).
    /// Before RFC-024 sessions came from `selectedHost` only, so a second
    /// host's chats never appeared on the phone.
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
            syncSocketPool()
        }

        guard !hosts.isEmpty else {
            lastRefreshError = "Add a host in Settings"
            sessions = []
            archivedSessions = []
            diskSessions = []
            claudeSessions = []
            agySessions = []
            boundProfiles = []
            hostAPIReachable = false
            updateConnectionLabel()
            return
        }

        // Prefer loopback host first (this machine is the gateway).
        let orderedHosts: [HostEndpoint] = {
            let local = hosts.filter(\.isLoopback)
            let remote = hosts.filter { !$0.isLoopback }
            return local + remote
        }()

        var merged: [BoundProfile] = []
        var errors: [String] = []
        var errorsByHost: [String: String] = [:]
        var seenEndpoints = Set<String>()
        var seenProfileKeys = Set<String>() // endpointKey|profileId
        var sawCancel = false
        // Hosts that answered /profiles successfully — we'll fan out /sessions to these.
        var workingHosts: [HostEndpoint] = []

        for host in orderedHosts {
            let token = host.loadToken()
            if token.isEmpty {
                errors.append("\(host.name): no token")
                errorsByHost[host.name] = "no token"
                continue
            }
            if seenEndpoints.contains(host.endpointKey) { continue }
            do {
                let p = try await api.profiles(host: host, includeUsage: false)
                if generation != refreshSessionsGeneration { return }
                seenEndpoints.insert(host.endpointKey)
                for prof in p.profiles {
                    let key = "\(host.endpointKey)|\(prof.id)"
                    guard !seenProfileKeys.contains(key) else { continue }
                    seenProfileKeys.insert(key)
                    merged.append(BoundProfile(host: host, profile: prof))
                }
                workingHosts.append(host)
            } catch {
                let msg = error.localizedDescription
                if msg.lowercased().contains("cancel") {
                    sawCancel = true
                    continue
                }
                errors.append("\(host.name): \(msg)")
                errorsByHost[host.name] = msg
            }
        }

        if generation != refreshSessionsGeneration { return }

        if !merged.isEmpty {
            boundProfiles = merged.sorted { a, b in
                if a.profile.isGrok != b.profile.isGrok { return a.profile.isGrok && !b.profile.isGrok }
                return a.displayName.localizedCaseInsensitiveCompare(b.displayName) == .orderedAscending
            }
            await refreshProfileUsage()
            if generation != refreshSessionsGeneration { return }
            normalizeEnabledProfiles()
        } else if boundProfiles.isEmpty {
            normalizeEnabledProfiles()
            if !sawCancel {
                lastRefreshError = errors.first ?? "No profiles from host"
            }
        }

        guard !workingHosts.isEmpty else {
            if !sawCancel {
                lastRefreshError = errors.first ?? "No reachable host"
                hostAPIReachable = false
                updateConnectionLabel()
            }
            return
        }

        // Fan out /sessions to every working host in parallel. Stamp `hostId`
        // on each returned SessionSummary so downstream code can route
        // actions to the owning host without falling back to `selectedHost`.
        let hostList = workingHosts
        struct Bundle: Sendable {
            let hostId: String
            let hostName: String
            let sessions: [SessionSummary]
            let archived: [SessionSummary]
            let disk: [DiskSessionHint]
            let claude: [DiskSessionHint]
            let agy: [DiskSessionHint]
            let error: String?
        }
        let bundles: [Bundle] = await withTaskGroup(of: Bundle.self) { group in
            for host in hostList {
                group.addTask { [api] in
                    do {
                        let response = try await api.sessions(host: host)
                        let hid = host.id.uuidString
                        func stamp(_ s: SessionSummary) -> SessionSummary {
                            var next = s
                            next.hostId = hid
                            return next
                        }
                        return Bundle(
                            hostId: hid,
                            hostName: host.name,
                            sessions: response.sessions.map(stamp),
                            archived: (response.archivedSessions ?? []).map(stamp),
                            disk: response.diskSessions ?? [],
                            claude: response.claudeSessions ?? [],
                            agy: response.agySessions ?? [],
                            error: nil
                        )
                    } catch {
                        let msg = error.localizedDescription
                        return Bundle(
                            hostId: host.id.uuidString,
                            hostName: host.name,
                            sessions: [],
                            archived: [],
                            disk: [],
                            claude: [],
                            agy: [],
                            error: msg.lowercased().contains("cancel") ? nil : msg
                        )
                    }
                }
            }
            var out: [Bundle] = []
            for await b in group { out.append(b) }
            return out
        }

        if generation != refreshSessionsGeneration { return }

        var allSessions: [SessionSummary] = []
        var allArchived: [SessionSummary] = []
        var allDisk: [DiskSessionHint] = []
        var allClaude: [DiskSessionHint] = []
        var allAgy: [DiskSessionHint] = []
        for b in bundles {
            allSessions.append(contentsOf: b.sessions)
            allArchived.append(contentsOf: b.archived)
            allDisk.append(contentsOf: b.disk)
            allClaude.append(contentsOf: b.claude)
            allAgy.append(contentsOf: b.agy)
            if let e = b.error { errorsByHost[b.hostName] = e }
        }

        sessions = Self.dedupeSessions(allSessions)
        archivedSessions = Self.dedupeSessions(allArchived)
        diskSessions = allDisk
        claudeSessions = allClaude
        agySessions = allAgy
        hostAPIReachable = true

        // Surface per-host errors as "N hosts unreachable" (better than
        // errors.first, which used to hide dead secondaries behind a healthy
        // primary or vice-versa).
        if errorsByHost.isEmpty {
            lastRefreshError = nil
        } else if errorsByHost.count == 1, let (name, msg) = errorsByHost.first {
            lastRefreshError = "\(name): \(msg)"
        } else {
            let names = errorsByHost.keys.sorted().joined(separator: ", ")
            lastRefreshError = "\(errorsByHost.count) hosts unreachable (\(names))"
        }
        updateConnectionLabel()
    }

    /// Collapse accidental double-imports **within one host** (same Grok /
    /// Claude session imported twice as different Dispatch ids). Post
    /// RFC-024, we now merge sessions across hosts, so the dedupe key is
    /// `(hostId, id)` — two hosts holding the same imported session are
    /// legitimately two rows.
    private static func dedupeSessions(_ items: [SessionSummary]) -> [SessionSummary] {
        var seenRoute = Set<String>()
        // Per-host grok/claude/agy dedupe so accidental same-host re-imports
        // still collapse; a match across hosts is not a dupe.
        var seenGrokByHost: [String: Set<String>] = [:]
        var seenClaudeByHost: [String: Set<String>] = [:]
        var seenAgyByHost: [String: Set<String>] = [:]
        var out: [SessionSummary] = []
        // Newest first so we keep the freshest wrapper.
        let sorted = items.sorted { $0.updatedAt > $1.updatedAt }
        for s in sorted {
            let hostKey = s.hostId ?? ""
            let route = "\(hostKey).\(s.id)"
            if seenRoute.contains(route) { continue }
            if let g = s.grokSessionId, !g.isEmpty {
                var seen = seenGrokByHost[hostKey] ?? []
                if seen.contains(g) { continue }
                seen.insert(g)
                seenGrokByHost[hostKey] = seen
            }
            if let c = s.claudeSessionId, !c.isEmpty {
                var seen = seenClaudeByHost[hostKey] ?? []
                if seen.contains(c) { continue }
                seen.insert(c)
                seenClaudeByHost[hostKey] = seen
            }
            if let a = s.antigravityConversationId, !a.isEmpty {
                var seen = seenAgyByHost[hostKey] ?? []
                if seen.contains(a) { continue }
                seen.insert(a)
                seenAgyByHost[hostKey] = seen
            }
            seenRoute.insert(route)
            out.append(s)
        }
        return out
    }

    /// Handle a WS event from the pool. `hostId` is the source host's UUID,
    /// carried into `NotificationService.notifyApproval` so the notification
    /// action buttons route back to the correct host — never `selectedHost`
    /// (RFC-024). Same for question banners.
    private func handleSocketData(_ data: Data, hostId: UUID) {
        guard
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let event = obj["event"] as? [String: Any],
            let type = event["type"] as? String
        else { return }

        switch type {
        case "session.created", "session.updated", "session.completed", "session.failed",
             "approval.needed", "approval.resolved", "question.needed", "question.answered":
            let sessionId = event["sessionId"] as? String
            let payload = event["payload"] as? [String: Any]
            let hostIdString = hostId.uuidString
            if let sid = sessionId {
                applyLiveStatus(type: type, payload: payload, sessionId: sid, hostId: hostIdString)
            }
            scheduleSessionRefresh()
            let sessionTitle: String = {
                if let sid = sessionId,
                   let s = (sessions + archivedSessions).first(where: {
                       $0.id == sid && ($0.hostId == hostIdString || $0.hostId == nil)
                   }) {
                    return s.title
                }
                return "Session"
            }()

            if type == "approval.needed",
               let sid = sessionId,
               let approvalId = payload?["id"] as? String {
                let approvalTitle = (payload?["title"] as? String) ?? "Approval required"
                let badge = syncAppIconBadge(including: sid)
                NotificationService.notifyApproval(
                    sessionId: sid,
                    hostId: hostIdString,
                    approvalId: approvalId,
                    sessionTitle: sessionTitle,
                    approvalTitle: approvalTitle,
                    badge: badge
                )
            }
            if type == "question.needed",
               let sid = sessionId {
                let qTitle = (payload?["title"] as? String) ?? "Answers needed"
                let badge = syncAppIconBadge(including: sid)
                NotificationService.notifyQuestion(
                    sessionId: sid,
                    hostId: hostIdString,
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

        // Broadcast to interested views. `object` stays `Data` so pre-RFC-024
        // consumers keep working; `userInfo` carries the source host id for
        // consumers that want to filter (SessionDetailViewModel replay).
        NotificationCenter.default.post(
            name: .dispatchSocketEvent,
            object: data,
            userInfo: ["hostId": hostId.uuidString]
        )
    }

    /// Return the `HostEndpoint` that owns this session. Falls back to
    /// `selectedHost` only when the session has no `hostId` stamp — that
    /// happens for legacy records or during migration windows.
    func endpoint(for session: SessionSummary) -> HostEndpoint? {
        if let raw = session.hostId, let uuid = UUID(uuidString: raw) {
            if let match = hosts.first(where: { $0.id == uuid }) {
                return match
            }
        }
        return selectedHost
    }

    /// Same as `endpoint(for:)` but resolves by session id when the caller
    /// only has an id in hand (Mac session list selection, deep links).
    func endpoint(forSessionId id: String) -> HostEndpoint? {
        if let s = sessions.first(where: { $0.id == id }) ?? archivedSessions.first(where: { $0.id == id }) {
            return endpoint(for: s)
        }
        return selectedHost
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
