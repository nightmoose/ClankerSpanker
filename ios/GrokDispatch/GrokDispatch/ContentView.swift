import SwiftUI

/// Module-scoped once-per-process flag so the splash shows on cold launch
/// only — not on every scenePhase change / re-render of ContentView.
private enum SplashGate {
    static var shownThisSession: Bool = false
}

struct ContentView: View {
    @EnvironmentObject private var appState: AppState
    @State private var showSplash: Bool = !SplashGate.shownThisSession

    var body: some View {
        ZStack {
            rootContent

            if showSplash {
                SplashView {
                    withAnimation(.easeOut(duration: 0.2)) {
                        showSplash = false
                    }
                }
                .transition(.opacity)
                .zIndex(10)
                .onAppear { SplashGate.shownThisSession = true }
            }
        }
    }

    @ViewBuilder
    private var rootContent: some View {
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

#if os(iOS)
struct MainTabView: View {
    @EnvironmentObject private var appState: AppState

    var body: some View {
        // Top tab strip on every page (Sessions → Bots → Settings), including when a
        // session is open. No system bottom tab bar — frees the thumb zone.
        VStack(spacing: 0) {
            PhoneMainTabStrip()

            Group {
                switch appState.selectedTab {
                case .sessions:
                    DashboardView()
                case .projects:
                    ProjectsView()
                case .tasks:
                    TasksView()
                case .bots:
                    BotsView()
                case .terminal:
                    NavigationStack {
                        TerminalView()
                            #if os(iOS)
                            .toolbar(.hidden, for: .navigationBar)
                            #endif
                    }
                case .compose:
                    TaskComposerView()
                case .settings:
                    SettingsView()
                case .host:
                    // Mac-only tab; should never be selected on phone.
                    DashboardView()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .tint(DispatchColors.accent)
    }
}
#endif

#Preview {
    ContentView()
        .environmentObject(AppState())
}
