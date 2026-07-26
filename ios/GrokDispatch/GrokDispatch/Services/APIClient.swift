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

actor APIClient {
    private let session: URLSession
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 60
        config.waitsForConnectivity = true
        self.session = URLSession(configuration: config)
        self.decoder = JSONDecoder()
        self.encoder = JSONEncoder()
    }

    private var baseURL: URL {
        get throws {
            guard let raw = KeychainHelper.loadString(key: KeychainHelper.Keys.hostURL)?
                .trimmingCharacters(in: .whitespacesAndNewlines),
                  !raw.isEmpty,
                  let url = URL(string: raw)
            else { throw APIError.notConfigured }
            return url
        }
    }

    private var token: String {
        get throws {
            guard let t = KeychainHelper.loadString(key: KeychainHelper.Keys.hostToken), !t.isEmpty
            else { throw APIError.notConfigured }
            return t
        }
    }

    func health() async throws -> HealthResponse {
        try await get("/health", authorized: false)
    }

    func validate() async throws {
        // Host returns { ok: true, projects: N } — projects is Int, not Bool
        struct ValidateResponse: Decodable {
            let ok: Bool?
            let projects: Int?
        }
        let res: ValidateResponse = try await post("/auth/validate", body: [String: String]())
        if res.ok == false {
            throw APIError.http(401, "Host rejected token")
        }
    }

    func projects() async throws -> ProjectsResponse {
        try await get("/projects")
    }

    func sessions() async throws -> SessionsResponse {
        try await get("/sessions")
    }

    func session(id: String) async throws -> SessionDetail {
        try await get("/sessions/\(id)")
    }

    func diff(id: String) async throws -> DiffResponse {
        try await get("/sessions/\(id)/diff")
    }

    func dispatch(_ body: DispatchRequestBody) async throws -> SessionDetail {
        try await post("/dispatch", body: body)
    }

    func attach(grokSessionId: String, cwd: String, title: String?, prompt: String?) async throws -> SessionDetail {
        struct Body: Codable {
            var grokSessionId: String
            var cwd: String
            var title: String?
            var prompt: String?
        }
        return try await post(
            "/sessions/attach",
            body: Body(grokSessionId: grokSessionId, cwd: cwd, title: title, prompt: prompt)
        )
    }

    func attachClaude(
        claudeSessionId: String,
        cwd: String,
        title: String?,
        mode: String,
        transcriptPath: String?
    ) async throws -> SessionDetail {
        struct Body: Codable {
            var claudeSessionId: String
            var cwd: String
            var title: String?
            var mode: String?
            var transcriptPath: String?
        }
        return try await post(
            "/sessions/attach-claude",
            body: Body(
                claudeSessionId: claudeSessionId,
                cwd: cwd,
                title: title,
                mode: mode,
                transcriptPath: transcriptPath
            )
        )
    }

    func prompt(sessionId: String, text: String) async throws -> SessionDetail {
        try await post("/sessions/\(sessionId)/prompt", body: PromptBody(prompt: text))
    }

    func approve(sessionId: String, approvalId: String, comment: String?) async throws -> SessionDetail {
        try await post(
            "/sessions/\(sessionId)/approve",
            body: ApprovalBody(approvalId: approvalId, comment: comment)
        )
    }

    func reject(sessionId: String, approvalId: String, comment: String?) async throws -> SessionDetail {
        try await post(
            "/sessions/\(sessionId)/reject",
            body: ApprovalBody(approvalId: approvalId, comment: comment)
        )
    }

    func answerQuestions(
        sessionId: String,
        questionId: String?,
        answers: [String],
        comment: String?
    ) async throws -> SessionDetail {
        struct Body: Codable {
            var questionId: String?
            var answers: [String]
            var comment: String?
            var outcome: String?
        }
        return try await post(
            "/sessions/\(sessionId)/answer-questions",
            body: Body(questionId: questionId, answers: answers, comment: comment, outcome: "accepted")
        )
    }

    func cancel(sessionId: String) async throws -> SessionDetail {
        try await post("/sessions/\(sessionId)/cancel", body: [String: String]())
    }

    func renameSession(sessionId: String, title: String) async throws -> SessionDetail {
        struct Body: Codable { var title: String }
        return try await post("/sessions/\(sessionId)/title", body: Body(title: title))
    }

    func archiveSession(sessionId: String) async throws -> SessionDetail {
        try await post("/sessions/\(sessionId)/archive", body: [String: String]())
    }

    func unarchiveSession(sessionId: String) async throws -> SessionDetail {
        try await post("/sessions/\(sessionId)/unarchive", body: [String: String]())
    }

    // MARK: - Internals

    private func get<T: Decodable>(_ path: String, authorized: Bool = true) async throws -> T {
        var req = try makeRequest(path: path, method: "GET", authorized: authorized)
        return try await send(req)
    }

    private func post<T: Decodable, B: Encodable>(_ path: String, body: B) async throws -> T {
        var req = try makeRequest(path: path, method: "POST", authorized: true)
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try encoder.encode(body)
        return try await send(req)
    }

    private func makeRequest(path: String, method: String, authorized: Bool) throws -> URLRequest {
        let url = try joinURL(base: try baseURL, path: path)
        var req = URLRequest(url: url)
        req.httpMethod = method
        if authorized {
            req.setValue("Bearer \(try token)", forHTTPHeaderField: "Authorization")
        }
        return req
    }

    /// Join host base + API path without dropping the port (Swift relative URL pitfall).
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
            // Prefer host JSON error message when present
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
