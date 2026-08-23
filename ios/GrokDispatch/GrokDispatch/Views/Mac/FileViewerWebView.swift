#if os(macOS)
import SwiftUI
import WebKit

/// Minimal WKWebView wrapper for the right-side file viewer. Reloads whenever
/// `html` changes; `baseURL` is set to the file's parent directory so relative
/// image references in markdown work.
struct FileViewerWebView: NSViewRepresentable {
    let html: String
    let baseURL: URL?

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.setValue(false, forKey: "drawsBackground")
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        webView.loadHTMLString(html, baseURL: baseURL)
    }
}
#endif
