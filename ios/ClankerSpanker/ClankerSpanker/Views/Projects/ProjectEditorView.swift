import SwiftUI
#if os(macOS)
import AppKit
#endif

/// Create / edit form for a project. Reused for both new and existing projects.
/// Saves via `AppState.api` on the currently selected host.
struct ProjectEditorView: View {
    enum Mode {
        case new
        case edit(ProjectInfo)
    }

    let mode: Mode
    let host: HostEndpoint
    /// Called with the persisted project on success. Parent uses it to
    /// refresh its list and dismiss.
    var onSaved: (ProjectInfo) -> Void
    var onCancel: () -> Void

    @EnvironmentObject private var appState: AppState

    @State private var name: String = ""
    @State private var paths: [String] = [""]
    @State private var color: String = ""
    @State private var defaultProfileId: String = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    private var isEditing: Bool {
        if case .edit = mode { return true } else { return false }
    }

    private var canSave: Bool {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let anyPath = paths.contains { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        return !trimmedName.isEmpty && anyPath && !isSaving
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Name") {
                    // RFC-039: explicit label + prompt; the default macOS form
                    // used the placeholder as a left-hand label.
                    TextField("Name", text: $name, prompt: Text("e.g. Bricklayer"))
                        .labelsHidden()
                        #if os(iOS)
                        .textInputAutocapitalization(.words)
                        #endif
                        .disableAutocorrection(true)
                }

                Section {
                    ForEach(paths.indices, id: \.self) { idx in
                        HStack {
                            TextField("Path", text: bindingForPath(idx), prompt: Text("~/Projects/Foo"))
                                .labelsHidden()
                                .font(.system(.body, design: .monospaced))
                                .autocorrectionDisabled(true)
                                #if os(iOS)
                                .textInputAutocapitalization(.never)
                                #endif
                            #if os(macOS)
                            Button {
                                pickPath { picked in
                                    if !picked.isEmpty { paths[idx] = picked }
                                }
                            } label: {
                                Image(systemName: "folder")
                            }
                            .buttonStyle(.borderless)
                            #endif
                            if paths.count > 1 {
                                Button {
                                    paths.remove(at: idx)
                                } label: {
                                    Image(systemName: "minus.circle")
                                        .foregroundStyle(DispatchColors.danger)
                                }
                                .buttonStyle(.borderless)
                            }
                        }
                    }
                    Button {
                        paths.append("")
                    } label: {
                        Label("Add path", systemImage: "plus.circle")
                    }
                } header: {
                    Text("Paths")
                } footer: {
                    Text("Sessions started under this project can pick any of these as their working directory. Add a companion repo, docs folder, etc.")
                        .font(.caption2)
                }

                Section {
                    Picker("Default profile", selection: $defaultProfileId) {
                        Text("None").tag("")
                        ForEach(profileChoices, id: \.id) { bound in
                            Text(bound.displayName).tag(bound.profile.id)
                        }
                    }
                    TextField("Accent color", text: $color, prompt: Text("#73B8FF"))
                        .font(.system(.body, design: .monospaced))
                        .autocorrectionDisabled(true)
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                } header: {
                    Text("Optional")
                } footer: {
                    Text("Default profile is a suggestion — you can override when starting a session.")
                        .font(.caption2)
                }

                // Attachments — only meaningful for an existing project.
                if case .edit(let editing) = mode {
                    ProjectAttachmentsSection(project: editing, host: host)
                        .environmentObject(appState)
                }

                if let err = errorMessage {
                    Section {
                        Text(err)
                            .font(.caption)
                            .foregroundStyle(DispatchColors.danger)
                    }
                }
            }
            #if os(macOS)
            .formStyle(.grouped)
            .frame(minWidth: 520, minHeight: 440)
            #endif
            .navigationTitle(isEditing ? "Edit project" : "New project")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { onCancel() }
                        .disabled(isSaving)
                }
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        Task { await save() }
                    } label: {
                        if isSaving {
                            ProgressView().controlSize(.small)
                        } else {
                            Text(isEditing ? "Save" : "Create")
                                .fontWeight(.semibold)
                        }
                    }
                    .disabled(!canSave)
                }
            }
        }
        .onAppear(perform: prime)
    }

    // MARK: - Prime from mode

    private func prime() {
        switch mode {
        case .new:
            if name.isEmpty { name = "" }
            if paths.isEmpty { paths = [""] }
        case .edit(let p):
            name = p.name
            paths = p.effectivePaths.isEmpty ? [""] : p.effectivePaths
            color = p.color ?? ""
            defaultProfileId = p.defaultProfileId ?? ""
        }
    }

    // MARK: - Save

    private func save() async {
        errorMessage = nil
        isSaving = true
        defer { isSaving = false }
        let cleanedPaths = paths
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        let cleanedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanedColor = color.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanedProfile = defaultProfileId.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let saved: ProjectInfo
            switch mode {
            case .new:
                saved = try await appState.api.createProject(
                    name: cleanedName,
                    paths: cleanedPaths,
                    color: cleanedColor.isEmpty ? nil : cleanedColor,
                    defaultProfileId: cleanedProfile.isEmpty ? nil : cleanedProfile,
                    host: host
                )
            case .edit(let p):
                saved = try await appState.api.updateProject(
                    id: p.id,
                    name: cleanedName,
                    paths: cleanedPaths,
                    color: cleanedColor.isEmpty ? nil : cleanedColor,
                    defaultProfileId: cleanedProfile.isEmpty ? nil : cleanedProfile,
                    host: host
                )
            }
            onSaved(saved)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - Bindings / helpers

    private func bindingForPath(_ idx: Int) -> Binding<String> {
        Binding(
            get: { paths.indices.contains(idx) ? paths[idx] : "" },
            set: { paths[idx] = $0 }
        )
    }

    private var profileChoices: [BoundProfile] {
        appState.boundProfiles.filter { $0.host.endpointKey == host.endpointKey }
    }

    #if os(macOS)
    private func pickPath(_ done: @escaping (String) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        if panel.runModal() == .OK, let url = panel.url {
            done(url.path)
        }
    }
    #endif
}
