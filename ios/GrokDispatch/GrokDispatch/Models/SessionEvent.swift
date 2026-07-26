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
