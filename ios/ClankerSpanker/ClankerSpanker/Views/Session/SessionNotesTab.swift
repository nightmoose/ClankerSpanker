import SwiftUI

/// Per-session Tasks + Notes surface, rendered as one of the SessionDetailView tabs.
struct SessionNotesTab: View {
    let detail: SessionDetail
    let host: HostEndpoint
    var projects: [ProjectInfo] = []
    var onJumpToMessage: (String) -> Void
    var onOpenLocalFile: ((String) -> Void)? = nil

    @EnvironmentObject private var appState: AppState
    @State private var errorMessage: String?
    @State private var editingNote: SessionNote?
    @State private var editingNoteText: String = ""
    @State private var files: [SessionFileEntry] = []
    @State private var filesLoading = false
    @State private var viewing: SessionFileContent?
    @State private var showExtraFolders = false

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

            filesSection
        }
        .sheet(item: $editingNote) { note in editNoteSheet(note) }
        .sheet(item: $viewing) { content in
            SessionFileViewer(content: content) { viewing = nil }
        }
        .sheet(isPresented: $showExtraFolders) {
            ExtraFoldersSheet(
                projects: projects,
                cwd: detail.cwd,
                already: detail.effectiveExtraDirs,
                onAdd: { paths in Task { await addExtraDirs(paths) } }
            )
        }
        .task(id: detail.id) { await loadFiles() }
        .onChange(of: detail.updatedAt) { _, _ in
            Task { await loadFiles() }
        }
    }

    private var filesSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                sectionHeader("Files (\(files.count))")
                Spacer()
                Button {
                    #if os(macOS)
                    pickMacExtraFolders()
                    #else
                    showExtraFolders = true
                    #endif
                } label: {
                    Label("Add folders", systemImage: "folder.badge.plus")
                        .font(.caption)
                }
                .buttonStyle(.plain)
            }
            if filesLoading && files.isEmpty {
                ProgressView().controlSize(.small)
            } else if files.isEmpty {
                emptyLine("No files yet. Tool paths, extra folders, and attachments show up here.")
            } else {
                ForEach(files) { file in
                    fileRow(file)
                }
            }
        }
    }

    private func fileRow(_ file: SessionFileEntry) -> some View {
        Button {
            openFile(file)
        } label: {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: file.isFolder ? "folder" : (file.isAttachment ? "paperclip" : "doc.text"))
                    .foregroundStyle(.secondary)
                    .frame(width: 16)
                VStack(alignment: .leading, spacing: 2) {
                    Text(file.title ?? (file.path as NSString).lastPathComponent)
                        .font(.subheadline)
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    Text(file.path)
                        .font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: 0)
            }
            .padding(10)
            .background(Color.white.opacity(0.05))
            .clipShape(RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
        #if os(iOS)
        .disabled(file.isFolder)
        #endif
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

    private func loadFiles() async {
        filesLoading = true
        defer { filesLoading = false }
        do {
            files = try await appState.api.sessionFiles(id: detail.id, host: host)
            errorMessage = nil
        } catch { errorMessage = error.localizedDescription }
    }

    private func openFile(_ file: SessionFileEntry) {
        #if os(macOS)
        onOpenLocalFile?(file.path)
        #else
        guard !file.isFolder else { return }
        Task {
            do {
                viewing = try await appState.api.sessionFile(id: detail.id, path: file.path, host: host)
            } catch { errorMessage = error.localizedDescription }
        }
        #endif
    }

    private func addExtraDirs(_ paths: [String]) async {
        guard !paths.isEmpty else { return }
        do {
            _ = try await appState.api.addExtraDirs(sessionId: detail.id, extraDirs: paths, host: host)
            await loadFiles()
        } catch { errorMessage = error.localizedDescription }
    }

    #if os(macOS)
    private func pickMacExtraFolders() {
        let urls = FolderPicker.pickDirectories(
            message: "Add extra workspace folders this session may use",
            prompt: "Add"
        )
        let paths = urls.map(\.path).filter { $0 != detail.cwd }
        guard !paths.isEmpty else { return }
        Task { await addExtraDirs(paths) }
    }
    #endif

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
