import Foundation

struct WireEnvelope: Codable, Sendable {
    var kind: String?
    var type: String?
    var event: SessionEvent?
    // hello / pong
    var at: String?
    var version: String?
}

struct SessionEvent: Codable, Sendable {
    let type: String
    let sessionId: String
    let at: String
    // payload is free-form JSON
    // decoded opportunistically in the view model
}

struct StreamingChunk: Codable, Sendable {
    var role: String?
    var text: String?
    var streaming: Bool?
}

enum DispatchSocket {
    /// Events that change sidebar rows / badges. Streaming chunks and tool
    /// progress must not trigger a full session-list refetch.
    static let sidebarTypes: Set<String> = [
        "session.created",
        "session.updated",
        "session.completed",
        "session.failed",
        "session.deleted",
        "approval.needed",
        "approval.resolved",
        "question.needed",
        "question.answered",
    ]

    static func eventType(from data: Data) -> String? {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        if let event = root["event"] as? [String: Any], let type = event["type"] as? String {
            return type
        }
        return root["type"] as? String
    }
}
