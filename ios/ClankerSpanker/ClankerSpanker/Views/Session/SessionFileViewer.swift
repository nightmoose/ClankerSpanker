import SwiftUI
#if canImport(UIKit)
import UIKit
#endif
#if os(macOS)
import AppKit
#endif
#if canImport(PDFKit)
import PDFKit
#endif

/// In-app viewer for a session file fetched from the host (iPhone + Mac sheet).
struct SessionFileViewer: View {
    let content: SessionFileContent
    var onDismiss: () -> Void

    /// RFC-023: temp file written on-demand so binaries (PDF, docx, zip…) can
    /// be shared via the system share sheet.
    @State private var exportURL: URL?

    var body: some View {
        NavigationStack {
            ZStack {
                DispatchBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(content.path)
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                        if content.truncated == true {
                            Text("Showing the first \(content.size) bytes (truncated).")
                                .font(.caption)
                                .foregroundStyle(DispatchColors.warning)
                        }
                        if content.isImage, let data = binaryData {
                            #if canImport(UIKit)
                            if let ui = UIImage(data: data) {
                                Image(uiImage: ui)
                                    .resizable()
                                    .scaledToFit()
                                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                            }
                            #elseif os(macOS)
                            if let ns = NSImage(data: data) {
                                Image(nsImage: ns)
                                    .resizable()
                                    .scaledToFit()
                                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                            }
                            #endif
                        } else if content.isPDF, let data = binaryData {
                            #if canImport(PDFKit)
                            PDFPreview(data: data)
                                .frame(minHeight: 480)
                                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                            #else
                            Text("PDF preview requires PDFKit · \(byteLabel(content.size))")
                                .foregroundStyle(.secondary)
                            #endif
                        } else if let text = content.text {
                            if content.mimeType.contains("markdown") || content.name.lowercased().hasSuffix(".md") {
                                MarkdownView(text: text)
                            } else {
                                Text(text)
                                    .font(.system(.callout, design: .monospaced))
                                    .textSelection(.enabled)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        } else {
                            Text("Binary file · \(byteLabel(content.size))")
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding()
                }
            }
            .navigationTitle(content.name)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { onDismiss() }
                }
                if let url = shareItem {
                    ToolbarItem(placement: .primaryAction) {
                        ShareLink(item: url) {
                            Image(systemName: "square.and.arrow.up")
                        }
                    }
                } else if let text = content.text, !text.isEmpty {
                    ToolbarItem(placement: .primaryAction) {
                        ShareLink(item: text) {
                            Image(systemName: "square.and.arrow.up")
                        }
                    }
                }
            }
        }
        .preferredColorScheme(.dark)
    }

    private var binaryData: Data? {
        guard let b64 = content.data else { return nil }
        return Data(base64Encoded: b64)
    }

    /// RFC-023: memoize the temp-file URL so ShareLink gets a stable file:// item.
    private var shareItem: URL? {
        if let exportURL { return exportURL }
        guard let data = binaryData else { return nil }
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("clanker-share", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent(content.name)
        do {
            try data.write(to: url, options: .atomic)
            Task { @MainActor in self.exportURL = url }
            return url
        } catch {
            return nil
        }
    }

    private func byteLabel(_ n: Int) -> String {
        if n >= 1_048_576 { return String(format: "%.1f MB", Double(n) / 1_048_576) }
        if n >= 1024 { return String(format: "%.1f KB", Double(n) / 1024) }
        return "\(n) B"
    }
}

#if canImport(PDFKit)
/// RFC-023: PDFKit-backed preview for `application/pdf` binaries.
private struct PDFPreview: View {
    let data: Data

    var body: some View {
        #if os(iOS)
        PDFKitRepresentable(data: data)
        #elseif os(macOS)
        PDFKitRepresentableMac(data: data)
        #else
        Text("PDF preview not supported on this platform")
            .foregroundStyle(.secondary)
        #endif
    }
}

#if os(iOS)
private struct PDFKitRepresentable: UIViewRepresentable {
    let data: Data
    func makeUIView(context: Context) -> PDFView {
        let v = PDFView()
        v.autoScales = true
        v.displayMode = .singlePageContinuous
        v.displayDirection = .vertical
        v.backgroundColor = .clear
        v.document = PDFDocument(data: data)
        return v
    }
    func updateUIView(_ v: PDFView, context: Context) {
        if v.document?.dataRepresentation() != data {
            v.document = PDFDocument(data: data)
        }
    }
}
#endif

#if os(macOS)
private struct PDFKitRepresentableMac: NSViewRepresentable {
    let data: Data
    func makeNSView(context: Context) -> PDFView {
        let v = PDFView()
        v.autoScales = true
        v.displayMode = .singlePageContinuous
        v.displayDirection = .vertical
        v.backgroundColor = .clear
        v.document = PDFDocument(data: data)
        return v
    }
    func updateNSView(_ v: PDFView, context: Context) {
        if v.document?.dataRepresentation() != data {
            v.document = PDFDocument(data: data)
        }
    }
}
#endif
#endif
