import SwiftUI

/// Pick extra host workspace folders from registered projects (phone) or
/// confirm a list (Mac also uses NSOpenPanel elsewhere).
struct ExtraFoldersSheet: View {
    let projects: [ProjectInfo]
    let cwd: String
    let already: [String]
    var onAdd: ([String]) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var selected: Set<String> = []

    private var paths: [String] {
        var seen = Set<String>()
        var out: [String] = []
        for p in projects {
            for path in p.effectivePaths where !path.isEmpty && seen.insert(path).inserted {
                out.append(path)
            }
        }
        return out
    }

    var body: some View {
        NavigationStack {
            List {
                if paths.isEmpty {
                    Text("No host projects yet. Add folders on the Mac host (Projects tab), then pick them here.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                } else {
                    Section("Host project folders") {
                        ForEach(paths, id: \.self) { path in
                            let taken = path == cwd || already.contains(path)
                            Button {
                                guard !taken else { return }
                                if selected.contains(path) { selected.remove(path) }
                                else { selected.insert(path) }
                            } label: {
                                HStack(alignment: .top, spacing: 10) {
                                    Image(systemName: taken
                                          ? "checkmark.circle"
                                          : (selected.contains(path) ? "checkmark.circle.fill" : "circle"))
                                        .foregroundStyle(taken ? .secondary : DispatchColors.accent)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text((path as NSString).lastPathComponent)
                                            .foregroundStyle(.primary)
                                        Text(path)
                                            .font(.system(.caption2, design: .monospaced))
                                            .foregroundStyle(.secondary)
                                            .textSelection(.enabled)
                                        if path == cwd {
                                            Text("Working directory").font(.caption2).foregroundStyle(.secondary)
                                        } else if already.contains(path) {
                                            Text("Already added").font(.caption2).foregroundStyle(.secondary)
                                        }
                                    }
                                    Spacer(minLength: 0)
                                }
                            }
                            .disabled(taken)
                        }
                    }
                }
            }
            .navigationTitle("Extra folders")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button("Add") {
                        onAdd(Array(selected))
                        dismiss()
                    }
                    .fontWeight(.semibold)
                    .disabled(selected.isEmpty)
                }
            }
        }
    }
}
