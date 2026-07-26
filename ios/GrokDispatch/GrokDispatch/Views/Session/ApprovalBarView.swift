import SwiftUI

struct ApprovalBarView: View {
    let approval: PendingApproval?
    @Binding var comment: String
    var isActing: Bool
    let onApprove: () -> Void
    let onReject: () -> Void

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

            TextField("Optional comment…", text: $comment)
                .padding(10)
                .background(Color.white.opacity(0.08))
                .clipShape(RoundedRectangle(cornerRadius: 10))

            HStack(spacing: 12) {
                DispatchButton(
                    title: "Reject",
                    icon: "xmark",
                    style: .danger,
                    isLoading: isActing,
                    action: onReject
                )
                DispatchButton(
                    title: "Approve",
                    icon: "checkmark",
                    style: .primary,
                    isLoading: isActing,
                    action: onApprove
                )
            }
        }
        .padding()
        .background(.ultraThinMaterial)
    }
}
