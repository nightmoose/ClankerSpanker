import SwiftUI

struct DiffView: View {
    let text: String
    var cwd: String = ""
    var onOpenFile: ((String) -> Void)? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            let files = changedFiles(from: text)
            if !files.isEmpty && onOpenFile != nil {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Changed files")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    ForEach(files, id: \.self) { file in
                        #if os(macOS)
                        Button {
                            onOpenFile?(file)
                        } label: {
                            HStack(spacing: 6) {
                                Image(systemName: "doc.text").font(.caption2)
                                Text(displayPath(file))
                                    .font(.system(.caption, design: .monospaced))
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                            }
                            .foregroundStyle(DispatchColors.accent)
                        }
                        .buttonStyle(.plain)
                        .help("Open \(file) in file viewer")
                        #else
                        HStack(spacing: 6) {
                            Image(systemName: "doc.text").font(.caption2)
                            Text(displayPath(file))
                                .font(.system(.caption, design: .monospaced))
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                        .foregroundStyle(.secondary)
                        #endif
                    }
                }
                .padding(.bottom, 4)
            }

            ScrollView(.horizontal) {
                Text(text)
                    .font(.system(.footnote, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(12)
        .background(Color.white.opacity(0.05))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    /// Extract file paths from `+++ b/…` diff headers. The `b/` (or `a/`)
    /// prefix that git prepends is stripped; `/dev/null` (deletions) is skipped.
    private func changedFiles(from diff: String) -> [String] {
        var seen = Set<String>()
        var out: [String] = []
        for line in diff.split(separator: "\n", omittingEmptySubsequences: false) {
            guard line.hasPrefix("+++ ") else { continue }
            var path = String(line.dropFirst(4))
            if path.hasPrefix("b/") { path = String(path.dropFirst(2)) }
            if path == "/dev/null" || path.isEmpty { continue }
            if !seen.contains(path) {
                seen.insert(path)
                out.append(path)
            }
        }
        return out
    }

    private func displayPath(_ path: String) -> String {
        if !cwd.isEmpty && path.hasPrefix(cwd) {
            let stripped = String(path.dropFirst(cwd.count))
            return stripped.hasPrefix("/") ? String(stripped.dropFirst()) : stripped
        }
        return path
    }
}
