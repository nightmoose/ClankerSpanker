import SwiftUI

#if os(iOS)
/// App-wide top navigation: Sessions / Projects / Tasks / Dispatch / Settings.
/// Sits above every phone page (including session detail) so the home-indicator
/// zone stays free for content and the message field.
struct PhoneMainTabStrip: View {
    @EnvironmentObject private var appState: AppState

    var body: some View {
        HStack(spacing: 0) {
            tabButton(
                tab: .sessions,
                title: "Sessions",
                systemImage: "rectangle.stack.fill",
                badge: appState.attentionSessions.count
            )
            tabButton(tab: .projects, title: "Projects", systemImage: "folder.fill")
            tabButton(tab: .tasks, title: "Tasks", systemImage: "checklist")
            tabButton(tab: .compose, title: "Dispatch", systemImage: "paperplane.fill")
            tabButton(tab: .settings, title: "Settings", systemImage: "gearshape.fill")
        }
        .padding(.top, 2)
        .padding(.bottom, 6)
        .background(.ultraThinMaterial)
    }

    private func tabButton(
        tab: AppTab,
        title: String,
        systemImage: String,
        badge: Int = 0
    ) -> some View {
        let isSelected = appState.selectedTab == tab
        return Button {
            // Re-tap current tab → refresh that surface (no toolbar refresh).
            appState.activateTab(tab)
        } label: {
            VStack(spacing: 2) {
                ZStack(alignment: .topTrailing) {
                    Image(systemName: systemImage)
                        .font(.system(size: 19, weight: isSelected ? .semibold : .regular))
                        .frame(height: 22)
                    if badge > 0 {
                        Text(badge > 9 ? "9+" : "\(badge)")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .background(DispatchColors.warning)
                            .clipShape(Capsule())
                            .offset(x: 10, y: -6)
                    }
                }
                Text(title)
                    .font(.system(size: 10, weight: isSelected ? .semibold : .regular))
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            .frame(maxWidth: .infinity)
            .foregroundStyle(isSelected ? DispatchColors.accent : Color.secondary)
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
        .accessibilityValue(badge > 0 ? "\(badge) need attention" : "")
        .accessibilityHint(isSelected ? "Refreshes this tab" : "Switches to \(title)")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}
#endif
