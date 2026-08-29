import SwiftUI
import WebKit

final class TerminalSession: ObservableObject {
    weak var coordinator: TerminalWebCoordinator?

    func sendKey(_ data: String) {
        coordinator?.sendKey(data)
    }

    func pasteClipboard() {
        guard let text = DispatchClipboard.pasteString(), !text.isEmpty else { return }
        coordinator?.paste(text)
    }
}

final class TerminalWebCoordinator: NSObject, WKNavigationDelegate {
    var token: String
    weak var session: TerminalSession?
    weak var webView: WKWebView?

    init(token: String, session: TerminalSession) {
        self.token = token
        self.session = session
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        session?.coordinator = self
        inject()
    }

    func inject() {
        guard let webView else { return }
        let payload = TerminalConnect(token: token)
        guard let data = try? JSONEncoder().encode(payload),
              let json = String(data: data, encoding: .utf8)
        else { return }
        webView.evaluateJavaScript(
            "window.startClankerTerminal && startClankerTerminal(\(json));",
            completionHandler: nil
        )
    }

    func sendKey(_ data: String) {
        guard let encoded = try? JSONEncoder().encode(data),
              let json = String(data: encoded, encoding: .utf8)
        else { return }
        webView?.evaluateJavaScript(
            "window.sendClankerKey && sendClankerKey(\(json));",
            completionHandler: nil
        )
    }

    func paste(_ text: String) {
        guard let encoded = try? JSONEncoder().encode(text),
              let json = String(data: encoded, encoding: .utf8)
        else { return }
        webView?.evaluateJavaScript(
            "window.pasteClankerText && pasteClankerText(\(json));",
            completionHandler: nil
        )
    }
}

private struct TerminalConnect: Encodable {
    var token: String
}

private func makeWebView(coordinator: TerminalWebCoordinator) -> WKWebView {
    let config = WKWebViewConfiguration()
    config.defaultWebpagePreferences.allowsContentJavaScript = true
    let view = WKWebView(frame: .zero, configuration: config)
    view.navigationDelegate = coordinator
    #if os(iOS)
    view.isOpaque = false
    view.backgroundColor = .black
    view.scrollView.keyboardDismissMode = .interactive
    view.scrollView.contentInsetAdjustmentBehavior = .never
    #else
    view.setValue(false, forKey: "drawsBackground")
    #endif
    return view
}

#if os(iOS)
struct TerminalWebView: UIViewRepresentable {
    let pageURL: URL
    let token: String
    @ObservedObject var session: TerminalSession

    func makeCoordinator() -> TerminalWebCoordinator {
        TerminalWebCoordinator(token: token, session: session)
    }

    func makeUIView(context: Context) -> WKWebView {
        let view = makeWebView(coordinator: context.coordinator)
        context.coordinator.webView = view
        context.coordinator.session = session
        view.load(URLRequest(url: pageURL))
        return view
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {
        context.coordinator.token = token
        context.coordinator.session = session
        context.coordinator.webView = uiView
        session.coordinator = context.coordinator
    }
}
#else
struct TerminalWebView: NSViewRepresentable {
    let pageURL: URL
    let token: String
    @ObservedObject var session: TerminalSession

    func makeCoordinator() -> TerminalWebCoordinator {
        TerminalWebCoordinator(token: token, session: session)
    }

    func makeNSView(context: Context) -> WKWebView {
        let view = makeWebView(coordinator: context.coordinator)
        context.coordinator.webView = view
        context.coordinator.session = session
        view.load(URLRequest(url: pageURL))
        return view
    }

    func updateNSView(_ nsView: WKWebView, context: Context) {
        context.coordinator.token = token
        context.coordinator.session = session
        context.coordinator.webView = nsView
        session.coordinator = context.coordinator
    }
}
#endif
