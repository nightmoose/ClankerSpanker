import SwiftUI
import AppKit

/// Menu content for the host tray. Configuration lives in the browser
/// (host serves `/app/` and `/setup`); this menu is discoverability +
/// launchd control.
struct HostTrayMenu: View {
    @EnvironmentObject private var store: HostTrayStore

    var body: some View {
        Text(store.statusLine)
            .font(.caption)
        Divider()

        Button("Open web UI") { store.openBrowser(path: "/app/") }
            .disabled(!store.apiReachable)
        Button("Open setup") { store.openBrowser(path: "/setup") }
            .disabled(!store.apiReachable)

        Divider()

        Button("Kickstart host") {
            store.kickstart()
        }
        Button("Reveal host log") {
            store.revealHostLog()
        }
        Button("Reveal config folder") {
            store.revealConfigFolder()
        }
        Button("Refresh status") {
            Task { await store.refresh() }
        }

        Divider()

        Button("Quit tray") {
            NSApp.terminate(nil)
        }
        .keyboardShortcut("q")
    }
}
