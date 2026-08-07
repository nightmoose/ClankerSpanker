import Foundation

enum APIError: LocalizedError {
    case notConfigured
    case invalidURL
    case http(Int, String?)
    case decoding(Error)
    case transport(Error)

    var errorDescription: String? {
        switch self {
        case .notConfigured: return "Host is not configured"
        case .invalidURL: return "Invalid host URL"
        case .http(let code, let body): return "HTTP \(code)\(body.map { ": \($0)" } ?? "")"
        case .decoding(let err): return "Decode error: \(err.localizedDescription)"
        case .transport(let err): return err.localizedDescription
        }
    }
}

/// Credentials for one host machine.
struct HostAuth: Sendable {
    let baseURL: URL
    let token: String

    init(host: HostEndpoint) throws {
        let raw = host.baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty, let url = URL(string: raw) else { throw APIError.invalidURL }
        let token = host.loadToken()
        guard !token.isEmpty else { throw APIError.notConfigured }
        self.baseURL = url
        self.token = token
    }
}

actor APIClient {
    private let session: URLSession
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    init() {
        let config = URLSessionConfiguration.ephemeral
        // Local host on loopback must not sit in "waiting for connectivity"
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 60
        config.waitsForConnectivity = false
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        self.session = URLSession(configuration: config)
        self.decoder = JSONDecoder()
        self.encoder = JSONEncoder()
    }

    // MARK: - Public API (host-scoped)

    func health(host: HostEndpoint) async throws -> HealthResponse {
        try await get("/health", host: host, authorized: false)
    }

    func validate(host: HostEndpoint) async throws {
        struct ValidateResponse: Decodable {
            let ok: Bool?
            let projects: Int?
        }
        let res: ValidateResponse = try await post("/auth/validate", body: [String: String](), host: host)
        if res.ok == false {
            throw APIError.http(401, "Host rejected token")
        }
    }

    func projects(host: HostEndpoint) async throws -> ProjectsResponse {
        try await get("/projects", host: host)
    }

    func profiles(host: HostEndpoint) async throws -> ProfilesResponse {
        try await get("/profiles", host: host)
    }

    func sessions(host: HostEndpoint) async throws -> SessionsResponse {
        try await get("/sessions", host: host)
    }

    func session(id: String, host: HostEndpoint) async throws -> SessionDetail {
        try await get("/sessions/\(id)", host: host)
    }

    func diff(id: String, host: HostEndpoint) async throws -> DiffResponse {
        try await get("/sessions/\(id)/diff", host: host)
    }

    func dispatch(_ body: DispatchRequestBody, host: HostEndpoint) async throws -> SessionDetail {
        try await post("/dispatch", body: body, host: host)
    }

    func attach(
        grokSessionId: String,
        cwd: String,
        title: String?,
        prompt: String?,
        profileId: String?,
        host: HostEndpoint
    ) async throws -> SessionDetail {
        struct Body: Codable {
            var grokSessionId: String
            var cwd: String
            var title: String?
            var prompt: String?
            var profileId: String?
        }
        return try await post(
            "/sessions/attach",
            body: Body(
                grokSessionId: grokSessionId,
                cwd: cwd,
                title: title,
                prompt: prompt,
                profileId: profileId
            ),
            host: host
        )
    }

    func attachClaude(
        claudeSessionId: String,
        cwd: String,
        title: String?,
        mode: String,
        transcriptPath: String?,
        profileId: String?,
        host: HostEndpoint
    ) async throws -> SessionDetail {
        struct Body: Codable {
            var claudeSessionId: String
            var cwd: String
            var title: String?
            var mode: String?
            var transcriptPath: String?
            var profileId: String?
        }
        return try await post(
            "/sessions/attach-claude",
            body: Body(
                claudeSessionId: claudeSessionId,
                cwd: cwd,
                title: title,
                mode: mode,
                transcriptPath: transcriptPath,
                profileId: profileId
            ),
            host: host
        )
    }

    func prompt(
        sessionId: String,
        text: String,
        images: [PromptImagePayload]? = nil,
        host: HostEndpoint
    ) async throws -> SessionDetail {
        try await post(
            "/sessions/\(sessionId)/prompt",
            body: PromptBody(prompt: text, images: images),
            host: host
        )
    }

    func approve(
        sessionId: String,
        approvalId: String,
        comment: String?,
        host: HostEndpoint
    ) async throws -> SessionDetail {
        try await post(
            "/sessions/\(sessionId)/approve",
            body: ApprovalBody(approvalId: approvalId, comment: comment),
            host: host
        )
    }

    func reject(
        sessionId: String,
        approvalId: String,
        comment: String?,
        host: HostEndpoint
    ) async throws -> SessionDetail {
        try await post(
            "/sessions/\(sessionId)/reject",
            body: ApprovalBody(approvalId: approvalId, comment: comment),
            host: host
        )
    }

    func answerQuestions(
        sessionId: String,
        questionId: String?,
        answers: [String],
        comment: String?,
        host: HostEndpoint
    ) async throws -> SessionDetail {
        struct Body: Codable {
            var questionId: String?
            var answers: [String]
            var comment: String?
            var outcome: String?
        }
        return try await post(
            "/sessions/\(sessionId)/answer-questions",
            body: Body(questionId: questionId, answers: answers, comment: comment, outcome: "accepted"),
            host: host
        )
    }

    func cancel(sessionId: String, host: HostEndpoint) async throws -> SessionDetail {
        try await post("/sessions/\(sessionId)/cancel", body: [String: String](), host: host)
    }

    func renameSession(sessionId: String, title: String, host: HostEndpoint) async throws -> SessionDetail {
        struct Body: Codable { var title: String }
        return try await post("/sessions/\(sessionId)/title", body: Body(title: title), host: host)
    }

    func archiveSession(sessionId: String, host: HostEndpoint) async throws -> SessionDetail {
        try await post("/sessions/\(sessionId)/archive", body: [String: String](), host: host)
    }

    func unarchiveSession(sessionId: String, host: HostEndpoint) async throws -> SessionDetail {
        try await post("/sessions/\(sessionId)/unarchive", body: [String: String](), host: host)
    }

    // MARK: - Internals

    private func get<T: Decodable>(_ path: String, host: HostEndpoint, authorized: Bool = true) async throws -> T {
        var req = try makeRequest(path: path, method: "GET", host: host, authorized: authorized)
        return try await send(req)
    }

    private func post<T: Decodable, B: Encodable>(_ path: String, body: B, host: HostEndpoint) async throws -> T {
        var req = try makeRequest(path: path, method: "POST", host: host, authorized: true)
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try encoder.encode(body)
        return try await send(req)
    }

    private func makeRequest(path: String, method: String, host: HostEndpoint, authorized: Bool) throws -> URLRequest {
        let auth = try HostAuth(host: host)
        let url = try joinURL(base: auth.baseURL, path: path)
        var req = URLRequest(url: url)
        req.httpMethod = method
        if authorized {
            req.setValue("Bearer \(auth.token)", forHTTPHeaderField: "Authorization")
        }
        return req
    }

    private func joinURL(base: URL, path: String) throws -> URL {
        guard var components = URLComponents(url: base, resolvingAgainstBaseURL: false) else {
            throw APIError.invalidURL
        }
        let cleanPath = path.hasPrefix("/") ? path : "/" + path
        let basePath = components.path
        if basePath.isEmpty || basePath == "/" {
            components.path = cleanPath
        } else {
            let trimmed = basePath.hasSuffix("/") ? String(basePath.dropLast()) : basePath
            components.path = trimmed + cleanPath
        }
        guard let url = components.url else { throw APIError.invalidURL }
        return url
    }

    private func send<T: Decodable>(_ req: URLRequest) async throws -> T {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw APIError.transport(error)
        }
        guard let http = response as? HTTPURLResponse else {
            throw APIError.http(-1, "No HTTP response")
        }
        guard (200..<300).contains(http.statusCode) else {
            let body = String(data: data, encoding: .utf8)
            if let body,
               let obj = try? JSONSerialization.jsonObject(with: Data(body.utf8)) as? [String: Any],
               let err = obj["error"] as? String {
                throw APIError.http(http.statusCode, err)
            }
            throw APIError.http(http.statusCode, body.map { String($0.prefix(300)) })
        }
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw APIError.decoding(error)
        }
    }
}
