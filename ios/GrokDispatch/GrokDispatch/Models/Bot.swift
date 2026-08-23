import Foundation

struct Bot: Codable, Identifiable, Hashable, Sendable {
    let id: String
    var name: String
    var enabled: Bool
    var profileId: String
    var projectId: String
    var job: String
    var interval: String
    var tools: [String]
    var maxTurnsPerRun: Int
    var lastRunAt: String?
    var lastSessionId: String?

    var lastRunDate: Date? {
        guard let lastRunAt else { return nil }
        return ISO8601DateFormatter.flexible.date(from: lastRunAt)
    }
}

struct BotsResponse: Codable, Sendable {
    var bots: [Bot]
}

struct BotEnvelope: Codable, Sendable {
    var bot: Bot
    var lastSession: SessionSummary?
}

struct BotRunResponse: Codable, Sendable {
    var session: SessionSummary
    var bot: Bot?
}

struct BotOutboxResponse: Codable, Sendable {
    var botId: String
    var cwd: String
    var items: [BotOutboxItem]
}

struct BotOutboxItem: Codable, Identifiable, Hashable, Sendable {
    var filename: String
    var relPath: String
    var updatedAt: String
    var bytes: Int
    var content: String

    var id: String { relPath }

    var updatedDate: Date? { ISO8601DateFormatter.flexible.date(from: updatedAt) }
}

struct BotPatch: Codable, Sendable {
    var enabled: Bool?
    var job: String?
    var interval: String?
    var name: String?
}

struct BotCreate: Codable, Sendable {
    var name: String
    var profileId: String
    var projectId: String
    var job: String
    var interval: String
    var enabled: Bool
}

enum BotSchedule {
    static let presets = ["15m", "30m", "1h", "6h", "12h", "1d"]

    static func label(_ raw: String) -> String {
        switch raw {
        case "15m": return "Every 15 minutes"
        case "30m": return "Every 30 minutes"
        case "1h": return "Every hour"
        case "6h": return "Every 6 hours"
        case "12h": return "Every 12 hours"
        case "1d": return "Every day"
        default: return "Every \(raw)"
        }
    }
}

struct BotRunBody: Codable, Sendable {
    var note: String?
}
