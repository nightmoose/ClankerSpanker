#if os(macOS)
import SwiftUI

/// Host-panel profiles manager. Talks to the local gateway (127.0.0.1) so
/// create/edit is allowed even when Sessions is connected via LAN/Tailscale.
struct MacProfilesSection: View {
    @EnvironmentObject private var appState: AppState
    let loopbackHost: HostEndpoint

    @State private var rows: [AdminAgentProfile] = []
    @State private var isAdmin = false
    @State private var loadError: String?
    @State private var editor: ProfileDraft?
    @State private var pendingDelete: AdminAgentProfile?
    @State private var busy = false

    var body: some View {
        GroupBox("Agent profiles") {
            VStack(alignment: .leading, spacing: 12) {
                Text("Grok, Claude, Gemini (Antigravity), and hunter bots. This panel talks to the gateway on this Mac so you can add a Gemini account without editing config.json by hand.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                if let loadError {
                    Text(loadError)
                        .font(.caption)
                        .foregroundStyle(DispatchColors.danger)
                        .textSelection(.enabled)
                }

                if rows.isEmpty, loadError == nil {
                    Text("No profiles returned yet. Start the host if the list stays empty.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                ForEach(rows) { p in
                    HStack(spacing: 10) {
                        Circle()
                            .fill(Color(hex: p.color) ?? .gray)
                            .frame(width: 10, height: 10)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(p.name)
                                .font(.subheadline.weight(.semibold))
                            Text("\(backendLabel(p.backend)) · \(p.id)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("Edit") {
                            editor = ProfileDraft.edit(p)
                        }
                        Button("Delete", role: .destructive) {
                            pendingDelete = p
                        }
                    }
                    .padding(.vertical, 4)
                }

                HStack(spacing: 10) {
                    Button {
                        editor = .blank()
                    } label: {
                        Label("Add profile", systemImage: "plus.circle.fill")
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(busy)

                    Button("Reload") {
                        Task { await reload() }
                    }
                    .disabled(busy)
                }
                .controlSize(.large)
            }
            .padding(4)
        }
        .task { await reload() }
        .sheet(item: $editor) { draft in
            MacProfileEditorSheet(draft: draft, host: loopbackHost) {
                await reload()
                await appState.refreshSessions()
            }
        }
        .confirmationDialog(
            "Delete profile \(pendingDelete?.name ?? "")?",
            isPresented: Binding(
                get: { pendingDelete != nil },
                set: { if !$0 { pendingDelete = nil } }
            )
        ) {
            Button("Delete", role: .destructive) {
                guard let id = pendingDelete?.id else { return }
                pendingDelete = nil
                Task { await deleteProfile(id) }
            }
            Button("Cancel", role: .cancel) { pendingDelete = nil }
        }
    }

    private func backendLabel(_ raw: String) -> String {
        switch raw {
        case "claude": return "Claude"
        case "antigravity", "agy", "gemini": return "Gemini"
        case "bot": return "Bot"
        default: return "Grok"
        }
    }

    @MainActor
    private func reload() async {
        busy = true
        defer { busy = false }
        do {
            let res = try await appState.api.adminProfiles(host: loopbackHost)
            isAdmin = res.admin == true
            if let admin = res.adminProfiles, isAdmin {
                rows = admin
            } else {
                rows = res.profiles.map {
                    AdminAgentProfile(
                        id: $0.id,
                        name: $0.name,
                        backend: $0.backend,
                        color: $0.color,
                        model: $0.model,
                        systemPrompt: nil,
                        claudeConfigDir: nil,
                        antigravityConfigDir: nil,
                        env: nil
                    )
                }
                if !isAdmin {
                    loadError = "Host refused admin from this connection. Is the gateway running on \(loopbackHost.baseURL)?"
                } else {
                    loadError = nil
                }
            }
            if isAdmin { loadError = nil }
        } catch {
            loadError = error.localizedDescription
        }
    }

    @MainActor
    private func deleteProfile(_ id: String) async {
        busy = true
        defer { busy = false }
        do {
            try await appState.api.deleteAgentProfile(id: id, host: loopbackHost)
            await reload()
            await appState.refreshSessions()
        } catch {
            loadError = error.localizedDescription
        }
    }
}

struct ProfileDraft: Identifiable {
    let id: UUID
    var existingId: String?
    var name: String
    var backend: String
    var color: String
    var model: String
    var systemPrompt: String
    var claudeConfigDir: String
    var antigravityConfigDir: String
    var apiKey: String

    var isNew: Bool { existingId == nil }

    static func blank() -> ProfileDraft {
        ProfileDraft(
            id: UUID(),
            existingId: nil,
            name: "",
            backend: "grok",
            color: "#73B8FF",
            model: "",
            systemPrompt: "",
            claudeConfigDir: "",
            antigravityConfigDir: "",
            apiKey: ""
        )
    }

    static func edit(_ p: AdminAgentProfile) -> ProfileDraft {
        ProfileDraft(
            id: UUID(),
            existingId: p.id,
            name: p.name,
            backend: p.backend,
            color: p.color,
            model: p.model ?? "",
            systemPrompt: p.systemPrompt ?? "",
            claudeConfigDir: p.claudeConfigDir ?? "",
            antigravityConfigDir: p.antigravityConfigDir ?? "",
            apiKey: ""
        )
    }
}

private struct MacProfileEditorSheet: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var appState: AppState
    @State var draft: ProfileDraft
    let host: HostEndpoint
    var onSaved: () async -> Void

    @State private var errorMessage: String?
    @State private var saving = false

    private let backends: [(id: String, label: String, color: String)] = [
        ("grok", "Grok (xAI)", "#73B8FF"),
        ("claude", "Claude Code", "#F97316"),
        ("antigravity", "Gemini (Antigravity CLI)", "#34A853"),
        ("bot", "Bot (hunter)", "#E879F9"),
    ]

    var body: some View {
        NavigationStack {
            Form {
                TextField("Name", text: $draft.name)
                Picker("Backend", selection: $draft.backend) {
                    ForEach(backends, id: \.id) { b in
                        Text(b.label).tag(b.id)
                    }
                }
                .onChange(of: draft.backend) { _, new in
                    if let match = backends.first(where: { $0.id == new }) {
                        let oldDefaults = Set(backends.map(\.color))
                        if oldDefaults.contains(draft.color.uppercased()) || oldDefaults.contains(draft.color) {
                            draft.color = match.color
                        }
                    }
                }
                TextField("Color (hex)", text: $draft.color)
                TextField("Model (optional)", text: $draft.model)
                    .textFieldStyle(.roundedBorder)

                if draft.backend == "claude" {
                    TextField("Claude config dir (optional)", text: $draft.claudeConfigDir)
                    SecureField("ANTHROPIC_API_KEY (leave blank to keep)", text: $draft.apiKey)
                    Text("Or leave the key blank and use Sign in / `claude` on this Mac.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else if draft.backend == "antigravity" {
                    TextField("Antigravity config dir (optional)", text: $draft.antigravityConfigDir)
                    SecureField("GEMINI_API_KEY (leave blank to keep)", text: $draft.apiKey)
                    Text("Leave the key blank if you already ran `agy` once on this Mac (keyring login). Then dispatch a session with the Gemini chip.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                } else if draft.backend == "bot" {
                    SecureField("API key (XAI / Anthropic / Gemini)", text: $draft.apiKey)
                } else {
                    SecureField("XAI_API_KEY (leave blank to keep)", text: $draft.apiKey)
                }

                TextField("System prompt (optional)", text: $draft.systemPrompt, axis: .vertical)
                    .lineLimit(3...8)

                if let errorMessage {
                    Text(errorMessage)
                        .foregroundStyle(DispatchColors.danger)
                        .font(.caption)
                }
            }
            .formStyle(.grouped)
            .navigationTitle(draft.isNew ? "New profile" : "Edit \(draft.name)")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .keyboardShortcut(.cancelAction)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(draft.isNew ? "Create" : "Save") {
                        Task { await save() }
                    }
                    .disabled(saving || draft.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .keyboardShortcut(.defaultAction)
                }
            }
        }
        .frame(minWidth: 480, minHeight: 420)
    }

    @MainActor
    private func save() async {
        saving = true
        defer { saving = false }
        let name = draft.name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else {
            errorMessage = "Name is required"
            return
        }
        var body = ProfileWriteBody(
            id: draft.isNew ? nil : draft.existingId,
            name: name,
            backend: draft.backend,
            color: draft.color.trimmingCharacters(in: .whitespacesAndNewlines),
            model: emptyToNil(draft.model),
            systemPrompt: emptyToNil(draft.systemPrompt),
            claudeConfigDir: emptyToNil(draft.claudeConfigDir),
            antigravityConfigDir: emptyToNil(draft.antigravityConfigDir),
            env: nil
        )
        let key = draft.apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        if !key.isEmpty {
            switch draft.backend {
            case "claude": body.env = ["ANTHROPIC_API_KEY": key]
            case "antigravity": body.env = ["GEMINI_API_KEY": key]
            case "bot":
                if key.hasPrefix("sk-ant") { body.env = ["ANTHROPIC_API_KEY": key] }
                else if key.hasPrefix("AIza") { body.env = ["GEMINI_API_KEY": key] }
                else { body.env = ["XAI_API_KEY": key] }
            default: body.env = ["XAI_API_KEY": key]
            }
        }
        do {
            if draft.isNew {
                _ = try await appState.api.createProfile(body, host: host)
            } else if let id = draft.existingId {
                _ = try await appState.api.updateProfile(id: id, body: body, host: host)
            }
            await onSaved()
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func emptyToNil(_ s: String) -> String? {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : t
    }
}
#endif
