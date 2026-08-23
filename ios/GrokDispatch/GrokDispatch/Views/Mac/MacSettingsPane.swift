#if os(macOS)
import SwiftUI

/// Mac settings — hosts registry without phone Form chrome where it hurts.
struct MacSettingsPane: View {
    @EnvironmentObject private var appState: AppState

    @State private var draftName = ""
    @State private var draftURL = ""
    @State private var draftToken = ""
    @State private var editingHost: HostEndpoint?
    @State private var statusMessage: String?
    @State private var isWorking = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("Settings")
                    .font(.largeTitle.weight(.bold))
                Text("Register host gateways. Profiles from every host show as chips on Sessions.")
                    .font(.callout)
                    .foregroundStyle(.secondary)

                GroupBox("Connection") {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text("WebSocket")
                            Spacer()
                            Text(appState.connectionLabel)
                                .foregroundStyle(appState.socket.isConnected ? DispatchColors.success : .secondary)
                        }
                        Text(appState.selectedHost.map { "Active host: \($0.name) · \($0.baseURL)" } ?? "No active host")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .padding(6)
                }

                GroupBox("Hosts") {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(appState.hosts) { host in
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(host.name).font(.headline)
                                    Text(host.baseURL)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                    Text(host.loadToken().isEmpty ? "No token" : "Token saved")
                                        .font(.caption2)
                                        .foregroundStyle(host.loadToken().isEmpty ? DispatchColors.danger : DispatchColors.success)
                                }
                                Spacer()
                                Button("Edit") {
                                    editingHost = host
                                    draftName = host.name
                                    draftURL = host.baseURL
                                    draftToken = host.loadToken()
                                }
                                Button("Remove", role: .destructive) {
                                    appState.removeHost(id: host.id)
                                }
                            }
                            .padding(.vertical, 8)
                            if host.id != appState.hosts.last?.id {
                                Divider()
                            }
                        }

                        Button {
                            editingHost = HostEndpoint(name: "", baseURL: "http://127.0.0.1:8787")
                            draftName = ""
                            draftURL = "http://127.0.0.1:8787"
                            draftToken = ""
                        } label: {
                            Label("Add host", systemImage: "plus.circle.fill")
                        }
                        .padding(.top, 10)
                    }
                    .padding(6)
                }

                if editingHost != nil {
                    GroupBox("Edit host") {
                        VStack(alignment: .leading, spacing: 10) {
                            TextField("Name", text: $draftName)
                                .textFieldStyle(.roundedBorder)
                            TextField("URL", text: $draftURL)
                                .textFieldStyle(.roundedBorder)
                            SecureField("Token", text: $draftToken)
                                .textFieldStyle(.roundedBorder)
                            HStack {
                                Button("Save") {
                                    Task { await saveHost() }
                                }
                                .buttonStyle(.borderedProminent)
                                .disabled(isWorking)
                                Button("Test") {
                                    Task { await testHost() }
                                }
                                Button("Cancel", role: .cancel) {
                                    editingHost = nil
                                }
                            }
                        }
                        .padding(6)
                    }
                }

                GroupBox("Danger zone") {
                    Button("Sign out / clear all hosts", role: .destructive) {
                        appState.clearConfiguration()
                        statusMessage = "Cleared"
                    }
                    .padding(6)
                }

                GroupBox("About") {
                    VStack(alignment: .leading, spacing: 6) {
                        LabeledContent(
                            "App",
                            value: {
                                let v = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
                                let b = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?"
                                return "ClankerSpanker \(v) (\(b))"
                            }()
                        )
                        LabeledContent("Bundle", value: "com.nightmoose.clankerspanker.mac")
                        LabeledContent("Platform", value: "macOS (native)")
                        LabeledContent("Hosts", value: "\(appState.hosts.count)")
                        LabeledContent("Profiles", value: "\(appState.boundProfiles.count)")
                    }
                    .padding(6)
                }

                if let statusMessage {
                    Text(statusMessage)
                        .font(.callout)
                        .foregroundStyle(DispatchColors.success)
                }
            }
            .padding(24)
            .frame(maxWidth: 720, alignment: .leading)
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .navigationTitle("Settings")
    }

    private func saveHost() async {
        guard var host = editingHost else { return }
        isWorking = true
        defer { isWorking = false }
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
            statusMessage = "\(host.name) reachable"
        } catch {
            statusMessage = "\(host.name): \(error.localizedDescription)"
        }
    }

    private func testHost() async {
        var host = editingHost ?? HostEndpoint(name: draftName, baseURL: draftURL)
        host.baseURL = draftURL
        if !draftToken.isEmpty { host.saveToken(draftToken) }
        do {
            try await appState.api.validate(host: host)
            _ = try await appState.api.health(host: host)
            statusMessage = "Reachable"
        } catch {
            statusMessage = error.localizedDescription
        }
    }
}
#endif
