import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var appState: AppState

    @State private var hostURL = ""
    @State private var hostToken = ""
    @State private var xaiKey = ""
    @State private var keepAwakeReminder = true
    @State private var statusMessage: String?
    @State private var isSaving = false

    var body: some View {
        NavigationStack {
            ZStack {
                DispatchBackground()
                Form {
                    Section("Host") {
                        TextField("Host URL", text: $hostURL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(.URL)
                        SecureField("Host token", text: $hostToken)
                        SecureField("xAI API key (optional)", text: $xaiKey)
                        HStack {
                            Text("WebSocket")
                            Spacer()
                            Text(appState.connectionLabel)
                                .foregroundStyle(appState.socket.isConnected ? DispatchColors.success : .secondary)
                        }
                    }
                    .listRowBackground(DispatchColors.card)

                    Section("Reminders") {
                        Toggle("Keep Mac awake reminder", isOn: $keepAwakeReminder)
                        Text("When on, Dispatch can nudge you if the host is unreachable while a task is running.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .listRowBackground(DispatchColors.card)

                    Section {
                        Button {
                            Task { await save() }
                        } label: {
                            if isSaving {
                                ProgressView()
                            } else {
                                Text("Save")
                            }
                        }

                        Button("Test connection") {
                            Task { await test() }
                        }

                        Button("Sign out / clear secrets", role: .destructive) {
                            appState.clearConfiguration()
                            hostURL = ""
                            hostToken = ""
                            xaiKey = ""
                            statusMessage = "Cleared"
                        }
                    }
                    .listRowBackground(DispatchColors.card)

                    if let statusMessage {
                        Section {
                            Text(statusMessage)
                                .font(.footnote)
                        }
                        .listRowBackground(Color.clear)
                    }

                    Section("About") {
                        LabeledContent("App", value: "ClankerSpanker 0.2.4")
                        LabeledContent("Bundle", value: "com.nightmoose.clankerspanker")
                    }
                    .listRowBackground(DispatchColors.card)
                }
                .scrollContentBackground(.hidden)
            }
            .navigationTitle("Settings")
            .onAppear {
                hostURL = KeychainHelper.loadString(key: KeychainHelper.Keys.hostURL) ?? ""
                hostToken = KeychainHelper.loadString(key: KeychainHelper.Keys.hostToken) ?? ""
                xaiKey = KeychainHelper.loadString(key: KeychainHelper.Keys.xaiAPIKey) ?? ""
                keepAwakeReminder = UserDefaults.standard.object(forKey: "keepAwakeReminder") as? Bool ?? true
            }
            .onChange(of: keepAwakeReminder) { _, value in
                UserDefaults.standard.set(value, forKey: "keepAwakeReminder")
            }
        }
    }

    private func save() async {
        isSaving = true
        defer { isSaving = false }
        appState.saveConfiguration(
            hostURL: hostURL,
            hostToken: hostToken,
            xaiKey: xaiKey.isEmpty ? nil : xaiKey
        )
        statusMessage = "Saved"
        await test()
    }

    private func test() async {
        do {
            try await appState.api.validate()
            statusMessage = "Host reachable ✓"
            appState.socket.connect()
        } catch {
            statusMessage = error.localizedDescription
        }
    }
}
