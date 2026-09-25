import SwiftUI
import AppKit

@main
struct ClankerSpankerHostTrayApp: App {
    @StateObject private var store = HostTrayStore()

    var body: some Scene {
        MenuBarExtra {
            HostTrayMenu()
                .environmentObject(store)
        } label: {
            Image(systemName: store.apiReachable ? "bolt.circle.fill" : "bolt.slash.circle")
        }
        .menuBarExtraStyle(.menu)
    }
}
