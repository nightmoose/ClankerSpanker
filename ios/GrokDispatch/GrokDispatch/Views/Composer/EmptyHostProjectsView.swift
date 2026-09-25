import SwiftUI

/// A host with no projects (RFC-036, shared with the Mac composer in RFC-039):
/// offer Import from <host> / New project right where the picker would be.
struct EmptyHostProjectsView: View {
    let host: HostEndpoint
    /// Called after projects changed; `saved` is the new project when one was created.
    var onChanged: (ProjectInfo?) async -> Void

    @EnvironmentObject private var appState: AppState
    @State private var sheet: Sheet?
    @State private var isDiscovering = false
    @State private var errorText: String?

    enum Sheet: Identifiable {
        case new
        case importCandidates([ProjectInfo])
        var id: String {
            switch self {
            case .new: return "new"
            case .importCandidates: return "import"
            }
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("No projects on \(host.name) yet.")
                .font(.footnote.weight(.semibold))
            Text("Agents need a real folder to work in (not /). Import the repos \(host.name) already has, or add one by path.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 10) {
                Button {
                    Task { await discover() }
                } label: {
                    Label(isDiscovering ? "Scanning…" : "Import from \(host.name)…", systemImage: "sparkle.magnifyingglass")
                }
                .buttonStyle(.borderedProminent)
                .disabled(isDiscovering)
                Button {
                    sheet = .new
                } label: {
                    Label("New project…", systemImage: "plus")
                }
                .buttonStyle(.bordered)
            }
            if let errorText {
                Text(errorText)
                    .font(.caption)
                    .foregroundStyle(DispatchColors.warning)
            }
        }
        .sheet(item: $sheet) { which in
            switch which {
            case .new:
                ProjectEditorView(
                    mode: .new,
                    host: host,
                    onSaved: { saved in
                        sheet = nil
                        Task { await onChanged(saved) }
                    },
                    onCancel: { sheet = nil }
                )
                .environmentObject(appState)
            case .importCandidates(let candidates):
                ProjectImportSheet(
                    candidates: candidates,
                    host: host,
                    onDone: {
                        sheet = nil
                        Task { await onChanged(nil) }
                    },
                    onCancel: { sheet = nil }
                )
                .environmentObject(appState)
            }
        }
    }

    private func discover() async {
        errorText = nil
        isDiscovering = true
        defer { isDiscovering = false }
        do {
            let candidates = try await appState.api.discoverProjects(host: host)
            if candidates.isEmpty {
                errorText = "\(host.name) didn't suggest any folders. Use New project… and type a path."
            } else {
                sheet = .importCandidates(candidates)
            }
        } catch {
            errorText = error.localizedDescription
        }
    }
}
