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

    /// Short labels for tight list rows (phone session cards).
    var shortLabel: String {
        switch self {
        case .queued: return "Queued"
        case .running: return "Running"
        case .awaitingApproval: return "Approve"
        case .awaitingQuestion: return "Answer"
        case .idle: return "Ready"
        case .completed: return "Done"
        case .failed: return "Failed"
        case .cancelled: return "Stopped"
        case .unknown: return "?"
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

struct ProjectResource: Codable, Identifiable, Hashable, Sendable {
    let id: String
    /// "url" | "note" | "doc" (extensible on the host).
    var kind: String
    var label: String
    var value: String
    var addedAt: String
}

struct ProjectAttachment: Codable, Identifiable, Hashable, Sendable {
    let id: String
    var filename: String
    var originalName: String?
    var mimeType: String
    var sizeBytes: Int
    var addedAt: String
    var fromSessionId: String?
    var note: String?
}

struct ProjectInfo: Codable, Identifiable, Hashable, Sendable {
    let id: String
    var name: String
    /// Legacy single-path mirror of `paths.first`. Older hosts only send this;
    /// prefer `paths` for anything new.
    var path: String
    /// Multi-path support (frontend + backend, monorepo companion repos, etc.).
    /// Backend guarantees at least one element after normalization; older
    /// hosts may omit it entirely, in which case we synthesize from `path`.
    var paths: [String]?
    var color: String?
    var resources: [ProjectResource]?
    var attachments: [ProjectAttachment]?
    var defaultProfileId: String?
    var archived: Bool?
    var createdAt: String?
    var updatedAt: String?

    /// Effective paths — always at least one element when the project is
    /// usable. Falls back to `[path]` for old-shape responses.
    var effectivePaths: [String] {
        if let p = paths, !p.isEmpty { return p }
        return path.isEmpty ? [] : [path]
    }

    /// Effective primary path (for legacy displays / cwd matching).
    var primaryPath: String { effectivePaths.first ?? path }

    var isArchived: Bool { archived == true }
}

/// Concurrent agent account (FullScore / Astro / NightMoose …) — colored nav segment.
struct AgentProfile: Codable, Identifiable, Hashable, Sendable {
    let id: String
    var name: String
    var backend: String
    var color: String
    var model: String?
    var hasCredentials: Bool?
    /// Live quota / readiness from GET /profiles?usage=1.
    var usage: ProfileUsage?
    /// Sessions run tools without asking (Antigravity default, RFC-030).
    var autoApprovesTools: Bool?

    var isClaude: Bool { backend == "claude" }
    var isGrok: Bool { backend == "grok" }
    var isAntigravity: Bool { backend == "antigravity" || backend == "agy" || backend == "gemini" }
    var isBot: Bool { backend == "bot" }
    /// Extra brain chip we used to show — hunter runs now live under NightMoose.
    var isHiddenChip: Bool {
        isBot || id == "nightmoose-bot"
    }
    /// Backends that are headless CLIs (not Grok ACP).
    var isCliBackend: Bool { isClaude || isAntigravity }

    var systemImage: String {
        if isBot { return "scope" }
        if isClaude { return "brain.head.profile" }
        if isAntigravity { return "sparkle.magnifyingglass" }
        return "sparkles"
    }

    var uiColor: Color {
        if let c = Color(hex: color) { return c }
        if isBot { return Color(red: 0.91, green: 0.47, blue: 0.98) }
        if isClaude { return Color.orange }
        if isAntigravity { return Color(red: 0.20, green: 0.66, blue: 0.33) } // Google green
        return Color(red: 0.45, green: 0.72, blue: 1.0)
    }

    /// True when host says this profile can still take work (or status unknown).
    var canWork: Bool {
        if let u = usage, let can = u.canWork { return can }
        return hasCredentials != false
    }
}

/// Claude OAuth windows + stubs for other backends (wire: profiles[].usage).
struct ProfileUsage: Codable, Hashable, Sendable {
    var status: String?
    /// % used in 5-hour window (0–100).
    var fiveHourPercent: Double?
    var fiveHourResetsAt: String?
    /// % used in 7-day window.
    var sevenDayPercent: Double?
    var sevenDayResetsAt: String?
    var sevenDayOpusPercent: Double?
    var label: String?
    var accountEmail: String?
    var canWork: Bool?
    var error: String?
    var fetchedAt: String?

    /// Highest utilization among known windows (used %).
    var peakUsedPercent: Double? {
        let vals = [fiveHourPercent, sevenDayPercent, sevenDayOpusPercent].compactMap { $0 }
        return vals.max()
    }

    /// Compact chip subtitle, e.g. "5h 12% · wk 2%".
    var shortLabel: String {
        if let label, !label.isEmpty { return label }
        var parts: [String] = []
        if let p = fiveHourPercent { parts.append("5h \(Int(p.rounded()))%") }
        if let p = sevenDayPercent { parts.append("wk \(Int(p.rounded()))%") }
        if parts.isEmpty {
            switch status {
            case "limited": return "Limit hit"
            case "api_key": return "API key"
            case "unknown": return "No login"
            case "error": return "Usage error"
            default: return "—"
            }
        }
        return parts.joined(separator: " · ")
    }

    var trafficColor: Color {
        guard let used = peakUsedPercent else {
            if status == "limited" { return DispatchColors.danger }
            if status == "ok" || status == "api_key" { return DispatchColors.success }
            if status == "error" { return DispatchColors.warning }
            // unknown / not signed in — muted, not screaming red
            if canWork == false { return DispatchColors.warning }
            return .secondary
        }
        if used >= 95 { return DispatchColors.danger }
        if used >= 75 { return DispatchColors.warning }
        return DispatchColors.success
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
    var botId: String?
    var profileId: String?
    var profileName: String?
    var profileColor: String?
    var claudeSessionId: String?
    var antigravityConversationId: String?
    // RFC-021 per-session Grok credit meter (weekly-% this chat has burned).
    var creditsUsedDeltaPct: Double?
    var creditsUsedAt: String?
    /// RFC-024: `HostEndpoint.id.uuidString` this session came from. Stamped
    /// by the client on receive (host doesn't emit it). Nil for legacy
    /// records; APIs that need the owning host must fall back to the fetch
    /// context in that case.
    var hostId: String?

    var isArchived: Bool { archived == true }

    var createdDate: Date? { ISO8601DateFormatter.flexible.date(from: createdAt) }
    var updatedDate: Date? { ISO8601DateFormatter.flexible.date(from: updatedAt) }

    /// New id for cross-host dedupe. Sessions from different hosts may share
    /// `id` (attach flow re-imports the same underlying Grok/Claude id on two
    /// machines) — the key is composite.
    var routeKey: String { "\(hostId ?? "").\(id)" }
}

struct TranscriptEntry: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let role: String
    let text: String
    let at: String
}

/// User-captured action item derived from (or written into) a session.
struct SessionTask: Codable, Identifiable, Hashable, Sendable {
    let id: String
    var sourceSessionId: String
    var sourceMessageId: String?
    var projectId: String?
    var text: String
    var status: String  // "open" | "done"
    var createdAt: String
    var updatedAt: String?
    var completedAt: String?

    var isDone: Bool { status == "done" }
}

/// Free-form user note, optionally linked to a specific transcript message.
struct SessionNote: Codable, Identifiable, Hashable, Sendable {
    let id: String
    var sourceSessionId: String
    var sourceMessageId: String?
    var text: String
    var createdAt: String
    var updatedAt: String?
}

struct ToolLocation: Codable, Hashable, Sendable {
    var path: String
    var line: Int?
}

struct ToolCallRecord: Codable, Identifiable, Hashable, Sendable {
    var id: String { toolCallId }
    let toolCallId: String
    var title: String
    var kind: String?
    var status: String
    var updatedAt: String
    var locations: [ToolLocation]?
    /// Tail of command output + exit code (RFC-040). Absent on older hosts.
    var outputPreview: String?
    var exitCode: Int?
}

/// GET /sessions/:id/tool-calls/:toolCallId — pretty-printed payloads for the ellipsis sheet.
struct ToolCallDetail: Codable, Sendable {
    let toolCallId: String
    var title: String
    var kind: String?
    var status: String
    var updatedAt: String
    var locations: [ToolLocation]?
    var rawInputJson: String?
    var contentJson: String?
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

struct ApprovalRawInput: Codable, Hashable, Sendable {
    var channel: String?
    var to: String?
    var subject: String?
    var body: String?
    var reason: String?
    var path: String?
    var content: String?
}

struct PendingApproval: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let sessionId: String
    var toolCallId: String?
    var title: String
    var kind: String?
    var rawInput: ApprovalRawInput?
    /// Diff or command the tool will run (RFC-033). Absent on older hosts.
    var preview: ApprovalPreview?
    var options: [ApprovalOption]
    var createdAt: String
}

/// Host-normalized "what will this do" for approval cards (RFC-033).
struct ApprovalPreview: Codable, Hashable, Sendable {
    var type: String            // "diff" | "command"
    var path: String?
    var oldText: String?
    var newText: String?
    var command: String?
    var cwd: String?
    var truncated: Bool?
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
    var extraDirs: [String]?
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
    var backend: String?
    var botId: String?
    var profileId: String?
    var profileName: String?
    var profileColor: String?
    var claudeSessionId: String?
    var tasks: [SessionTask]?
    var notes: [SessionNote]?
    var usage: SessionUsage?
    // RFC-021 per-session Grok credit meter (weekly-% this chat has burned).
    var creditsUsedDeltaPct: Double?
    var creditsUsedAt: String?

    var isArchived: Bool { archived == true }

    var effectiveExtraDirs: [String] { extraDirs ?? [] }
}

struct SessionFileEntry: Codable, Identifiable, Hashable, Sendable {
    var path: String
    var kind: String
    var title: String?
    var updatedAt: String?

    var id: String { path }

    var isFolder: Bool { kind == "folder" }
    var isAttachment: Bool { kind == "attachment" }
}

struct SessionFileContent: Codable, Identifiable, Sendable {
    var path: String
    var name: String
    var mimeType: String
    var size: Int
    var encoding: String
    var text: String?
    var data: String?
    var truncated: Bool?
    var binary: Bool?

    var isImage: Bool { mimeType.hasPrefix("image/") }
    /// RFC-023: PDF gets its own PDFKit render path.
    var isPDF: Bool { mimeType == "application/pdf" || name.lowercased().hasSuffix(".pdf") }

    var id: String { path }
}

/// Cumulative token usage for a Claude session (from `message.usage` on the
/// stream). `cacheRead + cacheCreation` show how prompt-cache-friendly the
/// session is — high values mean cheap follow-ups.
struct SessionUsage: Codable, Hashable, Sendable {
    var inputTokens: Int
    var outputTokens: Int
    var cacheReadTokens: Int
    var cacheCreationTokens: Int
    var turns: Int
    var updatedAt: String

    /// Cache hit percentage across the input side (0–100). Nil until the
    /// first turn records tokens.
    var cacheHitPercent: Double? {
        let denom = inputTokens + cacheReadTokens + cacheCreationTokens
        guard denom > 0 else { return nil }
        return Double(cacheReadTokens) / Double(denom) * 100
    }

    /// Compact chip label, e.g. "3.2k in · 850 out · 72% cache · 4 turns".
    var shortLabel: String {
        var parts: [String] = []
        parts.append("\(Self.formatTokens(inputTokens)) in")
        parts.append("\(Self.formatTokens(outputTokens)) out")
        if let pct = cacheHitPercent, pct >= 1 {
            parts.append("\(Int(pct.rounded()))% cache")
        }
        parts.append("\(turns) turn\(turns == 1 ? "" : "s")")
        return parts.joined(separator: " · ")
    }

    private static func formatTokens(_ n: Int) -> String {
        if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000) }
        if n >= 1_000 { return String(format: "%.1fk", Double(n) / 1_000) }
        return "\(n)"
    }
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
    var isAntigravity: Bool { source == "antigravity" || source == "agy" || source == "gemini" }
}

struct SessionsResponse: Codable, Sendable {
    let sessions: [SessionSummary]
    /// Soft-archived Dispatch chats (hidden from Active by default).
    var archivedSessions: [SessionSummary]?
    var diskSessions: [DiskSessionHint]?
    var claudeSessions: [DiskSessionHint]?
    var agySessions: [DiskSessionHint]?
    /// Echo of `?q=` when the host ran a content search.
    var query: String?
}

struct ProfilesResponse: Codable, Sendable {
    let profiles: [AgentProfile]
    var admin: Bool?
    var adminProfiles: [AdminAgentProfile]?
}

/// Full profile record from GET /profiles?admin=1 (this machine only).
struct AdminAgentProfile: Codable, Identifiable, Hashable, Sendable {
    let id: String
    var name: String
    var backend: String
    var color: String
    var model: String?
    var systemPrompt: String?
    var claudeConfigDir: String?
    var antigravityConfigDir: String?
    var env: [String: String]?
}

struct ProfileWriteBody: Codable, Sendable {
    var id: String?
    var name: String
    var backend: String
    var color: String?
    var model: String?
    var systemPrompt: String?
    var claudeConfigDir: String?
    var antigravityConfigDir: String?
    var env: [String: String]?
}

struct ProfileWriteResponse: Codable, Sendable {
    var profile: AgentProfile?
    var adminProfile: AdminAgentProfile?
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


struct ProfileLoginResponse: Codable, Sendable {
    let ok: Bool?
    let profileId: String?
    let backend: String?
    let message: String?
    let email: String?
    let alreadyRunning: Bool?
    let error: String?
}
