import SwiftUI

struct TaskComposerView: View {
    @EnvironmentObject private var appState: AppState
    @StateObject private var vm = ComposerViewModel()
    @State private var navigateToId: String?

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
                                            Text("Describe what Grok should do on the Mac…")
                                                .foregroundStyle(.secondary)
                                                .padding(.top, 16)
                                                .padding(.leading, 12)
                                                .allowsHitTesting(false)
                                        }
                                    }
                            }
                        }

                        DispatchCard {
                            VStack(alignment: .leading, spacing: 14) {
                                Text("Project")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.secondary)

                                if vm.projects.isEmpty {
                                    Text("No projects loaded. Check host connection.")
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

                                TextField("Or absolute path on Mac", text: $vm.customPath)
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
                                Picker("Model", selection: $vm.model) {
                                    ForEach(vm.models, id: \.self) { Text($0).tag($0) }
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
                                if let session = await vm.dispatch(api: appState.api) {
                                    await appState.refreshSessions()
                                    navigateToId = session.id
                                    appState.selectedTab = .sessions
                                }
                            }
                        }
                    }
                    .padding(20)
                }
            }
            .navigationTitle("Dispatch task")
            .navigationDestination(item: $navigateToId) { id in
                SessionDetailView(sessionId: id)
            }
            .task {
                await vm.loadProjects(api: appState.api)
            }
        }
    }
}

// Make String work with navigationDestination(item:)
extension String: @retroactive Identifiable {
    public var id: String { self }
}
