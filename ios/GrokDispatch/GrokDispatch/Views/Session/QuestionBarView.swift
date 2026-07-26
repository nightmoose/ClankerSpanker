import SwiftUI

struct QuestionBarView: View {
    let pending: PendingQuestion
    @Binding var selectedAnswers: [Int: String]
    @Binding var comment: String
    var isActing: Bool
    let onSubmit: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Image(systemName: "questionmark.bubble.fill")
                    .foregroundStyle(DispatchColors.accentSecondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(pending.title)
                        .font(.headline)
                    Text("Grok is blocked until you answer.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }

            ForEach(Array(pending.questions.enumerated()), id: \.offset) { idx, q in
                VStack(alignment: .leading, spacing: 8) {
                    Text(q.question)
                        .font(.subheadline.weight(.semibold))

                    if q.options.isEmpty {
                        TextField("Your answer…", text: binding(for: idx))
                            .padding(10)
                            .background(Color.white.opacity(0.08))
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                    } else {
                        ForEach(q.options, id: \.label) { opt in
                            Button {
                                selectedAnswers[idx] = opt.label
                            } label: {
                                HStack(alignment: .top, spacing: 10) {
                                    Image(systemName: selectedAnswers[idx] == opt.label
                                          ? "checkmark.circle.fill"
                                          : "circle")
                                        .foregroundStyle(
                                            selectedAnswers[idx] == opt.label
                                            ? DispatchColors.accent
                                            : .secondary
                                        )
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(opt.label)
                                            .font(.subheadline.weight(.semibold))
                                            .foregroundStyle(.primary)
                                            .multilineTextAlignment(.leading)
                                        if let d = opt.description, !d.isEmpty {
                                            Text(d)
                                                .font(.caption)
                                                .foregroundStyle(.secondary)
                                                .multilineTextAlignment(.leading)
                                        }
                                    }
                                    Spacer(minLength: 0)
                                }
                                .padding(12)
                                .background(
                                    selectedAnswers[idx] == opt.label
                                    ? DispatchColors.accent.opacity(0.15)
                                    : Color.white.opacity(0.06)
                                )
                                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }

            TextField("Optional extra notes…", text: $comment)
                .padding(10)
                .background(Color.white.opacity(0.08))
                .clipShape(RoundedRectangle(cornerRadius: 10))

            DispatchButton(
                title: isActing ? "Sending…" : "Submit answers",
                icon: "paperplane.fill",
                isLoading: isActing,
                action: onSubmit
            )
        }
        .padding()
        .background(.ultraThinMaterial)
    }

    private func binding(for idx: Int) -> Binding<String> {
        Binding(
            get: { selectedAnswers[idx] ?? "" },
            set: { selectedAnswers[idx] = $0 }
        )
    }
}
