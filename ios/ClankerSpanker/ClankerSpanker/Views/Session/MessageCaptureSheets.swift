import SwiftUI

struct SaveAsTodoSheet: View {
    let sourceMessageId: String?
    let initialText: String
    let sessionId: String
    let host: HostEndpoint
    var onSaved: (SessionTask) -> Void
    var onCancel: () -> Void

    @EnvironmentObject private var appState: AppState
    @State private var text: String
    @State private var isSaving = false
    @State private var errorMessage: String?

    init(
        sourceMessageId: String?,
        initialText: String,
        sessionId: String,
        host: HostEndpoint,
        onSaved: @escaping (SessionTask) -> Void,
        onCancel: @escaping () -> Void
    ) {
        self.sourceMessageId = sourceMessageId
        self.initialText = initialText
        self.sessionId = sessionId
        self.host = host
        self.onSaved = onSaved
        self.onCancel = onCancel
        _text = State(initialValue: initialText)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextEditor(text: $text)
                        .font(.body)
                        .frame(minHeight: 180)
                } footer: {
                    Text("Keep the full message if you’ll need the context. Jump from Tasks still opens the original.").font(.caption2)
                }
                if let err = errorMessage {
                    Section { Text(err).font(.caption).foregroundStyle(DispatchColors.danger) }
                }
            }
            .navigationTitle("Save as todo")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel).disabled(isSaving)
                }
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        Task { await save() }
                    } label: {
                        if isSaving { ProgressView().controlSize(.small) }
                        else { Text("Save").fontWeight(.semibold) }
                    }
                    .disabled(isSaving || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }

    private func save() async {
        errorMessage = nil
        isSaving = true
        defer { isSaving = false }
        do {
            let task = try await appState.api.createTask(
                sessionId: sessionId,
                text: text,
                sourceMessageId: sourceMessageId,
                host: host
            )
            onSaved(task)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

struct ScanForTodoSheet: View {
    let sourceMessageId: String?
    let sourceText: String
    let sessionId: String
    let host: HostEndpoint
    var onSaved: ([SessionTask]) -> Void
    var onCancel: () -> Void

    @EnvironmentObject private var appState: AppState
    @State private var candidates: [Candidate] = []
    @State private var isSaving = false
    @State private var errorMessage: String?

    private struct Candidate: Identifiable, Equatable {
        let id = UUID()
        var text: String
        var selected: Bool
    }

    var body: some View {
        NavigationStack {
            Form {
                if candidates.isEmpty {
                    Section {
                        Text("No todo-shaped lines found. Try “Save as todo” to capture the whole message.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                } else {
                    Section {
                        ForEach($candidates) { $c in
                            Button {
                                c.selected.toggle()
                            } label: {
                                HStack(alignment: .top, spacing: 10) {
                                    Image(systemName: c.selected ? "checkmark.circle.fill" : "circle")
                                        .foregroundStyle(c.selected ? DispatchColors.accent : .secondary)
                                        .padding(.top, 2)
                                    Text(c.text)
                                        .font(.body)
                                        .foregroundStyle(.primary)
                                        .multilineTextAlignment(.leading)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    } footer: {
                        Text("Uncheck anything that isn't a todo. Selected items each become their own task.")
                            .font(.caption2)
                    }
                }
                if let err = errorMessage {
                    Section { Text(err).font(.caption).foregroundStyle(DispatchColors.danger) }
                }
            }
            .navigationTitle("Scan for todo")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel).disabled(isSaving)
                }
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        Task { await saveSelected() }
                    } label: {
                        if isSaving { ProgressView().controlSize(.small) }
                        else {
                            Text("Save \(candidates.filter(\.selected).count)")
                                .fontWeight(.semibold)
                        }
                    }
                    .disabled(isSaving || candidates.allSatisfy { !$0.selected })
                }
            }
        }
        .onAppear {
            candidates = Self.extractCandidates(from: sourceText).map {
                Candidate(text: $0, selected: true)
            }
        }
    }

    private func saveSelected() async {
        errorMessage = nil
        isSaving = true
        defer { isSaving = false }
        var created: [SessionTask] = []
        for c in candidates where c.selected {
            do {
                let task = try await appState.api.createTask(
                    sessionId: sessionId,
                    text: c.text,
                    sourceMessageId: sourceMessageId,
                    host: host
                )
                created.append(task)
            } catch {
                errorMessage = error.localizedDescription
                break
            }
        }
        if !created.isEmpty { onSaved(created) }
    }

    static func extractCandidates(from text: String) -> [String] {
        var candidates: [String] = []
        var inTodoBlock = false
        let headingRegex = try? NSRegularExpression(
            pattern: #"^\s*(next steps|todo|to do|action items|things to do|what you need to do)\s*:?\s*$"#,
            options: [.caseInsensitive]
        )
        let listItemRegex = try? NSRegularExpression(
            pattern: #"^\s*(?:[-*•]|\d+[\.\)])\s+(?:\[[ xX]\]\s+)?(.+?)\s*$"#
        )
        let lines = text.components(separatedBy: .newlines)
        for line in lines {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { inTodoBlock = false; continue }

            if let re = headingRegex,
               re.firstMatch(in: trimmed, range: NSRange(trimmed.startIndex..., in: trimmed)) != nil
            {
                inTodoBlock = true
                continue
            }

            if let re = listItemRegex {
                let nsrange = NSRange(line.startIndex..., in: line)
                if let match = re.firstMatch(in: line, range: nsrange),
                   let range = Range(match.range(at: 1), in: line)
                {
                    let item = String(line[range]).trimmingCharacters(in: .whitespaces)
                    if !item.isEmpty { candidates.append(item) }
                    continue
                }
            }

            if inTodoBlock {
                candidates.append(trimmed)
            }
        }
        var seen = Set<String>()
        return candidates.filter { seen.insert($0).inserted }
    }
}

struct MakeNoteSheet: View {
    let sourceMessageId: String?
    let sessionId: String
    let host: HostEndpoint
    var onSaved: (SessionNote) -> Void
    var onCancel: () -> Void

    @EnvironmentObject private var appState: AppState
    @State private var text: String = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextEditor(text: $text)
                        .font(.body)
                        .frame(minHeight: 220)
                } footer: {
                    Text("Anything you want to remember about this message. Notes live in the session's Notes tab.")
                        .font(.caption2)
                }
                if let err = errorMessage {
                    Section { Text(err).font(.caption).foregroundStyle(DispatchColors.danger) }
                }
            }
            .navigationTitle("Add note")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel).disabled(isSaving)
                }
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        Task { await save() }
                    } label: {
                        if isSaving { ProgressView().controlSize(.small) }
                        else { Text("Save").fontWeight(.semibold) }
                    }
                    .disabled(isSaving || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }

    private func save() async {
        errorMessage = nil
        isSaving = true
        defer { isSaving = false }
        do {
            let note = try await appState.api.createNote(
                sessionId: sessionId,
                text: text,
                sourceMessageId: sourceMessageId,
                host: host
            )
            onSaved(note)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
