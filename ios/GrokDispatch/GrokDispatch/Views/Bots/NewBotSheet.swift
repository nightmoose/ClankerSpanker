import SwiftUI

/// Create + schedule a hunter. Host `POST /bots`; scheduler picks it up if enabled.
struct NewBotSheet: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var vm: BotsViewModel

    @State private var name = ""
    @State private var job = ""
    @State private var interval = "6h"
    @State private var enabled = false
    @State private var selectedProfileId: String = ""
    @State private var selectedProjectId: String?
    @State private var projects: [ProjectInfo] = []
    @State private var isSaving = false
    @State private var formError: String?

    private var profiles: [BoundProfile] {
        appState.visibleBoundProfiles
    }

    private var canCreate: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !job.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && selectedProjectId != nil
            && !selectedProfileId.isEmpty
            && !isSaving
    }

    var body: some View {
        #if os(iOS)
        NavigationStack {
            Form {
                if let formError {
                    Section {
                        Text(formError)
                            .foregroundStyle(DispatchColors.danger)
                    }
                }
                Section("Bot") {
                    TextField("Name", text: $name)
                    TextEditor(text: $job)
                        .frame(minHeight: 140)
                    Text("Runs as this prompt each fire. Drafts go to .bot-outbox/. Nothing is sent until you approve.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Section("Runs under") {
                    if profiles.isEmpty {
                        Text("No profile on this host yet — connect a host first.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else {
                        Picker("Profile", selection: $selectedProfileId) {
                            ForEach(profiles) { bound in
                                Text("\(bound.displayName) · \(bound.backendLabel)")
                                    .tag(bound.profile.id)
                            }
                        }
                    }
                    Text("Hunter sessions show under this profile on Sessions — tagged in the title, not a separate chip.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Section("Working directory") {
                    if projects.isEmpty {
                        Text("No projects on this host yet — add one from Projects first.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else {
                        Picker("Project", selection: $selectedProjectId) {
                            Text("—").tag(Optional<String>.none)
                            ForEach(projects) { p in
                                Text("\(p.name) — \(p.primaryPath)").tag(Optional(p.id))
                            }
                        }
                    }
                    Text("cwd for each run. File writes stay in that project’s .bot-outbox/.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Section("Schedule") {
                    Picker("Interval", selection: $interval) {
                        ForEach(intervalChoices, id: \.self) { value in
                            Text(BotSchedule.label(value)).tag(value)
                        }
                    }
                    Toggle("Enable schedule", isOn: $enabled)
                    Text(enabled
                         ? "Host fires this job on the interval (first run within ~30s). You can still Run now from the bot."
                         : "Paused until you enable it. Run now still works from the bot.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("New bot")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") {
                        Task { await create() }
                    }
                    .fontWeight(.semibold)
                    .disabled(!canCreate)
                }
            }
        }
        .task { await loadProjects() }
        #else
        macBody
        #endif
    }

    #if os(macOS)
    private var macBody: some View {
        VStack(spacing: 0) {
            HStack {
                Text("New bot")
                    .font(.title2.weight(.bold))
                Spacer()
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button {
                    Task { await create() }
                } label: {
                    if isSaving {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Text("Create")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(!canCreate)
                .keyboardShortcut(.defaultAction)
            }
            .padding()

            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let formError {
                        Text(formError)
                            .font(.callout)
                            .foregroundStyle(DispatchColors.danger)
                            .textSelection(.enabled)
                    }

                    GroupBox("Bot") {
                        VStack(alignment: .leading, spacing: 12) {
                            TextField("Name", text: $name)
                                .textFieldStyle(.roundedBorder)
                            Text("Standing job")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                            TextEditor(text: $job)
                                .font(.body)
                                .frame(minHeight: 140)
                                .padding(8)
                                .background(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.primary.opacity(0.12)))
                            Text("Runs as this prompt each fire. Drafts go to .bot-outbox/. Nothing is sent until you approve.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .padding(6)
                    }

                    GroupBox("Runs under") {
                        VStack(alignment: .leading, spacing: 10) {
                            if profiles.isEmpty {
                                Text("No profile on this host yet — connect a host first.")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            } else {
                                Picker("Profile", selection: $selectedProfileId) {
                                    ForEach(profiles) { bound in
                                        Text("\(bound.displayName) · \(bound.backendLabel)")
                                            .tag(bound.profile.id)
                                    }
                                }
                            }
                            Text("Hunter sessions show under this profile on Sessions — tagged in the title, not a separate chip.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .padding(6)
                    }

                    GroupBox("Working directory") {
                        VStack(alignment: .leading, spacing: 10) {
                            if projects.isEmpty {
                                Text("No projects on this host yet — add one from Projects first.")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            } else {
                                Picker("Project", selection: $selectedProjectId) {
                                    Text("—").tag(Optional<String>.none)
                                    ForEach(projects) { p in
                                        Text("\(p.name) — \(p.primaryPath)").tag(Optional(p.id))
                                    }
                                }
                            }
                            Text("cwd for each run. File writes stay in that project’s .bot-outbox/.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .padding(6)
                    }

                    GroupBox("Schedule") {
                        VStack(alignment: .leading, spacing: 12) {
                            Picker("Interval", selection: $interval) {
                                ForEach(intervalChoices, id: \.self) { value in
                                    Text(BotSchedule.label(value)).tag(value)
                                }
                            }
                            Toggle("Enable schedule", isOn: $enabled)
                            Text(enabled
                                 ? "Host fires this job on the interval (first run within ~30s). You can still Run now from the bot."
                                 : "Paused until you enable it. Run now still works from the bot.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .padding(6)
                    }
                }
                .padding(20)
            }
        }
        .frame(minWidth: 560, minHeight: 560)
        .task { await loadProjects() }
    }
    #endif

    private var intervalChoices: [String] {
        BotSchedule.presets.contains(interval) ? BotSchedule.presets : BotSchedule.presets + [interval]
    }

    private func loadProjects() async {
        if selectedProfileId.isEmpty {
            selectedProfileId = appState.selectedBoundProfile?.profile.id
                ?? profiles.first?.profile.id
                ?? ""
        }
        guard let host = appState.selectedHost else {
            formError = "No host selected"
            return
        }
        do {
            let res = try await appState.api.projects(host: host)
            projects = res.projects.filter { !$0.isArchived }
            if selectedProjectId == nil {
                selectedProjectId = projects.first?.id
            }
            formError = nil
        } catch {
            formError = error.localizedDescription
        }
    }

    private func create() async {
        guard let projectId = selectedProjectId else { return }
        isSaving = true
        defer { isSaving = false }
        let created = await vm.create(
            name: name.trimmingCharacters(in: .whitespacesAndNewlines),
            profileId: selectedProfileId,
            projectId: projectId,
            job: job.trimmingCharacters(in: .whitespacesAndNewlines),
            interval: interval,
            enabled: enabled,
            appState: appState
        )
        if created != nil {
            dismiss()
        } else {
            formError = vm.errorMessage ?? "Could not create bot"
        }
    }
}
