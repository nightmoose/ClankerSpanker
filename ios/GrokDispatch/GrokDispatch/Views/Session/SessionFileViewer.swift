import SwiftUI
#if canImport(UIKit)
import UIKit
#endif
#if os(macOS)
import AppKit
#endif

/// In-app viewer for a session file fetched from the host (iPhone + Mac sheet).
struct SessionFileViewer: View {
    let content: SessionFileContent
    var onDismiss: () -> Void

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
                        if content.isImage, let data = imageData {
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
                if let text = content.text, !text.isEmpty {
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

    private var imageData: Data? {
        guard content.isImage, let b64 = content.data else { return nil }
        return Data(base64Encoded: b64)
    }

    private func byteLabel(_ n: Int) -> String {
        if n >= 1_048_576 { return String(format: "%.1f MB", Double(n) / 1_048_576) }
        if n >= 1024 { return String(format: "%.1f KB", Double(n) / 1024) }
        return "\(n) B"
    }
}
