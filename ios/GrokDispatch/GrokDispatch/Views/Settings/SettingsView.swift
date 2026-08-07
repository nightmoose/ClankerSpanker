import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var appState: AppState
    #if os(macOS)
    @ObservedObject private var localHost = LocalHostController.shared
    #endif

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

                    #if os(macOS)
                    Section("Local host (this Mac)") {
                        LabeledContent("API") {
                            Text(localHost.apiReachable ? "Up" : "Down")
                                .foregroundStyle(localHost.apiReachable ? DispatchColors.success : .secondary)
                        }
                        LabeledContent("Process") {
                            Text(localHost.isRunning ? "pid \(localHost.pid.map(String.init) ?? "?")" : "Stopped")
                        }
                        TextField("Host package path", text: $localHost.hostPackagePath)
                            .textFieldStyle(.roundedBorder)
                        HStack {
                            Button("Save path") {
                                localHost.savePackagePath(localHost.hostPackagePath)
                                statusMessage = "Saved host package path"
                            }
                            Button("Start") { localHost.start() }
                                .disabled(localHost.isRunning)
                            Button("Stop") { localHost.stop() }
                                .disabled(!localHost.isRunning)
                            Button("Connect") {
                                Task {
                                    if let pair = await localHost.bootstrapLocalHost() {
                                        appState.saveConfiguration(
                                            hostURL: pair.url,
                                            hostToken: pair.token,
                                            xaiKey: nil
                                        )
                                        statusMessage = "Connected to \(pair.url)"
                                        await appState.refreshSessions()
                                    } else {
                                        statusMessage = localHost.lastError ?? "Could not bootstrap local host"
                                    }
                                }
                            }
                        }
                        if let err = localHost.lastError, !err.isEmpty {
                            Text(err)
                                .font(.caption)
                                .foregroundStyle(DispatchColors.danger)
                        }
                        if !localHost.logs.isEmpty {
                            Text(localHost.logs.suffix(12).joined(separator: "\n"))
                                .font(.system(.caption2, design: .monospaced))
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                        }
                        Text("Starts `host/dist/index.js` with Node. Build the host package first. Sandbox is off so the app can manage a local gateway.")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    .listRowBackground(DispatchColors.card)
                    #endif

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
                                #if os(iOS)
                                .textInputAutocapitalization(.never)
                                .keyboardType(.URL)
                                #endif
                                .autocorrectionDisabled()
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
                        LabeledContent("App", value: "ClankerSpanker 0.6.0")
                        #if os(macOS)
                        LabeledContent("Bundle", value: "com.nightmoose.clankerspanker.mac")
                        LabeledContent("Platform", value: "macOS")
                        #else
                        LabeledContent("Bundle", value: "com.nightmoose.clankerspanker")
                        LabeledContent("Platform", value: "iOS")
                        #endif
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
