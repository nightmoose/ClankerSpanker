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
}

struct PromptBody: Codable, Sendable {
    var prompt: String
}

struct ApprovalBody: Codable, Sendable {
    var approvalId: String
    var optionId: String?
    var comment: String?
}

struct HostConfig: Codable, Equatable, Sendable {
    var hostURL: String
    /// Optional xAI key stored on device (not required if Mac already authenticated).
    var hasXAIKey: Bool

    static let `default` = HostConfig(hostURL: "http://mac-mini.tailnet:8787", hasXAIKey: false)
}

enum AppTab: Hashable {
    case sessions
    case compose
    case settings
}
