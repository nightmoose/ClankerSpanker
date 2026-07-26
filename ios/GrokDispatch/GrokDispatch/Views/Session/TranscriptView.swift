import SwiftUI

struct TranscriptView: View {
    let entries: [TranscriptEntry]
    var streaming: String = ""

    /// Newest first so the latest turn is visible without scrolling to the bottom.
    private var ordered: [TranscriptEntry] {
        entries.reversed()
    }

    var body: some View {
        LazyVStack(alignment: .leading, spacing: 12) {
            if !streaming.isEmpty {
                bubble(role: "assistant", text: streaming)
            }
            ForEach(ordered) { entry in
                bubble(role: entry.role, text: entry.text)
            }
        }
    }

    private func bubble(role: String, text: String) -> some View {
        HStack {
            if role == "user" { Spacer(minLength: 40) }
            VStack(alignment: .leading, spacing: 4) {
                Text(roleLabel(role))
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text(text)
                    .font(.body)
                    .textSelection(.enabled)
            }
            .padding(12)
            .background(background(for: role))
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            if role != "user" { Spacer(minLength: 24) }
        }
    }

    private func roleLabel(_ role: String) -> String {
        switch role {
        case "user": return "You"
        case "assistant": return "Grok"
        case "thought": return "Thinking"
        case "system": return "System"
        default: return role.capitalized
        }
    }

    private func background(for role: String) -> Color {
        switch role {
        case "user": return DispatchColors.accent.opacity(0.2)
        case "system": return DispatchColors.warning.opacity(0.15)
        case "thought": return Color.white.opacity(0.04)
        default: return Color.white.opacity(0.08)
        }
    }
}
