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
        // Usage=1 can call Anthropic OAuth per Claude profile — needs headroom on phone Wi‑Fi
        config.timeoutIntervalForRequest = 90
        config.timeoutIntervalForResource = 120
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

    // MARK: - Tasks + Notes

    struct TasksResponse: Codable, Sendable { var tasks: [SessionTask] }
    struct TaskEnvelope: Codable, Sendable { var task: SessionTask }
    struct NoteEnvelope: Codable, Sendable { var note: SessionNote }

    /// Global list across every session on this host. `status` = "open" | "done" | nil.
    func listTasks(status: String? = nil, host: HostEndpoint) async throws -> [SessionTask] {
        let q = status.map { [URLQueryItem(name: "status", value: $0)] }
        let res: TasksResponse = try await get("/tasks", host: host, queryItems: q)
        return res.tasks
    }

    func createTask(
        sessionId: String,
        text: String,
        sourceMessageId: String? = nil,
        host: HostEndpoint
    ) async throws -> SessionTask {
        struct Body: Codable { var text: String; var sourceMessageId: String? }
        let res: TaskEnvelope = try await post(
            "/sessions/\(sessionId)/tasks",
            body: Body(text: text, sourceMessageId: sourceMessageId),
            host: host
        )
        return res.task
    }

    func updateTask(
        sessionId: String,
        taskId: String,
        text: String? = nil,
        status: String? = nil,
        host: HostEndpoint
    ) async throws -> SessionTask {
        struct Body: Codable { var text: String?; var status: String? }
        let res: TaskEnvelope = try await request(
            method: "PATCH",
            path: "/sessions/\(sessionId)/tasks/\(taskId)",
            body: Body(text: text, status: status),
            host: host
        )
        return res.task
    }

    func deleteTask(sessionId: String, taskId: String, host: HostEndpoint) async throws {
        _ = try await request(
            method: "DELETE",
            path: "/sessions/\(sessionId)/tasks/\(taskId)",
            body: EmptyBody(),
            host: host
        ) as EmptyResponse
    }

    func createNote(
        sessionId: String,
        text: String,
        sourceMessageId: String? = nil,
        host: HostEndpoint
    ) async throws -> SessionNote {
        struct Body: Codable { var text: String; var sourceMessageId: String? }
        let res: NoteEnvelope = try await post(
            "/sessions/\(sessionId)/notes",
            body: Body(text: text, sourceMessageId: sourceMessageId),
            host: host
        )
        return res.note
    }

    func updateNote(
        sessionId: String,
        noteId: String,
        text: String,
        host: HostEndpoint
    ) async throws -> SessionNote {
        struct Body: Codable { var text: String }
        let res: NoteEnvelope = try await request(
            method: "PATCH",
            path: "/sessions/\(sessionId)/notes/\(noteId)",
            body: Body(text: text),
            host: host
        )
        return res.note
    }

    func deleteNote(sessionId: String, noteId: String, host: HostEndpoint) async throws {
        _ = try await request(
            method: "DELETE",
            path: "/sessions/\(sessionId)/notes/\(noteId)",
            body: EmptyBody(),
            host: host
        ) as EmptyResponse
    }

    /// Close a session as done — stops the agent, marks status `completed`,
    /// and archives. Distinct from cancel (which marks `cancelled`).
    func closeSession(sessionId: String, host: HostEndpoint) async throws -> SessionDetail {
        try await post(
            "/sessions/\(sessionId)/close",
            body: EmptyBody(),
            host: host
        )
    }

    /// Permanently delete a session (JSON + attachments dir). Cancels first
    /// if the session is currently running.
    func deleteSession(sessionId: String, host: HostEndpoint) async throws {
        _ = try await request(
            method: "DELETE",
            path: "/sessions/\(sessionId)",
            body: EmptyBody(),
            host: host
        ) as EmptyResponse
    }

    /// Assign this session to a project (or detach it by passing nil).
    /// Server validates the target exists and is non-archived.
    func setSessionProject(
        sessionId: String,
        projectId: String?,
        host: HostEndpoint
    ) async throws -> SessionDetail {
        struct Body: Codable { var projectId: String? }
        return try await post(
            "/sessions/\(sessionId)/project",
            body: Body(projectId: projectId),
            host: host
        )
    }

    // MARK: - Project CRUD

    struct ProjectMutationResponse: Codable, Sendable {
        var project: ProjectInfo
    }

    /// Create a project. Server generates an id if you leave it nil.
    func createProject(
        name: String,
        paths: [String],
        color: String? = nil,
        defaultProfileId: String? = nil,
        host: HostEndpoint
    ) async throws -> ProjectInfo {
        struct Body: Codable {
            var name: String
            var paths: [String]
            var color: String?
            var defaultProfileId: String?
        }
        let res: ProjectMutationResponse = try await post(
            "/projects",
            body: Body(name: name, paths: paths, color: color, defaultProfileId: defaultProfileId),
            host: host
        )
        return res.project
    }

    /// Partial update; only pass the fields you want to change.
    func updateProject(
        id: String,
        name: String? = nil,
        paths: [String]? = nil,
        color: String? = nil,
        defaultProfileId: String? = nil,
        archived: Bool? = nil,
        host: HostEndpoint
    ) async throws -> ProjectInfo {
        struct Body: Codable {
            var name: String?
            var paths: [String]?
            var color: String?
            var defaultProfileId: String?
            var archived: Bool?
        }
        let body = Body(
            name: name,
            paths: paths,
            color: color,
            defaultProfileId: defaultProfileId,
            archived: archived
        )
        let res: ProjectMutationResponse = try await request(
            method: "PATCH",
            path: "/projects/\(id)",
            body: body,
            host: host
        )
        return res.project
    }

    /// Soft-archive by default; pass `hard: true` for permanent delete
    /// (includes on-disk attachments).
    func deleteProject(id: String, hard: Bool = false, host: HostEndpoint) async throws {
        let path = hard ? "/projects/\(id)?hard=1" : "/projects/\(id)"
        _ = try await request(
            method: "DELETE",
            path: path,
            body: EmptyBody(),
            host: host
        ) as EmptyResponse
    }

    /// Filesystem-discovered candidates not already in the config. User picks
    /// which (if any) to actually create.
    func discoverProjects(host: HostEndpoint) async throws -> [ProjectInfo] {
        struct Response: Codable { var projects: [ProjectInfo] }
        let res: Response = try await post("/projects/discover", body: [String: String](), host: host)
        return res.projects
    }

    // MARK: - Project attachments

    struct AttachmentResponse: Codable, Sendable {
        var attachment: ProjectAttachment
    }

    /// Upload an image/file to a project's attachments store. `data` should
    /// be raw bytes (we base64-encode here).
    func uploadProjectAttachment(
        projectId: String,
        data: Data,
        mimeType: String,
        filename: String? = nil,
        originalName: String? = nil,
        note: String? = nil,
        fromSessionId: String? = nil,
        host: HostEndpoint
    ) async throws -> ProjectAttachment {
        struct Body: Codable {
            var data: String
            var mimeType: String
            var filename: String?
            var originalName: String?
            var note: String?
            var fromSessionId: String?
        }
        let body = Body(
            data: data.base64EncodedString(),
            mimeType: mimeType,
            filename: filename,
            originalName: originalName,
            note: note,
            fromSessionId: fromSessionId
        )
        let res: AttachmentResponse = try await post(
            "/projects/\(projectId)/attachments",
            body: body,
            host: host
        )
        return res.attachment
    }

    /// Fetch raw bytes of a project attachment.
    func fetchProjectAttachment(
        projectId: String,
        attachmentId: String,
        host: HostEndpoint
    ) async throws -> Data {
        try await getRaw(path: "/projects/\(projectId)/attachments/\(attachmentId)", host: host)
    }

    func deleteProjectAttachment(
        projectId: String,
        attachmentId: String,
        host: HostEndpoint
    ) async throws {
        _ = try await request(
            method: "DELETE",
            path: "/projects/\(projectId)/attachments/\(attachmentId)",
            body: EmptyBody(),
            host: host
        ) as EmptyResponse
    }

    // MARK: - Small helpers for arbitrary-method calls + empty responses

    private struct EmptyBody: Codable {}
    private struct EmptyResponse: Codable {}

    /// Generic method + body helper for PATCH/DELETE where we can't reuse post().
    private func request<T: Decodable, B: Encodable>(
        method: String,
        path: String,
        body: B,
        host: HostEndpoint
    ) async throws -> T {
        var req = try makeRequest(path: path, method: method, host: host, authorized: true)
        if !(body is EmptyBody) {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try encoder.encode(body)
        }
        return try await send(req)
    }

    func profiles(host: HostEndpoint, includeUsage: Bool = false) async throws -> ProfilesResponse {
        if includeUsage {
            return try await get(
                "/profiles",
                host: host,
                queryItems: [URLQueryItem(name: "usage", value: "1")]
            )
        }
        return try await get("/profiles", host: host)
    }

    /// Loopback / same-machine only. Returns env + config dirs for the Profiles manager.
    func adminProfiles(host: HostEndpoint) async throws -> ProfilesResponse {
        try await get(
            "/profiles",
            host: host,
            queryItems: [URLQueryItem(name: "admin", value: "1")]
        )
    }

    func createProfile(_ body: ProfileWriteBody, host: HostEndpoint) async throws -> ProfileWriteResponse {
        try await post("/profiles", body: body, host: host)
    }

    func updateProfile(id: String, body: ProfileWriteBody, host: HostEndpoint) async throws -> ProfileWriteResponse {
        try await request(method: "PATCH", path: "/profiles/\(id)", body: body, host: host)
    }

    func deleteAgentProfile(id: String, host: HostEndpoint) async throws {
        _ = try await request(
            method: "DELETE",
            path: "/profiles/\(id)",
            body: EmptyBody(),
            host: host
        ) as EmptyResponse
    }

    /// Open browser login on the host for this profile (Claude: `claude auth login`).
    func loginProfile(id: String, host: HostEndpoint, email: String? = nil) async throws -> ProfileLoginResponse {
        struct Body: Codable { var email: String? }
        return try await post(
            "/profiles/\(id)/login",
            body: Body(email: email),
            host: host
        )
    }

    func sessions(host: HostEndpoint, query: String? = nil) async throws -> SessionsResponse {
        let q = query?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if q.isEmpty {
            return try await get("/sessions", host: host)
        }
        // Content search: host scans titles + full transcript bodies
        return try await get(
            "/sessions",
            host: host,
            queryItems: [URLQueryItem(name: "q", value: q)]
        )
    }

    func session(id: String, host: HostEndpoint) async throws -> SessionDetail {
        try await get("/sessions/\(id)", host: host)
    }

    /// Raw event replay. Returned Data is the JSON body `{ events: [...] }` —
    /// the caller re-wraps each event as a socket-shaped envelope and feeds it
    /// through the same handler used for live WebSocket events.
    func eventsSince(
        sessionId: String,
        seq: Int,
        host: HostEndpoint
    ) async throws -> Data {
        try await getRaw(path: "/sessions/\(sessionId)/events?since=\(seq)", host: host)
    }

    func diff(id: String, host: HostEndpoint) async throws -> DiffResponse {
        try await get("/sessions/\(id)/diff", host: host)
    }

    struct SessionFilesResponse: Codable, Sendable { var files: [SessionFileEntry] }

    func sessionFiles(id: String, host: HostEndpoint) async throws -> [SessionFileEntry] {
        let res: SessionFilesResponse = try await get("/sessions/\(id)/files", host: host)
        return res.files
    }

    func sessionFile(id: String, path: String, host: HostEndpoint) async throws -> SessionFileContent {
        try await get(
            "/sessions/\(id)/file",
            host: host,
            queryItems: [URLQueryItem(name: "path", value: path)]
        )
    }

    func addExtraDirs(sessionId: String, extraDirs: [String], host: HostEndpoint) async throws -> SessionDetail {
        struct Body: Codable { var extraDirs: [String] }
        return try await request(
            method: "PATCH",
            path: "/sessions/\(sessionId)/extra-dirs",
            body: Body(extraDirs: extraDirs),
            host: host
        )
    }

    func toolCall(sessionId: String, toolCallId: String, host: HostEndpoint) async throws -> ToolCallDetail {
        try await get("/sessions/\(sessionId)/tool-calls/\(toolCallId)", host: host)
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
        scope: String? = nil,
        host: HostEndpoint
    ) async throws -> SessionDetail {
        try await post(
            "/sessions/\(sessionId)/approve",
            body: ApprovalBody(approvalId: approvalId, comment: comment, scope: scope),
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

    /// Move a chat to another agent profile (FullScore → Personal, Claude → NightMoose, …).
    func transferSession(sessionId: String, profileId: String, host: HostEndpoint) async throws -> SessionDetail {
        struct Body: Codable { var profileId: String }
        return try await post(
            "/sessions/\(sessionId)/transfer",
            body: Body(profileId: profileId),
            host: host
        )
    }

    /// Archive old chat and open a fresh session in the same project with a transcript summary.
    func reincarnateSession(
        sessionId: String,
        profileId: String? = nil,
        title: String? = nil,
        note: String? = nil,
        host: HostEndpoint
    ) async throws -> SessionDetail {
        struct Body: Codable {
            var profileId: String?
            var title: String?
            var note: String?
        }
        return try await post(
            "/sessions/\(sessionId)/reincarnate",
            body: Body(profileId: profileId, title: title, note: note),
            host: host
        )
    }

    /// Open a sibling review session (transcript + git diff). Does not archive or take over the source.
    func reviewSession(
        sessionId: String,
        profileId: String? = nil,
        title: String? = nil,
        note: String? = nil,
        includeDiff: Bool = true,
        host: HostEndpoint
    ) async throws -> SessionDetail {
        struct Body: Codable {
            var profileId: String?
            var title: String?
            var note: String?
            var includeDiff: Bool?
        }
        return try await post(
            "/sessions/\(sessionId)/review",
            body: Body(profileId: profileId, title: title, note: note, includeDiff: includeDiff),
            host: host
        )
    }

    func archiveSession(sessionId: String, host: HostEndpoint) async throws -> SessionDetail {
        try await post("/sessions/\(sessionId)/archive", body: [String: String](), host: host)
    }

    func unarchiveSession(sessionId: String, host: HostEndpoint) async throws -> SessionDetail {
        try await post("/sessions/\(sessionId)/unarchive", body: [String: String](), host: host)
    }

    // MARK: - Bots

    func listBots(host: HostEndpoint) async throws -> [Bot] {
        let res: BotsResponse = try await get("/bots", host: host)
        return res.bots
    }

    func createBot(_ body: BotCreate, host: HostEndpoint) async throws -> Bot {
        let res: BotEnvelope = try await post("/bots", body: body, host: host)
        return res.bot
    }

    func patchBot(id: String, patch: BotPatch, host: HostEndpoint) async throws -> Bot {
        let res: BotEnvelope = try await request(
            method: "PATCH",
            path: "/bots/\(id)",
            body: patch,
            host: host
        )
        return res.bot
    }

    func runBot(id: String, note: String?, host: HostEndpoint) async throws -> BotRunResponse {
        try await post("/bots/\(id)/run", body: BotRunBody(note: note), host: host)
    }

    func botOutbox(id: String, host: HostEndpoint) async throws -> BotOutboxResponse {
        try await get("/bots/\(id)/outbox", host: host)
    }

    // MARK: - Internals

    private func get<T: Decodable>(
        _ path: String,
        host: HostEndpoint,
        authorized: Bool = true,
        queryItems: [URLQueryItem]? = nil
    ) async throws -> T {
        var req = try makeRequest(
            path: path,
            method: "GET",
            host: host,
            authorized: authorized,
            queryItems: queryItems
        )
        return try await send(req)
    }

    private func getRaw(path: String, host: HostEndpoint) async throws -> Data {
        let req = try makeRequest(path: path, method: "GET", host: host, authorized: true)
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw APIError.transport(URLError(.badServerResponse))
        }
        guard (200..<300).contains(http.statusCode) else {
            throw APIError.http(http.statusCode, String(data: data, encoding: .utf8))
        }
        return data
    }

    private func post<T: Decodable, B: Encodable>(_ path: String, body: B, host: HostEndpoint) async throws -> T {
        var req = try makeRequest(path: path, method: "POST", host: host, authorized: true)
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try encoder.encode(body)
        return try await send(req)
    }

    private func makeRequest(
        path: String,
        method: String,
        host: HostEndpoint,
        authorized: Bool,
        queryItems: [URLQueryItem]? = nil
    ) throws -> URLRequest {
        let auth = try HostAuth(host: host)
        let url = try joinURL(base: auth.baseURL, path: path, queryItems: queryItems)
        var req = URLRequest(url: url)
        req.httpMethod = method
        if authorized {
            req.setValue("Bearer \(auth.token)", forHTTPHeaderField: "Authorization")
            req.setValue(auth.token, forHTTPHeaderField: "x-grok-dispatch-token")
        }
        return req
    }

    private func joinURL(base: URL, path: String, queryItems: [URLQueryItem]? = nil) throws -> URL {
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
        if let queryItems, !queryItems.isEmpty {
            components.queryItems = queryItems
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
