import SwiftUI
import PhotosUI

struct TaskComposerView: View {
    @EnvironmentObject private var appState: AppState
    @StateObject private var vm = ComposerViewModel()
    @State private var navigateTo: SessionRoute?
    @State private var photoPickerItems: [PhotosPickerItem] = []
    @State private var showExtraFolders = false

    private var selectedProject: ProjectInfo? {
        vm.projects.first { $0.id == vm.selectedProjectId }
    }

    /// Compact display for a filesystem path — swaps $HOME for "~" and cuts
    /// off the common "/Projects/" prefix when present so long absolute paths
    /// stay readable in the picker's menu.
    private func shortenPath(_ path: String) -> String {
        if let r = path.range(of: "/Projects/") { return "~/Projects/" + path[r.upperBound...] }
        let home = NSHomeDirectory()
        if path.hasPrefix(home) { return "~" + path.dropFirst(home.count) }
        return path
    }

    var body: some View {
        NavigationStack {
            ZStack {
                DispatchBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        // Profile: same segmented control as Sessions (shared selection)
                        DispatchCard {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("Who runs this task")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.secondary)
                                ProfileSegmentBar(
                                    selection: $vm.selectedBoundProfileId,
                                    onChange: { b in
                                        vm.applyModelDefaults(for: b)
                                        Task { await vm.load(appState: appState) }
                                    },
                                    includeAll: false
                                )
                                if let b = appState.boundProfiles.first(where: { $0.id == vm.selectedBoundProfileId }) {
                                    Text(
                                        b.profile.isBot
                                            ? "Runs in-process as \(b.displayName). Drafts land in the Bots outbox for review. Nothing is sent."
                                            : b.profile.isClaude
                                                ? "Starts a new Claude session as \(b.displayName)."
                                                : b.profile.isAntigravity
                                                    ? "Starts a new Antigravity (agy) session as \(b.displayName)."
                                                    : "Starts a new Grok session as \(b.displayName)."
                                    )
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                }
                            }
                        }

                        DispatchCard {
                            VStack(alignment: .leading, spacing: 10) {
                                Text("Task")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.secondary)
                                TextField("Optional short title", text: $vm.title)
                                    .textFieldStyle(.plain)
                                    .padding(10)
                                    .background(Color.white.opacity(0.06))
                                    .clipShape(RoundedRectangle(cornerRadius: 10))

                                TextEditor(text: $vm.prompt)
                                    .frame(minHeight: 140)
                                    .scrollContentBackground(.hidden)
                                    .padding(8)
                                    .background(Color.white.opacity(0.06))
                                    .clipShape(RoundedRectangle(cornerRadius: 12))
                                    .overlay(alignment: .topLeading) {
                                        if vm.prompt.isEmpty {
                                            Text("Describe what the agent should do…")
                                                .foregroundStyle(.secondary)
                                                .padding(.top, 16)
                                                .padding(.leading, 12)
                                                .allowsHitTesting(false)
                                        }
                                    }
                            }
                        }

                        DispatchCard {
                            VStack(alignment: .leading, spacing: 10) {
                                Text("Screenshots")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.secondary)
                                Text("Optional. Up to 4 images on the first turn.")
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
                                    }
                                }
                                PhotosPicker(
                                    selection: $photoPickerItems,
                                    maxSelectionCount: max(1, 4 - vm.pendingImages.count),
                                    matching: .images
                                ) {
                                    Label("Attach images", systemImage: "photo.on.rectangle.angled")
                                }
                                .disabled(vm.isSubmitting || vm.pendingImages.count >= 4)
                                .onChange(of: photoPickerItems) { _, items in
                                    Task { await loadPickerItems(items) }
                                }
                            }
                        }

                        DispatchCard {
                            VStack(alignment: .leading, spacing: 12) {
                                Text("Working directory on host")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.secondary)
                                Text("Folder where the agent reads and writes code on the selected machine. This is not the AI account — pick that above.")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .fixedSize(horizontal: false, vertical: true)

                                if vm.projects.isEmpty {
                                    if let host = appState.boundProfiles.first(where: { $0.id == vm.selectedBoundProfileId })?.host ?? appState.selectedHost {
                                        EmptyHostProjectsView(host: host) { saved in
                                            await vm.load(appState: appState)
                                            if let saved {
                                                vm.selectedProjectId = saved.id
                                                vm.selectedProjectPath = saved.effectivePaths.first
                                            }
                                        }
                                    }
                                } else {
                                    Picker("Project", selection: $vm.selectedProjectId) {
                                        ForEach(vm.projects) { p in
                                            Text(p.name).tag(Optional(p.id))
                                        }
                                    }
                                    .pickerStyle(.menu)
                                    .onChange(of: vm.selectedProjectId) { _, newId in
                                        // When project changes, snap the path
                                        // picker to that project's first path.
                                        let paths = vm.projects.first(where: { $0.id == newId })?.effectivePaths ?? []
                                        vm.selectedProjectPath = paths.first
                                    }

                                    if let p = selectedProject {
                                        VStack(alignment: .leading, spacing: 6) {
                                            HStack(spacing: 6) {
                                                Circle()
                                                    .fill(Color(hex: p.color ?? "") ?? DispatchColors.accent)
                                                    .frame(width: 8, height: 8)
                                                Text(p.name)
                                                    .font(.subheadline.weight(.semibold))
                                            }
                                            if p.effectivePaths.count > 1 {
                                                Picker("Path", selection: Binding(
                                                    get: { vm.selectedProjectPath ?? p.effectivePaths.first ?? "" },
                                                    set: { vm.selectedProjectPath = $0 }
                                                )) {
                                                    ForEach(p.effectivePaths, id: \.self) { path in
                                                        Text(shortenPath(path)).tag(path)
                                                    }
                                                }
                                                .pickerStyle(.menu)
                                            } else if let onlyPath = p.effectivePaths.first {
                                                Text(onlyPath)
                                                    .font(.system(.caption, design: .monospaced))
                                                    .foregroundStyle(.secondary)
                                                    .textSelection(.enabled)
                                            }
                                        }
                                        .padding(10)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .background(Color.white.opacity(0.05))
                                        .clipShape(RoundedRectangle(cornerRadius: 10))
                                    }
                                }

                                Text("Or override with any absolute path on that host")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                TextField("/Users/…/path/to/repo", text: $vm.customPath)
                                    #if os(iOS)
                                    .textInputAutocapitalization(.never)
                                    #endif
                                    .autocorrectionDisabled()
                                    .padding(10)
                                    .background(Color.white.opacity(0.06))
                                    .clipShape(RoundedRectangle(cornerRadius: 10))
                                    .onChange(of: vm.customPath) { _, newValue in
                                        if !newValue.isEmpty { vm.selectedProjectId = nil }
                                    }
                                if !vm.customPath.isEmpty {
                                    Text("Using custom path — allowlisted project is ignored.")
                                        .font(.caption2)
                                        .foregroundStyle(DispatchColors.warning)
                                }

                                if !vm.extraDirs.isEmpty {
                                    VStack(alignment: .leading, spacing: 6) {
                                        Text("Extra folders")
                                            .font(.caption.weight(.semibold))
                                            .foregroundStyle(.secondary)
                                        ForEach(vm.extraDirs, id: \.self) { dir in
                                            HStack {
                                                Text(shortenPath(dir))
                                                    .font(.system(.caption, design: .monospaced))
                                                    .lineLimit(1)
                                                    .truncationMode(.middle)
                                                Spacer()
                                                Button {
                                                    vm.removeExtraDir(dir)
                                                } label: {
                                                    Image(systemName: "xmark.circle.fill")
                                                        .foregroundStyle(.secondary)
                                                }
                                                .buttonStyle(.plain)
                                            }
                                        }
                                    }
                                }
                                Button {
                                    #if os(macOS)
                                    let urls = FolderPicker.pickDirectories(
                                        message: "Choose extra workspace folders besides the working directory",
                                        prompt: "Add"
                                    )
                                    vm.addExtraFolderPaths(urls.map(\.path))
                                    #else
                                    showExtraFolders = true
                                    #endif
                                } label: {
                                    Label("Add extra folders", systemImage: "folder.badge.plus")
                                }
                                .buttonStyle(.plain)
                                Text("Besides the working directory. Claude gets --add-dir; Grok/Gemini are told in the prompt.")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                        }

                        DispatchCard {
                            VStack(spacing: 12) {
                                let bound = appState.boundProfiles.first { $0.id == vm.selectedBoundProfileId }
                                if bound?.profile.isGrok == true {
                                    Toggle("Plan mode first (read-only until you approve)", isOn: $vm.planMode)
                                    if vm.planMode {
                                        Text("Plan mode blocks file edits until exit is approved. Leave off for normal implement tasks.")
                                            .font(.caption2)
                                            .foregroundStyle(DispatchColors.warning)
                                            .frame(maxWidth: .infinity, alignment: .leading)
                                    }
                                    Toggle("Allow subagents", isOn: $vm.subagents)
                                    Toggle("Isolated worktree", isOn: $vm.worktree)
                                } else if bound?.profile.isBot == true {
                                    Text("Hunter/bot runs share the Sessions inbox. Edit the prompt (standing job is prefilled), dispatch, then review the transcript and approve outbound drafts in the chat — same as a Claude tool gate.")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                } else if bound?.profile.isAntigravity == true {
                                    if bound?.profile.autoApprovesTools == true {
                                        AutoApproveWarning()
                                    }
                                    Text("Antigravity (agy) runs headless on the host. Authenticate once with `agy` on that machine.")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                } else {
                                    Text("Claude uses the selected account + working directory on that host. Pick a real project folder (not /).")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                }
                                Picker("Model", selection: $vm.model) {
                                    ForEach(vm.models(for: bound), id: \.self) { Text($0).tag($0) }
                                }
                            }
                        }

                        if let error = vm.errorMessage {
                            Text(error)
                                .font(.footnote)
                                .foregroundStyle(DispatchColors.danger)
                        }

                        DispatchButton(
                            title: vm.isSubmitting ? "Dispatching…" : "Spank a clanker",
                            icon: "paperplane.fill",
                            isLoading: vm.isSubmitting
                        ) {
                            Task {
                                if let route = await vm.dispatch(appState: appState) {
                                    await appState.refreshSessions()
                                    navigateTo = route
                                    appState.selectedTab = .sessions
                                }
                            }
                        }
                    }
                    .padding()
                }
            }
            // Title lives in the top tab strip; no page header.
            .navigationTitle("")
            #if os(iOS)
            .toolbar(.hidden, for: .navigationBar)
            #endif
            .navigationDestination(item: $navigateTo) { route in
                if let host = appState.hosts.first(where: { $0.id == route.hostId }) {
                    SessionDetailView(
                        sessionId: route.sessionId,
                        host: host,
                        scrollToMessageId: route.messageId
                    )
                }
            }
            .sheet(isPresented: $showExtraFolders) {
                ExtraFoldersSheet(
                    projects: vm.projects,
                    cwd: vm.resolvedCwd,
                    already: vm.extraDirs,
                    onAdd: { vm.addExtraFolderPaths($0) }
                )
            }
            .task { await vm.load(appState: appState) }
            .onChange(of: appState.selectedBoundProfileId) { _, _ in
                Task { await vm.load(appState: appState) }
            }
            .onChange(of: appState.selectedTab) { _, tab in
                if tab == .compose {
                    Task { await vm.load(appState: appState) }
                }
            }
            .onChange(of: appState.tabRefreshTick) { _, _ in
                guard appState.selectedTab == .compose else { return }
                Task { await vm.load(appState: appState) }
            }
        }
    }

    private func loadPickerItems(_ items: [PhotosPickerItem]) async {
        guard !items.isEmpty else { return }
        var images: [PlatformImage] = []
        for item in items {
            if let data = try? await item.loadTransferable(type: Data.self),
               let image = PlatformImage.cs_fromData(data)
            {
                images.append(image)
            }
        }
        if !images.isEmpty {
            vm.addImages(images)
        }
        photoPickerItems = []
    }
}


/// Gemini / Antigravity can't ask for approval headless, so it runs every
/// tool without asking unless the profile opts out (RFC-030).
struct AutoApproveWarning: View {
    var body: some View {
        Label {
            Text("Runs edits and shell commands without asking. To require approval, set ANTIGRAVITY_REQUIRE_PERMISSIONS=1 on this profile (Gemini will then refuse shell tools).")
        } icon: {
            Image(systemName: "exclamationmark.shield.fill")
        }
        .font(.caption)
        .foregroundStyle(DispatchColors.warning)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}


