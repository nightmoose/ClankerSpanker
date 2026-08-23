import SwiftUI

struct SessionRowView: View {
    let session: SessionSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Title + profile stacked left; square status tile aligned to both lines on the right.
            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(session.title)
                        .font(.headline)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)

                    profileChip
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
