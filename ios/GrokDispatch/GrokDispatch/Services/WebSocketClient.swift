import Foundation

@MainActor
final class WebSocketClient: NSObject, ObservableObject {
    @Published private(set) var isConnected = false
    @Published private(set) var lastError: String?

    private var task: URLSessionWebSocketTask?
    private var session: URLSession?
    private var receiveLoopRunning = false
    var onEvent: ((Data) -> Void)?

    func connect() {
        disconnect()
        guard
            let host = KeychainHelper.loadString(key: KeychainHelper.Keys.hostURL),
            let token = KeychainHelper.loadString(key: KeychainHelper.Keys.hostToken),
            var components = URLComponents(string: host)
        else {
            lastError = "Missing host URL or token"
            return
        }

        components.scheme = (components.scheme == "https") ? "wss" : "ws"
        // Ensure path /ws
        let basePath = components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        components.path = basePath.isEmpty ? "/ws" : "/\(basePath)/ws"
        components.queryItems = [URLQueryItem(name: "token", value: token)]

        guard let url = components.url else {
            lastError = "Bad WebSocket URL"
            return
        }

        let config = URLSessionConfiguration.default
        let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        self.session = session
        let task = session.webSocketTask(with: url)
        self.task = task
        task.resume()
        isConnected = true
        lastError = nil
        receiveLoopRunning = true
        receiveNext()
    }

    func disconnect() {
        receiveLoopRunning = false
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        session?.invalidateAndCancel()
        session = nil
        isConnected = false
    }

    func sendPing() {
        let payload = #"{"type":"ping"}"#.data(using: .utf8)!
        task?.send(.data(payload)) { _ in }
    }

    private func receiveNext() {
        guard receiveLoopRunning, let task else { return }
        task.receive { [weak self] result in
            Task { @MainActor in
                guard let self else { return }
                switch result {
                case .failure(let error):
                    self.lastError = error.localizedDescription
                    self.isConnected = false
                    // Reconnect after short delay
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                    if self.receiveLoopRunning {
                        self.connect()
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
                    self.receiveNext()
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
