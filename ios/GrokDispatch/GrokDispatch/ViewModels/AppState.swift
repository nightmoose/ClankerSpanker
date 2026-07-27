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

    /// Refresh profiles from all hosts; sessions for the selected host.
    func refreshSessions() async {
        guard !hosts.isEmpty else {
            lastRefreshError = "Add a host in Settings"
            return
        }

        var merged: [BoundProfile] = []
        var errors: [String] = []

        await withTaskGroup(of: (HostEndpoint, Result<ProfilesResponse, Error>).self) { group in
            for host in hosts {
                group.addTask {
                    do {
                        let p = try await self.api.profiles(host: host)
                        return (host, .success(p))
                    } catch {
                        return (host, .failure(error))
                    }
                }
            }
            for await (host, result) in group {
                switch result {
                case .success(let res):
                    for p in res.profiles {
                        merged.append(BoundProfile(host: host, profile: p))
                    }
                case .failure(let err):
                    errors.append("\(host.name): \(err.localizedDescription)")
                }
            }
        }

        boundProfiles = merged.sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }

        if selectedBoundProfileId == nil || !boundProfiles.contains(where: { $0.id == selectedBoundProfileId }) {
            selectedBoundProfileId = boundProfiles.first?.id
            HostStore.selectedBoundProfileId = selectedBoundProfileId
        }

        guard let host = selectedHost else {
            lastRefreshError = errors.first
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
            lastRefreshError = error.localizedDescription
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
}
