import SwiftUI

/// Per-session Tasks + Notes surface, rendered as one of the SessionDetailView tabs.
struct SessionNotesTab: View {
    let detail: SessionDetail
    let host: HostEndpoint
    var onJumpToMessage: (String) -> Void

    @EnvironmentObject private var appState: AppState
    @State private var errorMessage: String?
    @State private var editingNote: SessionNote?
    @State private var editingNoteText: String = ""

    private var openTasks: [SessionTask] {
        (detail.tasks ?? []).filter { !$0.isDone }.sorted { $0.createdAt > $1.createdAt }
    }
    private var doneTasks: [SessionTask] {
        (detail.tasks ?? []).filter { $0.isDone }
            .sorted { ($0.completedAt ?? $0.createdAt) > ($1.completedAt ?? $1.createdAt) }
    }
    private var notes: [SessionNote] {
        (detail.notes ?? []).sorted { $0.createdAt > $1.createdAt }
    }

    var body: some View {
        LazyVStack(alignment: .leading, spacing: 12) {
            if let err = errorMessage {
                Text(err).font(.caption).foregroundStyle(DispatchColors.danger)
            }

            sectionHeader("Open (\(openTasks.count))")
            if openTasks.isEmpty {
                emptyLine("No open todos. Long-press any message to capture one.")
            } else {
                ForEach(openTasks) { task in
                    taskRow(task)
                }
            }

            if !doneTasks.isEmpty {
                sectionHeader("Done (\(doneTasks.count))")
                ForEach(doneTasks) { task in taskRow(task) }
            }

            sectionHeader("Notes (\(notes.count))")
            if notes.isEmpty {
                emptyLine("No notes yet.")
            } else {
                ForEach(notes) { note in noteRow(note) }
            }
        }
        .sheet(item: $editingNote) { note in editNoteSheet(note) }
    }

    private func taskRow(_ task: SessionTask) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Button {
                Task { await toggle(task) }
            } label: {
                Image(systemName: task.isDone ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(task.isDone ? DispatchColors.accent : .secondary)
                    .font(.body)
            }
            .buttonStyle(.plain)

            VStack(alignment: .leading, spacing: 3) {
                Text(task.text)
                    .font(.body)
                    .strikethrough(task.isDone)
                    .foregroundStyle(task.isDone ? .secondary : .primary)
                    .lineLimit(nil)
                    .fixedSize(horizontal: false, vertical: true)
                if let mid = task.sourceMessageId {
                    Button {
                        onJumpToMessage(mid)
                    } label: {
                        Label("Jump to message", systemImage: "arrow.up.right")
                            .font(.caption2)
                            .foregroundStyle(DispatchColors.accent)
                    }
                    .buttonStyle(.plain)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(10)
        .background(Color.white.opacity(0.05))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .contextMenu {
            Button(role: .destructive) {
                Task { await delete(task) }
            } label: { Label("Delete", systemImage: "trash") }
        }
    }

    private func noteRow(_ note: SessionNote) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(note.text)
                .font(.body)
                .textSelection(.enabled)
            HStack(spacing: 8) {
                if let mid = note.sourceMessageId {
                    Button {
                        onJumpToMessage(mid)
                    } label: {
                        Label("Jump to message", systemImage: "arrow.up.right")
                            .font(.caption2)
                            .foregroundStyle(DispatchColors.accent)
                    }
                    .buttonStyle(.plain)
                }
                Spacer()
                Button {
                    editingNoteText = note.text
                    editingNote = note
                } label: {
                    Image(systemName: "pencil").font(.caption)
                }
                .buttonStyle(.plain)
                Button {
                    Task { await deleteNote(note) }
                } label: {
                    Image(systemName: "trash").font(.caption).foregroundStyle(DispatchColors.danger)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(10)
        .background(Color.white.opacity(0.05))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func sectionHeader(_ text: String) -> some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
            .padding(.top, 6)
    }

    private func emptyLine(_ text: String) -> some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(.secondary)
            .padding(8)
    }

    private func editNoteSheet(_ note: SessionNote) -> some View {
        NavigationStack {
            Form {
                Section { TextEditor(text: $editingNoteText).frame(minHeight: 220) }
            }
            .navigationTitle("Edit note")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { editingNote = nil }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button("Save") {
                        Task { await commitEdit(note) }
                    }
                    .fontWeight(.semibold)
                }
            }
        }
    }

    private func toggle(_ task: SessionTask) async {
        do {
            _ = try await appState.api.updateTask(
                sessionId: task.sourceSessionId,
                taskId: task.id,
                status: task.isDone ? "open" : "done",
                host: host
            )
        } catch { errorMessage = error.localizedDescription }
    }

    private func delete(_ task: SessionTask) async {
        do {
            try await appState.api.deleteTask(
                sessionId: task.sourceSessionId,
                taskId: task.id,
                host: host
            )
        } catch { errorMessage = error.localizedDescription }
    }

    private func deleteNote(_ note: SessionNote) async {
        do {
            try await appState.api.deleteNote(
                sessionId: note.sourceSessionId,
                noteId: note.id,
                host: host
            )
        } catch { errorMessage = error.localizedDescription }
    }

    private func commitEdit(_ note: SessionNote) async {
        let text = editingNoteText.trimmingCharacters(in: .whitespacesAndNewlines)
        editingNote = nil
        guard !text.isEmpty, text != note.text else { return }
        do {
            _ = try await appState.api.updateNote(
                sessionId: note.sourceSessionId,
                noteId: note.id,
                text: text,
                host: host
            )
        } catch { errorMessage = error.localizedDescription }
    }
}
