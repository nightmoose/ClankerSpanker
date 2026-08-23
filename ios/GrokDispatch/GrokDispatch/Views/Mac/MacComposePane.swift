#if os(macOS)
import SwiftUI
import AppKit
import UniformTypeIdentifiers

/// Desktop compose form used in the New Session sheet.
struct MacComposePane: View {
    @EnvironmentObject private var appState: AppState
    @StateObject private var vm = ComposerViewModel()
    @State private var status: String?
    @State private var projectNote: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let bound = appState.selectedBoundProfile {
                    HStack(spacing: 10) {
                        Circle()
                            .fill(bound.uiColor)
                            .frame(width: 10, height: 10)
                        Text("\(bound.displayName) · \(bound.backendLabel) · \(bound.hostLabel)")
                            .font(.subheadline.weight(.medium))
                    }
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 8).fill(bound.uiColor.opacity(0.12)))
                } else {
                    Text("No profile yet — connect a host first.")
                        .foregroundStyle(.secondary)
                }

                GroupBox("Task") {
                    VStack(alignment: .leading, spacing: 12) {
                        TextField("Optional title", text: $vm.title)
                            .textFieldStyle(.roundedBorder)
                        Text("Prompt")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                        TextEditor(text: $vm.prompt)
                            .font(.body)
                            .frame(minHeight: 140)
                            .padding(8)
                            .background(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.primary.opacity(0.12)))
                    }
                    .padding(6)
                }

                GroupBox("Screenshots") {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Attach up to 4 images on the first turn — same as follow-up. Useful for “here’s the bug, fix it.”")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        if !vm.pendingImages.isEmpty {
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 8) {
                                    ForEach(vm.pendingImages) { att in
                                        ZStack(alignment: .topTrailing) {
                                            Image(platformImage: att.preview)
                                                .resizable()
                                                .scaledToFill()
                                                .frame(width: 64, height: 64)
                                                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                                            Button {
                                                vm.removeImage(id: att.id)
                                            } label: {
                                                Image(systemName: "xmark.circle.fill")
                                                    .symbolRenderingMode(.palette)
                                                    .foregroundStyle(.white, .black.opacity(0.65))
                                            }
                                            .offset(x: 6, y: -6)
                                        }
                                    }
                                }
                                .padding(.vertical, 2)
                            }
                        }
                        Button {
                            pickImageFilesFromDisk()
                        } label: {
                            Label("Attach images…", systemImage: "paperclip")
                        }
                        .disabled(vm.isSubmitting || vm.pendingImages.count >= 4)
                    }
                    .padding(6)
                }

                GroupBox("Working directory") {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Where the agent runs on the host. Prefer registered projects; custom paths work when the host allows them.")
                            .font(.caption)
                            .foregroundStyle(.secondary)

                        if vm.projects.isEmpty {
                            Text("No projects on host yet — add folders below.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        } else {
                            Picker("Project", selection: $vm.selectedProjectId) {
                                Text("—").tag(Optional<String>.none)
                                ForEach(vm.projects) { p in
                                    Text("\(p.name) — \(p.path)").tag(Optional(p.id))
                                }
                            }
                        }

                        HStack(spacing: 8) {
                            Button {
                                addProjectFolders()
                            } label: {
                                Label("Add folders…", systemImage: "folder.badge.plus")
                            }
                            Button {
                                pickCwdOnce()
                            } label: {
                                Label("Pick cwd…", systemImage: "folder")
                            }
                        }

                        TextField("Or type absolute path", text: $vm.customPath)
                            .textFieldStyle(.roundedBorder)
                            .onChange(of: vm.customPath) { _, v in
                                if !v.isEmpty { vm.selectedProjectId = nil }
                            }

                        if let projectNote {
                            Text(projectNote)
                                .font(.caption)
                                .foregroundStyle(DispatchColors.success)
                        }
                    }
                    .padding(6)
                }

                let bound = appState.selectedBoundProfile
                if bound?.profile.isGrok == true {
                    GroupBox("Options") {
                        VStack(alignment: .leading, spacing: 8) {
                            Toggle("Plan mode", isOn: $vm.planMode)
                            Toggle("Git worktree", isOn: $vm.worktree)
                            Toggle("Subagents", isOn: $vm.subagents)
                        }
                        .padding(6)
                    }
                } else if bound?.profile.isBot == true {
                    Text("This is a hunter bot. Dispatch opens a normal session — review the transcript and approve outbound drafts there. Nothing is sent.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                HStack {
                    Button {
                        Task { await dispatch() }
                    } label: {
                        if vm.isSubmitting {
                            ProgressView()
                        } else {
                            Label("Dispatch", systemImage: "paperplane.fill")
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .disabled(vm.isSubmitting || (vm.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && vm.pendingImages.isEmpty))
                    .keyboardShortcut(.defaultAction)

                    if let status {
                        Text(status).foregroundStyle(DispatchColors.success)
                    }
                    if let err = vm.errorMessage {
                        Text(err).foregroundStyle(DispatchColors.danger)
                    }
                }
            }
            .padding(20)
            .frame(maxWidth: 640, alignment: .leading)
        }
        .task { await vm.load(appState: appState) }
        .onChange(of: appState.selectedBoundProfileId) { _, _ in
            Task { await vm.load(appState: appState) }
        }
    }

    private func addProjectFolders() {
        do {
            let paths = try FolderPicker.pickAndRegisterProjects()
            guard !paths.isEmpty else { return }
            projectNote = "Registered \(paths.count) folder(s) in host config"
            if let first = paths.first {
                vm.customPath = first
                vm.selectedProjectId = nil
            }
            Task { await vm.load(appState: appState) }
        } catch {
            vm.errorMessage = error.localizedDescription
        }
    }

    private func pickImageFilesFromDisk() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = true
        panel.canCreateDirectories = false
        panel.message = "Choose screenshot or image files to send"
        panel.prompt = "Attach"
        panel.allowedContentTypes = [.png, .jpeg, .gif, .webP, .bmp, .tiff, .heic, .image]
        let desktop = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Desktop")
        if FileManager.default.fileExists(atPath: desktop.path) {
            panel.directoryURL = desktop
        }
        guard panel.runModal() == .OK else { return }
        var images: [PlatformImage] = []
        for url in panel.urls {
            let accessed = url.startAccessingSecurityScopedResource()
            defer { if accessed { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url),
                  let image = PlatformImage.cs_fromData(data) else { continue }
            images.append(image)
        }
        if !images.isEmpty {
            vm.addImages(images)
        } else if !panel.urls.isEmpty {
            vm.errorMessage = "Could not load selected image files"
        }
    }

    private func pickCwdOnce() {
        let urls = FolderPicker.pickDirectories(
            message: "Choose the working directory for this task",
            prompt: "Use Folder"
        )
        // If user multi-selected, use the first as cwd and register all
        guard let first = urls.first else { return }
        if urls.count > 1 {
            let folders = urls.map { url -> (id: String, name: String, path: String) in
                (url.lastPathComponent.lowercased() + "-" + String(abs(url.path.hashValue), radix: 16),
                 url.lastPathComponent,
                 url.path)
            }
            try? LocalHostConfigFile.mergeProjects(folders)
            projectNote = "Using \(first.path); also registered \(urls.count) folders"
        }
        vm.customPath = first.path
        vm.selectedProjectId = nil
    }

    private func dispatch() async {
        status = nil
        guard let route = await vm.dispatch(appState: appState) else { return }
        status = "Dispatched"
        await appState.refreshSessions()
        appState.macSelectedSessionId = route.sessionId
        appState.selectedTab = .sessions
    }
}
#endif
