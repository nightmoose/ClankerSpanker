import SwiftUI

struct TaskComposerView: View {
    @EnvironmentObject private var appState: AppState
    @StateObject private var vm = ComposerViewModel()
    @State private var navigateTo: SessionRoute?

    private var selectedProject: ProjectInfo? {
        vm.projects.first { $0.id == vm.selectedProjectId }
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
                                    }
                                )
                                if let b = appState.boundProfiles.first(where: { $0.id == vm.selectedBoundProfileId }) {
                                    Text(
                                        b.profile.isClaude
                                            ? "Starts a new Claude session as \(b.displayName)."
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
                            VStack(alignment: .leading, spacing: 12) {
                                Text("Working directory on host")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.secondary)
                                Text("Folder where the agent reads and writes code on the selected machine. This is not the AI account — pick that above.")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .fixedSize(horizontal: false, vertical: true)

                                if vm.projects.isEmpty {
                                    Text("No allowlisted folders on this host. Add paths under projects in ~/.grok-dispatch/config.json, or type an absolute path below.")
                                        .font(.footnote)
                                        .foregroundStyle(.secondary)
                                } else {
                                    Picker("Working directory", selection: $vm.selectedProjectId) {
                                        ForEach(vm.projects) { p in
                                            Text(p.name).tag(Optional(p.id))
                                        }
                                    }
                                    .pickerStyle(.menu)

                                    if let p = selectedProject {
                                        VStack(alignment: .leading, spacing: 4) {
                                            Text(p.name)
                                                .font(.subheadline.weight(.semibold))
                                            Text(p.path)
                                                .font(.system(.caption, design: .monospaced))
                                                .foregroundStyle(.secondary)
                                                .textSelection(.enabled)
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
                            }
                        }

                        DispatchCard {
                            VStack(spacing: 12) {
                                let bound = appState.boundProfiles.first { $0.id == vm.selectedBoundProfileId }
                                if bound?.profile.isClaude != true {
                                    Toggle("Plan mode first (read-only until you approve)", isOn: $vm.planMode)
                                    if vm.planMode {
                                        Text("Plan mode blocks file edits until exit is approved. Leave off for normal implement tasks.")
                                            .font(.caption2)
                                            .foregroundStyle(DispatchColors.warning)
                                            .frame(maxWidth: .infinity, alignment: .leading)
                                    }
                                    Toggle("Allow subagents", isOn: $vm.subagents)
                                    Toggle("Isolated worktree", isOn: $vm.worktree)
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
            .navigationTitle("Dispatch")
            .navigationDestination(item: $navigateTo) { route in
                if let host = appState.hosts.first(where: { $0.id == route.hostId }) {
                    SessionDetailView(sessionId: route.sessionId, host: host)
                }
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
        }
    }
}
