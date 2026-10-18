import SwiftUI

/// Sheet for entering a Postgres / Supabase connection string.
/// The string is sent to the host and stored server-side; it is never
/// returned to any client (RFC-058).
struct ProjectDatabaseSheet: View {
    let projectId: String
    let host: HostEndpoint
    var onConnected: (ProjectInfo) -> Void
    var onCancel: () -> Void

    @EnvironmentObject private var appState: AppState

    @State private var connectionString: String = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    private var canConnect: Bool {
        let s = connectionString.trimmingCharacters(in: .whitespacesAndNewlines)
        return !s.isEmpty && !isSaving &&
            (s.hasPrefix("postgres://") || s.hasPrefix("postgresql://"))
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(
                        "Connection string",
                        text: $connectionString,
                        prompt: Text("postgresql://user:password@host:5432/db"),
                        axis: .vertical
                    )
                    .font(.system(.body, design: .monospaced))
                    .autocorrectionDisabled(true)
                    #if os(iOS)
                    .textInputAutocapitalization(.never)
                    #endif
                    .lineLimit(3...6)
                } header: {
                    Text("Postgres connection string")
                } footer: {
                    Text("The connection string is stored on the host and never sent to any client. The agent can use sql_execute to query data but cannot read or write the string itself.")
                        .font(.caption2)
                }

                if let err = errorMessage {
                    Section {
                        Text(err)
                            .font(.caption)
                            .foregroundStyle(DispatchColors.danger)
                    }
                }
            }
            #if os(macOS)
            .formStyle(.grouped)
            .frame(minWidth: 480, minHeight: 260)
            #endif
            .navigationTitle("Connect database")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { onCancel() }.disabled(isSaving)
                }
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        Task { await connect() }
                    } label: {
                        if isSaving {
                            ProgressView().controlSize(.small)
                        } else {
                            Text("Connect").fontWeight(.semibold)
                        }
                    }
                    .disabled(!canConnect)
                }
            }
        }
    }

    private func connect() async {
        errorMessage = nil
        isSaving = true
        defer { isSaving = false }
        let cs = connectionString.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let project = try await appState.api.connectDatabase(
                projectId: projectId,
                connectionString: cs,
                host: host
            )
            onConnected(project)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
