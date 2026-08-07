import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var appState: AppState

    var body: some View {
        #if os(macOS)
        // Mac never uses phone TabView — even before "configured".
        // Bootstrap wires localhost; empty state still shows the command center.
        MacCommandCenter()
            .environmentObject(appState)
            .preferredColorScheme(.dark)
        #else
        Group {
            if appState.isConfigured {
                MainTabView()
            } else {
                OnboardingView()
            }
        }
        .animation(.easeInOut(duration: 0.25), value: appState.isConfigured)
        #endif
    }
}

// MARK: - iOS only

struct MainTabView: View {
    @EnvironmentObject private var appState: AppState

    var body: some View {
        TabView(selection: $appState.selectedTab) {
            DashboardView()
                .tabItem { Label("Sessions", systemImage: "rectangle.stack.fill") }
                .tag(AppTab.sessions)

            TaskComposerView()
                .tabItem { Label("Dispatch", systemImage: "paperplane.fill") }
                .tag(AppTab.compose)

            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape.fill") }
                .tag(AppTab.settings)
        }
        .tint(DispatchColors.accent)
    }
}

#Preview {
    ContentView()
        .environmentObject(AppState())
}
