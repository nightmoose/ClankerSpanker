#if os(macOS)
import SwiftUI
import AppKit
import UniformTypeIdentifiers

/// Right-side file viewer pane on the Mac command center. Renders markdown,
/// HTML, syntax-highlighted code, images, and a fallback preview for binaries.
/// Path can be typed, dropped, browsed via NSOpenPanel, or driven remotely by
/// setting `appState.macViewerFilePath`.
struct FileViewerPane: View {
    @EnvironmentObject private var appState: AppState
    @State private var pathInput: String = ""
    @State private var html: String = FileViewerRenderer.welcome()
    @State private var baseURL: URL? = nil
    @State private var lastLoadedPath: String? = nil

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().opacity(0.4)
            FileViewerWebView(html: html, baseURL: baseURL)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(minWidth: 320, idealWidth: 520)
        .background(Color(nsColor: .textBackgroundColor).opacity(0.4))
        .onAppear {
            if let start = appState.macViewerFilePath {
                pathInput = start
                load(start)
            }
        }
        .onChange(of: appState.macViewerFilePath) { _, new in
            guard let new, !new.isEmpty, new != lastLoadedPath else { return }
            pathInput = new
            load(new)
        }
        .onDrop(of: [.fileURL], isTargeted: nil) { providers in
            guard let provider = providers.first else { return false }
            _ = provider.loadObject(ofClass: URL.self) { url, _ in
                guard let url else { return }
                DispatchQueue.main.async {
                    pathInput = url.path
                    load(url.path)
                }
            }
            return true
        }
    }

    private var header: some View {
        HStack(spacing: 6) {
            Image(systemName: "doc.text.magnifyingglass")
                .foregroundStyle(.secondary)
            TextField(
                "Path (e.g. ~/Projects/foo/README.md)",
                text: $pathInput
            )
            .textFieldStyle(.plain)
            .font(.system(size: 12, design: .monospaced))
            .onSubmit { load(pathInput) }

            Button {
                load(pathInput)
            } label: {
                Image(systemName: "arrow.forward.circle.fill")
            }
            .buttonStyle(.plain)
            .help("Open path")
            .disabled(pathInput.trimmingCharacters(in: .whitespaces).isEmpty)

            Button {
                browseForFile()
            } label: {
                Image(systemName: "folder")
            }
            .buttonStyle(.plain)
            .help("Browse for file…")

            if lastLoadedPath != nil {
                Button {
                    NSWorkspace.shared.selectFile(
                        lastLoadedPath,
                        inFileViewerRootedAtPath: ""
                    )
                } label: {
                    Image(systemName: "arrow.up.forward.app")
                }
                .buttonStyle(.plain)
                .help("Reveal in Finder")
            }

            Button {
                appState.macViewerFilePath = nil
                appState.showMacViewer = false
            } label: {
                Image(systemName: "sidebar.trailing")
            }
            .buttonStyle(.plain)
            .help("Hide viewer")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(.ultraThinMaterial)
    }

    private func load(_ raw: String) {
        let trimmed = raw.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        let expanded = (trimmed as NSString).expandingTildeInPath
        let url = URL(fileURLWithPath: expanded)
        do {
            let data = try Data(contentsOf: url, options: .mappedIfSafe)
            let ext = url.pathExtension
            let filename = url.lastPathComponent
            let parent = url.deletingLastPathComponent()

            if FileViewerRenderer.isImage(ext: ext) {
                html = FileViewerRenderer.renderImage(url: url)
                baseURL = parent
            } else if let text = String(data: data, encoding: .utf8) {
                html = FileViewerRenderer.render(text: text, filename: filename, ext: ext)
                baseURL = parent
            } else {
                html = FileViewerRenderer.renderBinary(url: url, size: data.count)
                baseURL = nil
            }
            lastLoadedPath = url.path
            pathInput = url.path
        } catch {
            html = FileViewerRenderer.error(error.localizedDescription)
            baseURL = nil
            lastLoadedPath = nil
        }
    }

    private func browseForFile() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.title = "Open file to view"
        if panel.runModal() == .OK, let url = panel.url {
            pathInput = url.path
            load(url.path)
        }
    }
}
#endif
