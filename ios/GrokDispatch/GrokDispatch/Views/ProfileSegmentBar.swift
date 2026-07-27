import SwiftUI

/// Compact profile switcher: segmented control + one host subtitle line.
struct ProfileSegmentBar: View {
    @EnvironmentObject private var appState: AppState
    /// Optional: when set, keeps a local binding in sync (Dispatch compose).
    var selection: Binding<String?>? = nil
    var onChange: ((BoundProfile) -> Void)? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if appState.boundProfiles.isEmpty {
                Text("No profiles — add a host in Settings.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else if appState.boundProfiles.count <= 4 {
                // True segmented control when it fits
                Picker("Profile", selection: boundSelection) {
                    ForEach(appState.boundProfiles) { b in
                        Text(shortLabel(b)).tag(Optional(b.id))
                    }
                }
                .pickerStyle(.segmented)
                .onChange(of: boundSelection.wrappedValue) { _, newId in
                    guard let newId,
                          let b = appState.boundProfiles.first(where: { $0.id == newId })
                    else { return }
                    appState.selectBoundProfile(newId)
                    onChange?(b)
                }
            } else {
                // Overflow: menu with color dots
                Menu {
                    ForEach(appState.boundProfiles) { b in
                        Button {
                            boundSelection.wrappedValue = b.id
                            appState.selectBoundProfile(b.id)
                            onChange?(b)
                        } label: {
                            Label(b.displayName, systemImage: b.profile.isClaude ? "brain.head.profile" : "sparkles")
                        }
                    }
                } label: {
                    HStack {
                        if let b = selected {
                            Circle().fill(b.uiColor).frame(width: 8, height: 8)
                            Text(b.displayName).fontWeight(.semibold)
                            Text("· \(b.backendLabel)")
                                .foregroundStyle(.secondary)
                        } else {
                            Text("Select profile")
                        }
                        Spacer()
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .background(Color.white.opacity(0.08))
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
            }

            if let b = selected {
                HStack(spacing: 6) {
                    Circle().fill(b.uiColor).frame(width: 6, height: 6)
                    Text("\(b.backendLabel) · \(b.hostLabel)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if appState.hosts.count > 1 {
                        Text("· \(shortHostURL(b.host.baseURL))")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                .padding(.horizontal, 2)
            }
        }
    }

    private var selected: BoundProfile? {
        let id = boundSelection.wrappedValue
        return appState.boundProfiles.first { $0.id == id } ?? appState.selectedBoundProfile
    }

    private var boundSelection: Binding<String?> {
        if let selection { return selection }
        return Binding(
            get: { appState.selectedBoundProfileId ?? appState.boundProfiles.first?.id },
            set: { newValue in
                if let newValue {
                    appState.selectBoundProfile(newValue)
                }
            }
        )
    }

    /// Prefer full name when few profiles; short names when crowded.
    private func shortLabel(_ b: BoundProfile) -> String {
        let n = appState.boundProfiles.count
        if n <= 3 { return b.displayName }
        // Abbreviate long names for 4 segments
        let name = b.displayName
        if name.count <= 10 { return name }
        return String(name.prefix(8)) + "…"
    }

    private func shortHostURL(_ url: String) -> String {
        url
            .replacingOccurrences(of: "http://", with: "")
            .replacingOccurrences(of: "https://", with: "")
    }
}
