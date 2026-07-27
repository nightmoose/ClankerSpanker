import SwiftUI

struct TaskComposerView: View {
    @EnvironmentObject private var appState: AppState
    @StateObject private var vm = ComposerViewModel()
    @State private var navigateTo: SessionRoute?

    var body: some View {
        NavigationStack {
            ZStack {
                DispatchBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
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
                                            Text("Describe what the agent should do on that host…")
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
                                Text("Agent profile · host")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.secondary)
                                if appState.boundProfiles.isEmpty {
                                    Text("No profiles yet. Add a host in Settings.")
                                        .font(.footnote)
                                        .foregroundStyle(.secondary)
                                } else {
                                    // Visible chips (not a buried menu) so Claude profiles are first-class
                                    ScrollView(.horizontal, showsIndicators: false) {
                                        HStack(spacing: 8) {
                                            ForEach(appState.boundProfiles) { b in
                                                let selected = b.id == vm.selectedBoundProfileId
                                                Button {
                                                    vm.selectedBoundProfileId = b.id
                                                    appState.selectBoundProfile(b.id)
                                                    vm.applyModelDefaults(for: b)
                                                    Task { await vm.load(appState: appState) }
                                                } label: {
                                                    VStack(alignment: .leading, spacing: 2) {
                                                        HStack(spacing: 6) {
                                                            Circle().fill(b.uiColor).frame(width: 8, height: 8)
                                                            Text(b.displayName)
                                                                .font(.subheadline.weight(selected ? .bold : .semibold))
                                                            Text(b.backendLabel)
                                                                .font(.caption2.weight(.bold))
                                                                .padding(.horizontal, 6)
                                                                .padding(.vertical, 2)
                                                                .background(b.uiColor.opacity(0.25))
                                                                .clipShape(Capsule())
                                                        }
                                                        Text(b.hostLabel)
                                                            .font(.caption2)
                                                            .foregroundStyle(.secondary)
                                                    }
                                                    .padding(.horizontal, 12)
                                                    .padding(.vertical, 8)
                                                    .background(
                                                        RoundedRectangle(cornerRadius: 12)
                                                            .fill(selected ? b.uiColor.opacity(0.22) : Color.white.opacity(0.06))
                                                    )
                                                    .overlay(
                                                        RoundedRectangle(cornerRadius: 12)
                                                            .stroke(selected ? b.uiColor : Color.white.opacity(0.08), lineWidth: selected ? 1.5 : 1)
                                                    )
                                                }
                                                .buttonStyle(.plain)
                                            }
                                        }
                                    }
                                    if let b = appState.boundProfiles.first(where: { $0.id == vm.selectedBoundProfileId }) {
                                        Text(b.profile.isClaude
                                             ? "New session will run as Claude (\(b.displayName)) on \(b.hostLabel)."
                                             : "New session will run as Grok (\(b.displayName)) on \(b.hostLabel).")
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                }

                                Text("Project")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.secondary)

                                if vm.projects.isEmpty {
                                    Text("No projects loaded from this host.")
                                        .font(.footnote)
                                        .foregroundStyle(.secondary)
                                } else {
                                    Picker("Project", selection: $vm.selectedProjectId) {
                                        ForEach(vm.projects) { p in
                                            Text(p.name).tag(Optional(p.id))
                                        }
                                    }
                                    .pickerStyle(.menu)
                                }

                                TextField("Or absolute path on that host", text: $vm.customPath)
                                    .textInputAutocapitalization(.never)
                                    .autocorrectionDisabled()
                                    .padding(10)
                                    .background(Color.white.opacity(0.06))
                                    .clipShape(RoundedRectangle(cornerRadius: 10))
                                    .onChange(of: vm.customPath) { _, newValue in
                                        if !newValue.isEmpty { vm.selectedProjectId = nil }
                                    }
                            }
                        }

                        DispatchCard {
                            VStack(spacing: 12) {
                                Toggle("Plan mode first", isOn: $vm.planMode)
                                Toggle("Allow subagents", isOn: $vm.subagents)
                                Toggle("Isolated worktree", isOn: $vm.worktree)
                                let bound = appState.boundProfiles.first { $0.id == vm.selectedBoundProfileId }
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
        }
    }
}
