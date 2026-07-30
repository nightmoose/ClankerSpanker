import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var appState: AppState

    @State private var draftName = ""
    @State private var draftURL = ""
    @State private var draftToken = ""
    @State private var editingHost: HostEndpoint?
    @State private var statusMessage: String?
    @State private var isWorking = false
    @State private var keepAwakeReminder = true

    var body: some View {
        NavigationStack {
            ZStack {
                DispatchBackground()
                Form {
                    Section {
                        Text("Each host is a machine running the ClankerSpanker gateway (your Mac Mini, a client laptop, …). Profiles from every host appear as colored chips on Sessions.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    .listRowBackground(Color.clear)

                    Section("Hosts") {
                        ForEach(appState.hosts) { host in
                            VStack(alignment: .leading, spacing: 4) {
                                HStack {
                                    Text(host.name).font(.headline)
                                    Spacer()
                                    Button("Edit") {
                                        editingHost = host
                                        draftName = host.name
                                        draftURL = host.baseURL
                                        draftToken = host.loadToken()
                                    }
                                    .font(.caption.weight(.semibold))
                                }
                                Text(host.baseURL)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                                Text(host.loadToken().isEmpty ? "No token" : "Token saved")
                                    .font(.caption2)
                                    .foregroundStyle(host.loadToken().isEmpty ? DispatchColors.danger : DispatchColors.success)
                            }
                            .listRowBackground(DispatchColors.card)
                            .swipeActions {
                                Button(role: .destructive) {
                                    appState.removeHost(id: host.id)
                                } label: {
                                    Label("Delete", systemImage: "trash")
                                }
                            }
                        }

                        Button {
                            editingHost = HostEndpoint(name: "", baseURL: "http://")
                            draftName = ""
                            draftURL = "http://"
                            draftToken = ""
                        } label: {
                            Label("Add host", systemImage: "plus.circle.fill")
                        }
                        .listRowBackground(DispatchColors.card)
                    }

                    if let editingHost {
                        Section(editingHost.name.isEmpty && draftName.isEmpty ? "New host" : "Edit host") {
                            TextField("Name (e.g. FullScore MBP)", text: $draftName)
                            TextField("Host URL", text: $draftURL)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .keyboardType(.URL)
                            SecureField("Host token", text: $draftToken)
                            Button {
                                Task { await saveHost(editingHost) }
                            } label: {
                                if isWorking { ProgressView() } else { Text("Save host") }
                            }
                            Button("Test this host") {
                                Task { await testHost(editingHost) }
                            }
                            Button("Cancel", role: .cancel) {
                                self.editingHost = nil
                            }
                        }
                        .listRowBackground(DispatchColors.card)
                    }

                    Section("Connection") {
                        HStack {
                            Text("WebSocket")
                            Spacer()
                            Text(appState.connectionLabel)
                                .foregroundStyle(appState.socket.isConnected ? DispatchColors.success : .secondary)
                        }
                        Text(appState.selectedHost.map { "Active: \($0.name)" } ?? "No active host")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .listRowBackground(DispatchColors.card)

                    Section("Reminders") {
                        Toggle("Keep hosts reachable reminder", isOn: $keepAwakeReminder)
                    }
                    .listRowBackground(DispatchColors.card)

                    Section {
                        Button("Sign out / clear all hosts", role: .destructive) {
                            appState.clearConfiguration()
                            statusMessage = "Cleared"
                        }
                    }
                    .listRowBackground(DispatchColors.card)

                    if let statusMessage {
                        Section {
                            Text(statusMessage).font(.footnote)
                        }
                        .listRowBackground(Color.clear)
                    }

                    Section("About") {
                        LabeledContent("App", value: "ClankerSpanker 0.5.3")
                        LabeledContent("Bundle", value: "com.nightmoose.clankerspanker")
                        LabeledContent("Hosts", value: "\(appState.hosts.count)")
                        LabeledContent("Profiles", value: "\(appState.boundProfiles.count)")
                    }
                    .listRowBackground(DispatchColors.card)
                }
                .scrollContentBackground(.hidden)
            }
            .navigationTitle("Settings")
            .onAppear {
                keepAwakeReminder = UserDefaults.standard.object(forKey: "keepAwakeReminder") as? Bool ?? true
            }
            .onChange(of: keepAwakeReminder) { _, value in
                UserDefaults.standard.set(value, forKey: "keepAwakeReminder")
            }
        }
    }

    private func saveHost(_ base: HostEndpoint) async {
        isWorking = true
        defer { isWorking = false }
        var host = base
        host.name = draftName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? "Host"
            : draftName.trimmingCharacters(in: .whitespacesAndNewlines)
        host.baseURL = draftURL
        appState.upsertHost(host, token: draftToken)
        editingHost = nil
        statusMessage = "Saved \(host.name)"
        await appState.refreshSessions()
        do {
            try await appState.api.validate(host: host)
            statusMessage = "\(host.name) reachable ✓"
        } catch {
            statusMessage = "\(host.name): \(error.localizedDescription)"
        }
    }

    private func testHost(_ base: HostEndpoint) async {
        var host = base
        if !draftURL.isEmpty { host.baseURL = draftURL }
        if !draftToken.isEmpty { host.saveToken(draftToken) }
        do {
            try await appState.api.validate(host: host)
            _ = try await appState.api.health(host: host)
            statusMessage = "\(host.name.isEmpty ? "Host" : host.name) reachable ✓"
            appState.socket.connect(host: host)
        } catch {
            statusMessage = error.localizedDescription
        }
    }
}
