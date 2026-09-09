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
                Button("Kickstart local host") {
                    LocalHostController.shared.start()
                }
                .keyboardShortcut("r", modifiers: [.command, .shift])
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
        // Menu-bar duties moved to ClankerSpankerHostTray (RFC-016);
        // closing the last window here means the user is done with the
        // command center, so quit.
        true
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

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        NotificationCenter.default.post(name: .dispatchDeviceToken, object: hex)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        print("[push] APNs registration failed: \(error.localizedDescription)")
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        // Foreground: WebSocket already posts a local banner. Remote APNs
        // should only refresh the badge so we do not double-notify.
        if notification.request.trigger is UNPushNotificationTrigger {
            return [.badge]
        }
        return [.banner, .sound, .badge]
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
