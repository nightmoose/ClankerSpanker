import Foundation

@MainActor
final class WebSocketClient: NSObject, ObservableObject {
    @Published private(set) var isConnected = false
    @Published private(set) var lastError: String?

    private var task: URLSessionWebSocketTask?
    private var session: URLSession?
    private var receiveLoopRunning = false
    private var connectedHostId: UUID?
    var onEvent: ((Data) -> Void)?

    func connect(host: HostEndpoint) {
        // Already on this host
        if isConnected, connectedHostId == host.id { return }

        disconnect()
        let token = host.loadToken()
        guard !token.isEmpty, var components = URLComponents(string: host.baseURL) else {
            lastError = "Missing host URL or token"
            return
        }

        components.scheme = (components.scheme == "https") ? "wss" : "ws"
        let basePath = components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        components.path = basePath.isEmpty ? "/ws" : "/\(basePath)/ws"
        // RFC-029: authenticate with a header — the host token never goes in
        // the URL (where it lands in logs). Network peers can no longer use
        // `?token=` at all.
        components.queryItems = nil

        guard let url = components.url else {
            lastError = "Bad WebSocket URL"
            return
        }

        let config = URLSessionConfiguration.ephemeral
        config.waitsForConnectivity = false
        let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        self.session = session
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let task = session.webSocketTask(with: request)
        self.task = task
        connectedHostId = host.id
        // Do NOT mark Live until didOpen — premature Live hid broken REST.
        isConnected = false
        lastError = nil
        receiveLoopRunning = true
        task.resume()
        receiveNext(host: host)
    }

    func disconnect() {
        receiveLoopRunning = false
        connectedHostId = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        session?.invalidateAndCancel()
        session = nil
        isConnected = false
    }

    private func receiveNext(host: HostEndpoint) {
        guard receiveLoopRunning, let task else { return }
        task.receive { [weak self] result in
            Task { @MainActor in
                guard let self else { return }
                switch result {
                case .failure(let error):
                    self.lastError = error.localizedDescription
                    self.isConnected = false
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                    if self.receiveLoopRunning, self.connectedHostId == host.id {
                        self.connect(host: host)
                    }
                case .success(let message):
                    switch message {
                    case .data(let data):
                        self.onEvent?(data)
                    case .string(let text):
                        if let data = text.data(using: .utf8) {
                            self.onEvent?(data)
                        }
                    @unknown default:
                        break
                    }
                    self.receiveNext(host: host)
                }
            }
        }
    }
}

extension WebSocketClient: URLSessionWebSocketDelegate {
    nonisolated func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol protocol: String?
    ) {
        Task { @MainActor in
            self.isConnected = true
            self.lastError = nil
        }
    }

    nonisolated func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?
    ) {
        Task { @MainActor in
            self.isConnected = false
        }
    }
}
