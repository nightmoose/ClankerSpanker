import SwiftUI

struct SessionRowView: View {
    let session: SessionSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(session.title)
                    .font(.headline)
                    .lineLimit(1)
                Spacer()
                if session.model.lowercased().contains("claude") {
                    Text("Claude")
                        .font(.caption2.weight(.bold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .foregroundStyle(Color.orange)
                        .background(Color.orange.opacity(0.15))
                        .clipShape(Capsule())
                }
                StatusBadge(status: session.status)
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

    private func shortPath(_ path: String) -> String {
        if let range = path.range(of: "/Projects/") {
            return String(path[range.upperBound...])
        }
        return (path as NSString).lastPathComponent
    }
}
