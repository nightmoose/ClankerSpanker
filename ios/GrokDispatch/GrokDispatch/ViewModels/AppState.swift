import Foundation
import SwiftUI
import Combine

@MainActor
final class AppState: ObservableObject {
    @Published var selectedTab: AppTab = .sessions
    @Published var isConfigured: Bool = false
    @Published var hostURL: String = ""
    @Published private(set) var connectionLabel: String = "Offline"

    let api = APIClient()
    let socket = WebSocketClient()

    /// Shared session list cache
    @Published var sessions: [SessionSummary] = []
    /// Soft-archived Dispatch chats (still openable / restorable).
    @Published var archivedSessions: [SessionSummary] = []
    @Published var diskSessions: [DiskSessionHint] = []
    @Published var claudeSessions: [DiskSessionHint] = []
    @Published var lastRefreshError: String?

    private var cancellables = Set<AnyCancellable>()

    init() {
        reloadConfigFromKeychain()
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

    func reloadConfigFromKeychain() {
        let url = KeychainHelper.loadString(key: KeychainHelper.Keys.hostURL) ?? ""
        let token = KeychainHelper.loadString(key: KeychainHelper.Keys.hostToken) ?? ""
        hostURL = url
        isConfigured = !url.isEmpty && !token.isEmpty
        if isConfigured {
            socket.connect()
        } else {
            socket.disconnect()
        }
    }

    func saveConfiguration(hostURL: String, hostToken: String, xaiKey: String?) {
        let trimmedURL = hostURL.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        KeychainHelper.save(string: trimmedURL, key: KeychainHelper.Keys.hostURL)
        KeychainHelper.save(string: hostToken.trimmingCharacters(in: .whitespacesAndNewlines), key: KeychainHelper.Keys.hostToken)
        if let xaiKey, !xaiKey.isEmpty {
            KeychainHelper.save(string: xaiKey, key: KeychainHelper.Keys.xaiAPIKey)
        }
        UserDefaults.standard.set(true, forKey: "hasCompletedOnboarding")
        reloadConfigFromKeychain()
    }

    func clearConfiguration() {
        KeychainHelper.delete(key: KeychainHelper.Keys.hostURL)
        KeychainHelper.delete(key: KeychainHelper.Keys.hostToken)
        KeychainHelper.delete(key: KeychainHelper.Keys.xaiAPIKey)
        UserDefaults.standard.removeObject(forKey: "hasCompletedOnboarding")
        sessions = []
        archivedSessions = []
        reloadConfigFromKeychain()
    }

    /// `clankerspanker://configure?url=...&token=...` (also accepts legacy grokdispatch://)
    func handleDeepLink(_ url: URL) {
        guard url.scheme == "clankerspanker" || url.scheme == "grokdispatch" else { return }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let host = items.first(where: { $0.name == "url" })?.value
        let token = items.first(where: { $0.name == "token" })?.value
        guard let host, let token, !host.isEmpty, !token.isEmpty else { return }
        saveConfiguration(hostURL: host, hostToken: token, xaiKey: nil)
        Task {
            try? await api.validate()
            await refreshSessions()
        }
    }

    func refreshSessions() async {
        do {
            let response = try await api.sessions()
            sessions = response.sessions
            archivedSessions = response.archivedSessions ?? []
            diskSessions = response.diskSessions ?? []
            claudeSessions = response.claudeSessions ?? []
            lastRefreshError = nil
        } catch {
            lastRefreshError = error.localizedDescription
        }
    }

    private func handleSocketData(_ data: Data) {
        // Lightweight: refresh list on terminal events; detail VMs can also listen
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
                    body: "A Grok Dispatch task is waiting for your decision."
                )
            }
            if type == "question.needed" {
                NotificationService.notify(
                    title: "Grok has questions",
                    body: "Open the session to answer and unstick the task."
                )
            }
            // Only notify when a turn actually finished (payload status idle/completed)
            if type == "session.updated" || type == "session.completed" {
                if let payload = event["payload"] as? [String: Any],
                   let status = payload["status"] as? String,
                   status == "idle" || status == "completed" {
                    NotificationService.notify(
                        title: "Grok is waiting on you",
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
