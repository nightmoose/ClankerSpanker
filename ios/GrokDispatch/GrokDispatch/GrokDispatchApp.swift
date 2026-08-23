import SwiftUI
import UserNotifications
#if os(macOS)
import AppKit
#endif

@main
struct ClankerSpankerApp: App {
    #if os(iOS)
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    #elseif os(macOS)
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    #endif
    @StateObject private var appState = AppState()

    var body: some Scene {
        #if os(macOS)
        // Main window
        WindowGroup {
            ContentView()
                .environmentObject(appState)
                .preferredColorScheme(.dark)
                .onOpenURL { url in appState.handleDeepLink(url) }
                .frame(minWidth: 1000, minHeight: 680)
        }
        .defaultSize(width: 1320, height: 860)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("New session…") {
                    appState.selectedTab = .compose
                    NotificationCenter.default.post(name: .macShowCompose, object: nil)
                    MacAppChrome.showMainWindow()
                }
                .keyboardShortcut("n", modifiers: [.command])
                Button("New bot…") {
                    NotificationCenter.default.post(name: .macShowNewBot, object: nil)
                    MacAppChrome.showMainWindow()
                }
                .keyboardShortcut("n", modifiers: [.command, .shift])
            }
            CommandMenu("Host") {
                Button("Start local host") {
                    LocalHostController.shared.start()
                }
                .keyboardShortcut("r", modifiers: [.command, .shift])
                Button("Stop local host") {
                    LocalHostController.shared.stop()
                }
                Button("Show Host panel") {
                    MacAppChrome.showMainWindow()
                    NotificationCenter.default.post(name: .macShowHost, object: nil)
                }
                Divider()
                Button("Reconnect local host…") {
                    Task {
                        try? await appState.ensureLocalHostOnMac()
                        await appState.refreshSessions()
                    }
                }
            }
        }

        // Menu bar (upper-right) — stays while main window is closed
        MenuBarExtra("ClankerSpanker", systemImage: "bolt.circle.fill") {
            MacMenuBarMenu()
                .environmentObject(appState)
        }
        #else
        WindowGroup {
            ContentView()
                .environmentObject(appState)
                .preferredColorScheme(.dark)
                .onOpenURL { url in appState.handleDeepLink(url) }
        }
        #endif
    }
}

#if os(macOS)
private struct MacMenuBarMenu: View {
    @EnvironmentObject private var appState: AppState
    @ObservedObject private var host = LocalHostController.shared

    var body: some View {
        Button("Show ClankerSpanker") {
            MacAppChrome.showMainWindow()
        }
        Divider()
        Text(statusLine)
            .font(.caption)
        Divider()
        Button("New session…") {
            MacAppChrome.showMainWindow()
            NotificationCenter.default.post(name: .macShowCompose, object: nil)
        }
        Button("Host panel…") {
            MacAppChrome.showMainWindow()
            NotificationCenter.default.post(name: .macShowHost, object: nil)
        }
        Button("Settings…") {
            MacAppChrome.showMainWindow()
            NotificationCenter.default.post(name: .macShowSettings, object: nil)
        }
        Divider()
        if !host.apiReachable {
            Button("Start host") {
                host.start()
                Task { await host.refreshStatus() }
            }
        } else {
            Text("Host API reachable")
        }
        if host.isRunning {
            Button("Stop app-owned host") {
                host.stop()
            }
        }
        Divider()
        Button("Quit ClankerSpanker") {
            NSApp.terminate(nil)
        }
    }

    private var statusLine: String {
        let api = host.apiReachable ? "API up" : "API down"
        let ws = appState.socket.isConnected ? "Live" : "WS off"
        return "\(api) · \(ws)"
    }
}

enum MacAppChrome {
    static func showMainWindow() {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        let windows = NSApp.windows.filter { w in
            // Skip status-item / menu-bar chrome windows
            let name = String(describing: type(of: w))
            return !name.contains("StatusBar") && !name.contains("MenuBar") && w.canBecomeKey
        }
        if let window = windows.first(where: \.isVisible) ?? windows.first {
            window.deminiaturize(nil)
            window.makeKeyAndOrderFront(nil)
        } else {
            // No main window — open one via open untitled / activate
            NSWorkspace.shared.open(URL(fileURLWithPath: Bundle.main.bundlePath))
            for w in NSApp.windows {
                w.makeKeyAndOrderFront(nil)
            }
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        UNUserNotificationCenter.current().delegate = self
        NotificationService.requestAuthorization()
        NSApp.setActivationPolicy(.regular)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        // Stay alive in the menu bar when the user closes the window
        false
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            MacAppChrome.showMainWindow()
        }
        return true
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .badge]
    }

    /// Approve/Reject tapped from a notification action button. Forwards
    /// (sessionId, hostId, approvalId, action) to AppState via NotificationCenter
    /// which then makes the API call.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let info = response.notification.request.content.userInfo
        let action = response.actionIdentifier
        let payload: [String: Any] = [
            "action": action,
            "userInfo": info,
        ]
        NotificationCenter.default.post(name: .dispatchNotificationAction, object: payload)
        completionHandler()
    }
}
#endif

#if os(iOS)
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        NotificationService.requestAuthorization()
        return true
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .badge]
    }

    /// Approve/Reject tapped from a notification action button. Forwards
    /// (sessionId, hostId, approvalId, action) to AppState via NotificationCenter
    /// which then makes the API call.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let info = response.notification.request.content.userInfo
        let action = response.actionIdentifier
        let payload: [String: Any] = [
            "action": action,
            "userInfo": info,
        ]
        NotificationCenter.default.post(name: .dispatchNotificationAction, object: payload)
        completionHandler()
    }
}
#endif
