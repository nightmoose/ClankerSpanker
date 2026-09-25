import SwiftUI

struct ApprovalBarView: View {
    let approval: PendingApproval?
    @Binding var comment: String
    var isActing: Bool
    let onApprove: () -> Void
    let onReject: () -> Void
    /// Optional — when present, renders the "Always this session" button.
    var onApproveAlways: (() -> Void)? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Image(systemName: "hand.raised.fill")
                    .foregroundStyle(DispatchColors.warning)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Approval required")
                        .font(.headline)
                    Text(approval?.title ?? "Grok wants to run a tool")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer()
                if let kind = approval?.kind {
                    Text(kind)
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(DispatchColors.warning.opacity(0.2))
                        .clipShape(Capsule())
                }
            }

            if let preview = approval?.preview {
                ApprovalPreviewView(preview: preview)
            } else if let raw = approval?.rawInput {
                VStack(alignment: .leading, spacing: 6) {
                    if let to = raw.to, !to.isEmpty {
                        Text("\(raw.channel ?? "outbound") → \(to)")
                            .font(.caption.weight(.semibold))
                    }
                    if let reason = raw.reason, !reason.isEmpty {
                        Text(reason)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    if let body = raw.body ?? raw.content, !body.isEmpty {
                        Text(body)
                            .font(.system(.footnote, design: .monospaced))
                            .textSelection(.enabled)
                            .lineLimit(12)
                    }
                    if let path = raw.path, !path.isEmpty {
                        Text(path)
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.white.opacity(0.05))
                .clipShape(RoundedRectangle(cornerRadius: 10))
            }

            TextField("Optional comment…", text: $comment)
                .padding(10)
                .background(Color.white.opacity(0.08))
                .clipShape(RoundedRectangle(cornerRadius: 10))

            HStack(spacing: 12) {
                // isActing only while THIS approve/reject is in flight — never while the agent turn is still open.
                DispatchButton(
                    title: "Reject",
                    icon: "xmark",
                    style: .danger,
                    isLoading: isActing,
                    action: onReject
                )
                .disabled(isActing)
                DispatchButton(
                    title: "Approve",
                    icon: "checkmark",
                    style: .primary,
                    isLoading: isActing,
                    action: onApprove
                )
                .disabled(isActing)
            }

            if let onApproveAlways {
                // Secondary "trust this tool for the rest of the session"
                // action. Smaller than the primary Approve to hint at the
                // broader scope; still one-tap so it stays useful.
                Button {
                    onApproveAlways()
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "checkmark.seal.fill")
                            .font(.caption)
                        Text("Approve always this session")
                            .font(.caption.weight(.semibold))
                    }
                    .foregroundStyle(DispatchColors.accent)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                    .background(DispatchColors.accent.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(isActing)
                .help("Auto-approve this exact tool + target for the rest of this session.")
            }
        }
        .padding()
        .background(.ultraThinMaterial)
    }
}


/// Diff (red/green lines) or command preview on the approval card (RFC-033).
struct ApprovalPreviewView: View {
    let preview: ApprovalPreview

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let path = preview.path, !path.isEmpty {
                Text((path as NSString).lastPathComponent)
                    .font(.caption.weight(.semibold))
                    .help(path)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                        Text(line.text.isEmpty ? " " : line.text)
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(line.color)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(line.background)
                    }
                }
                .textSelection(.enabled)
            }
            .frame(maxHeight: 220)
            if preview.truncated == true {
                Text("Preview truncated — see the Diff tab for everything.")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            if preview.type == "command", let cwd = preview.cwd, !cwd.isEmpty {
                Text("in \(cwd)")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.white.opacity(0.05))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private struct Line {
        let text: String
        let color: Color
        let background: Color
    }

    private var lines: [Line] {
        if preview.type == "command" {
            return (preview.command ?? "").components(separatedBy: "\n").enumerated().map { i, l in
                Line(text: (i == 0 ? "$ " : "  ") + l, color: .primary, background: .clear)
            }
        }
        let removed = (preview.oldText ?? "").isEmpty ? [] : (preview.oldText ?? "").components(separatedBy: "\n")
        let added = (preview.newText ?? "").isEmpty ? [] : (preview.newText ?? "").components(separatedBy: "\n")
        return removed.map { Line(text: "- " + $0, color: DispatchColors.danger, background: DispatchColors.danger.opacity(0.08)) }
            + added.map { Line(text: "+ " + $0, color: DispatchColors.success, background: DispatchColors.success.opacity(0.08)) }
    }
}
