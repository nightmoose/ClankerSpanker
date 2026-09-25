import SwiftUI

/// RFC-021 per-session Grok credit meter. Green < 5%, amber ≥ 5%, red ≥ 10%.
/// Grok-only; other backends carry `nil` and no badge is drawn.
enum SessionCreditMeter {
    struct Badge {
        let label: String
        let tooltip: String
        let color: Color
    }

    static func badge(for delta: Double?) -> Badge? {
        guard let delta, delta.isFinite else { return nil }
        let rounded = delta < 1 ? String(format: "%.1f", delta) : "\(Int(delta.rounded()))"
        let color: Color
        let tooltip: String
        if delta >= 10 {
            color = .red
            tooltip = "This chat has burned \(rounded)% of the weekly Grok plan. Consider reincarnating."
        } else if delta >= 5 {
            color = .orange
            tooltip = "This chat has burned \(rounded)% of the weekly Grok plan. Consider reincarnating."
        } else {
            color = .green
            tooltip = "This chat has burned \(rounded)% of the weekly Grok plan."
        }
        return Badge(label: "wk +\(rounded)%", tooltip: tooltip, color: color)
    }
}

struct SessionRowView: View {
    let session: SessionSummary
    @EnvironmentObject private var appState: AppState

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Title + profile stacked left; square status tile aligned to both lines on the right.
            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(session.title)
                        .font(.headline)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)

                    HStack(spacing: 6) {
                        profileChip
                        // RFC-024: host chip so cross-host sessions are
                        // visually distinguishable. Single-host installs
                        // show nothing (no regression on the common case).
                        hostChip
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                StatusBadge(status: session.status, compact: true)
                    .layoutPriority(1)
            }

            if let preview = session.transcriptPreview, !preview.isEmpty {
                Text(preview)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            } else {
                Text(session.prompt)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }

            HStack(spacing: 12) {
                Label(shortPath(session.cwd), systemImage: "folder")
                if session.planMode {
                    Label("Plan", systemImage: "list.bullet.rectangle")
                }
                if session.toolCallCount > 0 {
                    Label("\(session.toolCallCount)", systemImage: "wrench.and.screwdriver")
                }
                if let badge = SessionCreditMeter.badge(for: session.creditsUsedDeltaPct) {
                    Text(badge.label)
                        .font(.caption2.weight(.bold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .foregroundStyle(badge.color)
                        .background(badge.color.opacity(0.15))
                        .clipShape(Capsule())
                        .help(badge.tooltip)
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private var profileChip: some View {
        if let name = session.profileName, !name.isEmpty {
            Text(name)
                .font(.caption2.weight(.bold))
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .foregroundStyle(profileColor)
                .background(profileColor.opacity(0.15))
                .clipShape(Capsule())
        } else if session.backend == "antigravity"
            || session.model.lowercased().contains("gemini")
            || session.model.lowercased().contains("antigravity")
        {
            Text("Agy")
                .font(.caption2.weight(.bold))
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .foregroundStyle(Color(red: 0.20, green: 0.66, blue: 0.33))
                .background(Color(red: 0.20, green: 0.66, blue: 0.33).opacity(0.15))
                .clipShape(Capsule())
        } else if session.backend == "bot" {
            Text("Bot")
                .font(.caption2.weight(.bold))
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .foregroundStyle(Color(red: 0.91, green: 0.47, blue: 0.98))
                .background(Color(red: 0.91, green: 0.47, blue: 0.98).opacity(0.15))
                .clipShape(Capsule())
        } else if session.backend == "claude" || session.model.lowercased().contains("claude") {
            Text("Claude")
                .font(.caption2.weight(.bold))
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .foregroundStyle(Color.orange)
                .background(Color.orange.opacity(0.15))
                .clipShape(Capsule())
        }
    }

    /// Small trailing capsule with the session's host name (RFC-024). Only
    /// shows when the user has multiple hosts registered — a solo-host
    /// setup keeps rows uncluttered.
    @ViewBuilder
    private var hostChip: some View {
        if appState.hosts.count > 1,
           let raw = session.hostId,
           let uuid = UUID(uuidString: raw),
           let host = appState.hosts.first(where: { $0.id == uuid }) {
            Text(host.name)
                .font(.caption2.weight(.semibold))
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .foregroundStyle(.secondary)
                .background(Color.secondary.opacity(0.12))
                .clipShape(Capsule())
        }
    }

    private var profileColor: Color {
        Color(hex: session.profileColor ?? "")
            ?? (session.backend == "bot"
                ? Color(red: 0.91, green: 0.47, blue: 0.98)
                : session.backend == "claude"
                    ? Color.orange
                    : session.backend == "antigravity"
                        ? Color(red: 0.20, green: 0.66, blue: 0.33)
                        : DispatchColors.accent)
    }

    private func shortPath(_ path: String) -> String {
        if let range = path.range(of: "/Projects/") {
            return String(path[range.upperBound...])
        }
        return (path as NSString).lastPathComponent
    }
}
