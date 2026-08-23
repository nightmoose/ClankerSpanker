import Foundation

struct DispatchRequestBody: Codable, Sendable {
    var prompt: String
    var projectId: String?
    var cwd: String?
    var title: String?
    var model: String?
    var planMode: Bool?
    var subagents: Bool?
    var worktree: Bool?
    var profileId: String?
    var botId: String?
    var images: [PromptImagePayload]?
}

struct PromptImagePayload: Codable, Sendable {
    /// e.g. image/jpeg
    var mimeType: String
    /// Raw base64 (no data: prefix)
    var data: String
    var name: String?
}

struct PromptBody: Codable, Sendable {
    var prompt: String
    var images: [PromptImagePayload]?
}

struct ApprovalBody: Codable, Sendable {
    var approvalId: String
    var optionId: String?
    var comment: String?
    /// "once" (default) or "always_session". When "always_session", the host
    /// adds the tool signature to the session's allowlist so subsequent
    /// matching approvals skip the phone entirely.
    var scope: String?
}

struct HostConfig: Codable, Equatable, Sendable {
    var hostURL: String
    /// Optional xAI key stored on device (not required if Mac already authenticated).
    var hasXAIKey: Bool

    static let `default` = HostConfig(hostURL: "http://mac-mini.tailnet:8787", hasXAIKey: false)
}

enum AppTab: Hashable {
    case sessions
    case projects
    case tasks
    case compose
    /// macOS command center — local host process + config.
    case host
    case settings
}

/// Prefill for Dispatch when opened from Projects or reincarnate flows.
struct ComposePrefill: Equatable, Sendable {
    var projectId: String?
    var cwd: String?
    var title: String?
    var prompt: String?
}
