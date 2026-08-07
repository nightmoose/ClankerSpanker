import Foundation
import SwiftUI
import Combine

@MainActor
final class AppState: ObservableObject {
    @Published var selectedTab: AppTab = .sessions
    @Published var isConfigured: Bool = false
    @Published private(set) var connectionLabel: String = "Offline"

    let api = APIClient()
    let socket = WebSocketClient()

    /// Registered host machines.
    @Published var hosts: [HostEndpoint] = []
    /// Profiles from all hosts (colored nav chips).
    @Published var boundProfiles: [BoundProfile] = []
    @Published var selectedBoundProfileId: String?

    /// macOS command center: session selected in the middle list (inline detail).
    @Published var macSelectedSessionId: String?

    /// Sessions for the currently selected host (filtered by profile in the dashboard).
    @Published var sessions: [SessionSummary] = []
    @Published var archivedSessions: [SessionSummary] = []
    @Published var diskSessions: [DiskSessionHint] = []
    @Published var claudeSessions: [DiskSessionHint] = []
    @Published var lastRefreshError: String?

    private var cancellables = Set<AnyCancellable>()

    init() {
        reloadHosts()
        socket.$isConnected
            .receive(on: RunLoop.main)
            .sink { [weak self] connected in
                self?.connectionLabel = connected ? "Live" : "Offline"
            }
            .store(in: &cancellables)

        socket.onEvent = { [weak self] data in
            self?.handleSocketData(data)
        }
    }

    #if os(macOS)
    /// Bricklayer-style: on the machine that owns the gateway, wire ourselves up automatically.
    /// Reads `~/.grok-dispatch/config.json`, starts host if needed, registers localhost + token.
    func ensureLocalHostOnMac() async throws {
        let hostCtrl = LocalHostController.shared
        await hostCtrl.refreshStatus()

        if !hostCtrl.apiReachable {
            // Start local gateway (no-op if already running externally but unreachable path)
            if !hostCtrl.isRunning {
                hostCtrl.start()
            }
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
                            "Local host not reachable at \(hostCtrl.localBaseURL). Build host (`cd host && npm run build`) and set package path under Host.",
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

    var selectedBoundProfile: BoundProfile? {
        boundProfiles.first { $0.id == selectedBoundProfileId } ?? boundProfiles.first
    }

    var selectedHost: HostEndpoint? {
        selectedBoundProfile?.host ?? hosts.first
    }

    // MARK: - Host registry

    func reloadHosts() {
        hosts = HostStore.loadHosts()
        isConfigured = !hosts.isEmpty && hosts.contains { !$0.loadToken().isEmpty }
        selectedBoundProfileId = HostStore.selectedBoundProfileId
        if isConfigured, let host = selectedHost {
            socket.connect(host: host)
        } else {
            socket.disconnect()
        }
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
        isConfigured = false
        socket.disconnect()
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

    func selectBoundProfile(_ id: String) {
        selectedBoundProfileId = id
        HostStore.selectedBoundProfileId = id
        if let host = selectedHost {
            socket.connect(host: host)
        }
        Task { await refreshSessions() }
    }

    /// Whether a session belongs under the currently selected profile chip.
    /// When several profiles share a backend (e.g. Personal + FullScore Claude), only
    /// exact `profileId` matches count — never "any Claude session under any Claude chip".
    func sessionMatchesSelectedProfile(_ s: SessionSummary) -> Bool {
        guard let bound = selectedBoundProfile else { return true }
        let want = bound.profile.id
        if let sp = s.profileId, !sp.isEmpty {
            return sp == want
        }
        // Untagged session: only attach to a profile if it is the *sole* profile for that backend
        let backend = s.backend
            ?? (s.model.lowercased().contains("claude") ? "claude" : "grok")
        let sameBackend = boundProfiles.filter { $0.profile.backend == backend && $0.host.id == bound.host.id }
        if sameBackend.count == 1, sameBackend[0].profile.id == want {
            return backend == bound.profile.backend
        }
        return false
    }

    /// Refresh profiles from all hosts; sessions for the selected host.
    func refreshSessions() async {
        guard !hosts.isEmpty else {
            lastRefreshError = "Add a host in Settings"
            sessions = []
            archivedSessions = []
            boundProfiles = []
            return
        }

        // Prefer loopback host when present (this machine is the gateway)
        let orderedHosts: [HostEndpoint] = {
            let local = hosts.filter { h in
                guard let u = URL(string: h.baseURL), let host = u.host?.lowercased() else { return false }
                return host == "127.0.0.1" || host == "localhost" || host == "::1"
            }
            let remote = hosts.filter { h in !local.contains(where: { $0.id == h.id }) }
            return local + remote
        }()

        var merged: [BoundProfile] = []
        var errors: [String] = []
        var firstWorkingHost: HostEndpoint?

        for host in orderedHosts {
            let token = host.loadToken()
            if token.isEmpty {
                errors.append("\(host.name): no token")
                continue
            }
            do {
                let p = try await api.profiles(host: host)
                for prof in p.profiles {
                    merged.append(BoundProfile(host: host, profile: prof))
                }
                if firstWorkingHost == nil { firstWorkingHost = host }
            } catch {
                // Ignore cancellation noise from SwiftUI task teardown
                let msg = error.localizedDescription
                if msg.lowercased().contains("cancel") { continue }
                errors.append("\(host.name): \(msg)")
            }
        }

        boundProfiles = merged.sorted {
            $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending
        }

        if selectedBoundProfileId == nil || !boundProfiles.contains(where: { $0.id == selectedBoundProfileId }) {
            selectedBoundProfileId = boundProfiles.first?.id
            HostStore.selectedBoundProfileId = selectedBoundProfileId
        }

        // Session host: selected profile's host, else first working, else first configured
        let host = selectedHost ?? firstWorkingHost ?? orderedHosts.first
        guard let host else {
            lastRefreshError = errors.first ?? "No host"
            return
        }

        do {
            let response = try await api.sessions(host: host)
            sessions = response.sessions
            archivedSessions = response.archivedSessions ?? []
            diskSessions = response.diskSessions ?? []
            claudeSessions = response.claudeSessions ?? []
            lastRefreshError = errors.isEmpty ? nil : errors.joined(separator: " · ")
            socket.connect(host: host)
        } catch {
            let msg = error.localizedDescription
            if !msg.lowercased().contains("cancel") {
                lastRefreshError = msg
            }
        }
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
            Task { await refreshSessions() }
            if type == "approval.needed" {
                NotificationService.notify(
                    title: "Approval needed",
                    body: "A task is waiting for your decision."
                )
            }
            if type == "question.needed" {
                NotificationService.notify(
                    title: "Agent has questions",
                    body: "Open the session to answer and unstick the task."
                )
            }
            if type == "session.updated" || type == "session.completed" {
                if let payload = event["payload"] as? [String: Any],
                   let status = payload["status"] as? String,
                   status == "idle" || status == "completed" {
                    NotificationService.notify(
                        title: "Agent is waiting on you",
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
    static let macShowCompose = Notification.Name("macShowCompose")
    static let macShowHost = Notification.Name("macShowHost")
    static let macShowSettings = Notification.Name("macShowSettings")
}
