import SwiftUI

/// Interactive login shell on the selected host (PTY over the host gateway).
struct TerminalView: View {
    @EnvironmentObject private var appState: AppState
    @StateObject private var session = TerminalSession()

    var body: some View {
        VStack(spacing: 0) {
            if let host = appState.selectedHost, let page = terminalPageURL(host: host) {
                TerminalWebView(pageURL: page, token: host.loadToken(), session: session)
                    .background(Color.black)
            } else {
                VStack(spacing: 12) {
                    Image(systemName: "terminal")
                        .font(.system(size: 42, weight: .ultraLight))
                        .foregroundStyle(.secondary)
                    Text("No host")
                        .font(.title3.weight(.semibold))
                    Text("Add a host in Settings, then open Term for a shell on that machine.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 24)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            #if os(iOS)
            keyBar
            #endif
        }
        .background(Color.black)
        .navigationTitle("Host terminal")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
    }

    private var keyBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                keyCap("Esc") { session.sendKey("\u{1b}") }
                keyCap("Tab") { session.sendKey("\t") }
                keyCap("⌃C") { session.sendKey("\u{3}") }
                keyCap("⌃D") { session.sendKey("\u{4}") }
                keyCap("↑") { session.sendKey("\u{1b}[A") }
                keyCap("↓") { session.sendKey("\u{1b}[B") }
                keyCap("←") { session.sendKey("\u{1b}[D") }
                keyCap("→") { session.sendKey("\u{1b}[C") }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
        }
        .background(.ultraThinMaterial)
    }

    private func keyCap(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.caption.weight(.semibold))
                .monospaced()
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(Color.white.opacity(0.08))
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    private func terminalPageURL(host: HostEndpoint) -> URL? {
        guard var components = URLComponents(string: host.baseURL) else { return nil }
        components.path = "/app/terminal.html"
        components.query = nil
        components.fragment = nil
        return components.url
    }
}
