import Foundation
import SwiftUI

enum SessionStatus: String, Codable, CaseIterable, Sendable {
    case queued
    case running
    case awaitingApproval = "awaiting_approval"
    case awaitingQuestion = "awaiting_question"
    /// Turn finished; conversation open for more prompts.
    case idle
    case completed
    case failed
    case cancelled
    /// Unknown future host status — don't fail decoding the whole session.
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = SessionStatus(rawValue: raw) ?? .unknown
    }

    var label: String {
        switch self {
        case .queued: return "Queued"
        case .running: return "Running"
        case .awaitingApproval: return "Needs approval"
        case .awaitingQuestion: return "Needs answers"
        case .idle: return "Your turn"
        case .completed: return "Done"
        case .failed: return "Failed"
        case .cancelled: return "Cancelled"
        case .unknown: return "Unknown"
        }
    }

    var systemImage: String {
        switch self {
        case .queued: return "clock"
        case .running: return "ellipsis.circle"
        case .awaitingApproval: return "hand.raised.fill"
        case .awaitingQuestion: return "questionmark.bubble.fill"
        case .idle: return "bubble.left.and.bubble.right"
        case .completed: return "checkmark.circle.fill"
        case .failed: return "xmark.octagon.fill"
        case .cancelled: return "stop.circle"
        case .unknown: return "questionmark"
        }
    }

    /// Can send another message in this conversation.
    var allowsFollowUp: Bool {
        switch self {
        case .idle, .completed, .running, .queued, .unknown: return true
        case .awaitingApproval, .awaitingQuestion, .failed, .cancelled: return false
        }
    }
}

struct ProjectInfo: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let name: String
    let path: String
}

/// Concurrent agent account (FullScore / Astro / NightMoose …) — colored nav segment.
struct AgentProfile: Codable, Identifiable, Hashable, Sendable {
    let id: String
    var name: String
    var backend: String
    var color: String
    var model: String?
    var hasCredentials: Bool?

    var isClaude: Bool { backend == "claude" }
    var isGrok: Bool { backend == "grok" }

    var uiColor: Color {
        Color(hex: color) ?? (isClaude ? Color.orange : Color(red: 0.45, green: 0.72, blue: 1.0))
    }
}

extension Color {
    /// Parse #RGB or #RRGGBB (optional leading #).
    init?(hex: String) {
        var s = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("#") { s.removeFirst() }
        var value: UInt64 = 0
        guard Scanner(string: s).scanHexInt64(&value) else { return nil }
        let r, g, b: Double
        switch s.count {
        case 3:
            r = Double((value >> 8) & 0xF) / 15
            g = Double((value >> 4) & 0xF) / 15
            b = Double(value & 0xF) / 15
        case 6:
            r = Double((value >> 16) & 0xFF) / 255
            g = Double((value >> 8) & 0xFF) / 255
            b = Double(value & 0xFF) / 255
        default:
            return nil
        }
        self.init(red: r, green: g, blue: b)
    }
}

struct SessionSummary: Codable, Identifiable, Hashable, Sendable {
    let id: String
    var grokSessionId: String?
    var title: String
    var prompt: String
    var cwd: String
    var projectId: String?
    var model: String
    var planMode: Bool
    var status: SessionStatus
    var createdAt: String
    var updatedAt: String
    var completedAt: String?
    var error: String?
    var pendingApprovalId: String?
    var toolCallCount: Int
    var transcriptPreview: String?
    var isLive: Bool?
    var archived: Bool?
    var archivedAt: String?
    var backend: String?
    var profileId: String?
    var profileName: String?
    var profileColor: String?
    var claudeSessionId: String?

    var isArchived: Bool { archived == true }

    var createdDate: Date? { ISO8601DateFormatter.flexible.date(from: createdAt) }
    var updatedDate: Date? { ISO8601DateFormatter.flexible.date(from: updatedAt) }
}

struct TranscriptEntry: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let role: String
    let text: String
    let at: String
}

struct ToolCallRecord: Codable, Identifiable, Hashable, Sendable {
    var id: String { toolCallId }
    let toolCallId: String
    var title: String
    var kind: String?
    var status: String
    var updatedAt: String
}

struct PlanEntry: Codable, Hashable, Sendable {
    var content: String
    var priority: String?
    var status: String?
}

struct ApprovalOption: Codable, Identifiable, Hashable, Sendable {
    var id: String { optionId }
    let optionId: String
    let name: String
    let kind: String
}

struct PendingApproval: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let sessionId: String
    var toolCallId: String?
    var title: String
    var kind: String?
    var options: [ApprovalOption]
    var createdAt: String
}

struct QuestionOption: Codable, Hashable, Sendable {
    var label: String
    var description: String?
    var preview: String?
}

struct AgentQuestion: Codable, Identifiable, Hashable, Sendable {
    var id: String { question }
    var question: String
    var options: [QuestionOption]
    var multiSelect: Bool?
}

struct PendingQuestion: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let sessionId: String
    var toolCallId: String?
    var title: String
    var questions: [AgentQuestion]
    var createdAt: String
    var canRespondViaAcp: Bool?
}

struct SessionDetail: Codable, Identifiable, Sendable {
    let id: String
    var grokSessionId: String?
    var title: String
    var prompt: String
    var cwd: String
    var projectId: String?
    var model: String
    var planMode: Bool
    var subagents: Bool
    var worktree: Bool
    var status: SessionStatus
    var createdAt: String
    var updatedAt: String
    var completedAt: String?
    var error: String?
    var stopReason: String?
    var pendingApprovalId: String?
    var toolCallCount: Int
    var transcriptPreview: String?
    var transcript: [TranscriptEntry]
    var toolCalls: [ToolCallRecord]
    var plan: [PlanEntry]?
    var pendingApproval: PendingApproval?
    var pendingQuestion: PendingQuestion?
    var archived: Bool?
    var archivedAt: String?

    var isArchived: Bool { archived == true }
}

struct DiskSessionHint: Codable, Identifiable, Sendable {
    var id: String
    var source: String?
    var cwd: String?
    var title: String?
    var updatedAt: String?
    var model: String?
    var transcriptPath: String?

    var isClaude: Bool { source == "claude" }
}

struct SessionsResponse: Codable, Sendable {
    let sessions: [SessionSummary]
    /// Soft-archived Dispatch chats (hidden from Active by default).
    var archivedSessions: [SessionSummary]?
    var diskSessions: [DiskSessionHint]?
    var claudeSessions: [DiskSessionHint]?
}

struct ProfilesResponse: Codable, Sendable {
    let profiles: [AgentProfile]
}

struct ProjectsResponse: Codable, Sendable {
    let projects: [ProjectInfo]
    let allowCustomPaths: Bool
}

struct DiffResponse: Codable, Sendable {
    let cwd: String
    let diff: String
}

struct HealthResponse: Codable, Sendable {
    let ok: Bool
    let service: String?
    let version: String?
}

extension ISO8601DateFormatter {
    static let flexible: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
}
