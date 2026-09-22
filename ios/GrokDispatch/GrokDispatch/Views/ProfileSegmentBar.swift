import SwiftUI

/// RFC-022: build the chip hover tooltip from a profile's usage.
/// Mirrors `host/src/reset-time.ts` — keep in sync.
enum ResetTimeFormatter {
    static func tooltip(for profile: AgentProfile, now: Date = Date()) -> String {
        var parts: [String] = [profile.name]
        if let usage = profile.usage {
            if let label = usage.label, !label.isEmpty {
                parts.append(label)
            } else if let status = usage.status, !status.isEmpty {
                parts.append("Usage \(status)")
            }
            if let line = resetLine(usage, now: now), !line.isEmpty {
                parts.append(line)
            }
        }
        return parts.joined(separator: " — ")
    }

    static func resetLine(_ usage: ProfileUsage, now: Date = Date()) -> String? {
        let five = formatRelative(usage.fiveHourResetsAt, now: now)
        let seven = formatRelative(usage.sevenDayResetsAt, now: now)
        let same =
            usage.fiveHourResetsAt != nil
            && usage.sevenDayResetsAt != nil
            && usage.fiveHourResetsAt == usage.sevenDayResetsAt
        if same, let seven { return "Weekly plan resets \(seven)" }
        if let five, let seven { return "5h resets \(five) · weekly resets \(seven)" }
        if let seven { return "Weekly plan resets \(seven)" }
        if let five { return "5h window resets \(five)" }
        return nil
    }

    static func formatRelative(_ iso: String?, now: Date = Date()) -> String? {
        guard let iso, let ts = ISO8601DateFormatter.flexible.date(from: iso) else { return nil }
        let diff = ts.timeIntervalSince(now)
        let MIN: TimeInterval = 60
        let HOUR: TimeInterval = 3600
        let DAY: TimeInterval = 86_400
        let WEEK: TimeInterval = 7 * DAY
        if diff <= 0 || diff >= WEEK {
            let df = DateFormatter()
            df.dateFormat = "MMM d"
            return df.string(from: ts)
        }
        if diff < MIN { return "in <1m" }
        if diff < HOUR { return "in \(Int(diff / MIN))m" }
        if diff < 6 * HOUR {
            let h = Int(diff / HOUR)
            let m = Int(diff.truncatingRemainder(dividingBy: HOUR) / MIN)
            return m > 0 ? "in \(h)h \(m)m" : "in \(h)h"
        }
        if diff < DAY { return "in \(Int(diff / HOUR))h" }
        let d = Int(diff / DAY)
        if d >= 4 { return "in \(d)d" }
        let h = Int(diff.truncatingRemainder(dividingBy: DAY) / HOUR)
        return h > 0 ? "in \(d)d \(h)h" : "in \(d)d"
    }
}

/// Horizontal colored profile pills.
///
/// Two modes:
/// - **Filter** (default, no `selection` binding): multi-select on/off chips.
///   All chips on ⇒ show every session. Subset ⇒ filter. No "All" button.
/// - **Picker** (`selection` binding set, e.g. Dispatch): single-select radio
///   for "who runs this task".
///
/// Usage is chip-only: same used-% format for every backend (Claude 5h/wk peak, Grok weekly credits).
struct ProfileSegmentBar: View {
    @EnvironmentObject private var appState: AppState
    /// When set, chips act as a single-select radio (Dispatch composer).
    var selection: Binding<String?>? = nil
    var onChange: ((BoundProfile) -> Void)? = nil
    /// Unused — kept so older call sites compile. "All" chip is gone.
    var includeAll: Bool = true
    var refreshUsage: Bool = true
    /// Show the "backend · host" caption under the pill row. Callers that
    /// already display host / count context nearby (Dashboard) can suppress it.
    var showsContext: Bool = true

    /// Single-select (composer) vs multi-select filter (Sessions / Mac).
    private var isSingleSelect: Bool { selection != nil }

    @State private var focusedChipID: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if visibleProfiles.isEmpty {
                Text("No profiles — add a host in Settings.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                chipScroller
                contextCaption
            }
        }
        .task(id: refreshUsage) {
            guard refreshUsage else { return }
            await appState.refreshProfileUsage()
            while !Task.isCancelled && refreshUsage {
                try? await Task.sleep(nanoseconds: 60_000_000_000)
                guard !Task.isCancelled else { break }
                await appState.refreshProfileUsage()
            }
        }
    }

    @ViewBuilder
    private var chipScroller: some View {
        ScrollViewReader { proxy in
            HStack(spacing: 4) {
                #if os(macOS)
                if visibleProfiles.count > 2 {
                    Button {
                        nudgeFocusedChip(-1, proxy: proxy)
                    } label: {
                        Image(systemName: "chevron.left")
                            .font(.caption.weight(.semibold))
                            .frame(width: 18, height: 28)
                    }
                    .buttonStyle(.plain)
                    .help("Show earlier profiles")
                    .disabled(focusedChipID == visibleProfiles.first?.id)
                }
                #endif
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(visibleProfiles) { b in
                            pill(
                                title: label(for: b),
                                subtitle: usageSubtitle(for: b.profile),
                                color: b.uiColor,
                                selected: isSelected(b),
                                systemImage: b.profile.systemImage,
                                traffic: b.profile.usage?.trafficColor
                            ) {
                                activate(b)
                            }
                            .id(b.id)
                            .fixedSize(horizontal: true, vertical: false)
                            .help(ResetTimeFormatter.tooltip(for: b.profile))
                        }
                    }
                    .padding(.vertical, 2)
                    // Force the row to its natural width so chips overflow into
                    // the scroll view instead of compressing until they're unreadable.
                    .fixedSize(horizontal: true, vertical: false)
                    .scrollTargetLayout()
                    #if os(macOS)
                    // Placed INSIDE the scroll content so its superview chain
                    // climbs through NSClipView to the NSScrollView we want to
                    // silence. `.scrollIndicators(.hidden)` isn't enough when
                    // the user has "Always show scroll bars" system-wide.
                    .background(HideNSScrollers())
                    #endif
                }
                .scrollIndicators(.hidden)
                #if !os(macOS)
                .scrollTargetBehavior(.viewAligned)
                .scrollBounceBehavior(.basedOnSize, axes: .vertical)
                #endif
                #if os(macOS)
                if visibleProfiles.count > 2 {
                    Button {
                        nudgeFocusedChip(1, proxy: proxy)
                    } label: {
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.semibold))
                            .frame(width: 18, height: 28)
                    }
                    .buttonStyle(.plain)
                    .help("Show later profiles")
                    .disabled(focusedChipID == visibleProfiles.last?.id)
                }
                #endif
            }
            .onAppear {
                if focusedChipID == nil {
                    focusedChipID = visibleProfiles.first?.id
                }
            }
            .onChange(of: focusedChipID) { _, newID in
                guard let newID else { return }
                withAnimation(.easeInOut(duration: 0.15)) {
                    proxy.scrollTo(newID, anchor: .center)
                }
            }
        }
    }

    @ViewBuilder
    private var contextCaption: some View {
        if showsContext, let b = contextBound {
            HStack(spacing: 6) {
                Circle().fill(b.uiColor).frame(width: 6, height: 6)
                Text("\(b.backendLabel) · \(b.hostLabel)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if showHostURL {
                    Text("· \(shortHostURL(b.host.baseURL))")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            .padding(.horizontal, 2)
        } else if showsContext, !isSingleSelect, appState.showsAllProfiles {
            // RFC-024: "All profiles · N hosts" when the chip mode actually
            // spans multiple hosts (was: only showed selectedHost.name,
            // which lied about scope in multi-host installs).
            let hostCount = appState.hosts.count
            HStack(spacing: 6) {
                Circle().fill(DispatchColors.accent).frame(width: 6, height: 6)
                if hostCount > 1 {
                    Text("All profiles · \(hostCount) hosts")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else if let host = appState.selectedHost {
                    Text("All profiles · \(host.name)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if showHostURL {
                        Text("· \(shortHostURL(host.baseURL))")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                } else {
                    Text("All profiles")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 2)
        } else if showsContext, !isSingleSelect, appState.enabledBoundProfiles.count > 1 {
            HStack(spacing: 6) {
                Circle().fill(DispatchColors.accent).frame(width: 6, height: 6)
                Text("\(appState.enabledBoundProfiles.count) profiles")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 2)
        }
    }

    private var visibleProfiles: [BoundProfile] {
        appState.visibleBoundProfiles
    }

    private func nudgeFocusedChip(_ delta: Int, proxy: ScrollViewProxy) {
        let ids = visibleProfiles.map(\.id)
        guard !ids.isEmpty else { return }
        let current = focusedChipID.flatMap { ids.firstIndex(of: $0) } ?? 0
        let next = min(max(current + delta, 0), ids.count - 1)
        focusedChipID = ids[next]
        withAnimation(.easeInOut(duration: 0.15)) {
            proxy.scrollTo(ids[next], anchor: .center)
        }
    }

    private func isSelected(_ b: BoundProfile) -> Bool {
        if let selection {
            return selection.wrappedValue == b.id
        }
        return appState.enabledBoundProfileIds.contains(b.id)
    }

    private var contextBound: BoundProfile? {
        if let selection, let id = selection.wrappedValue {
            return appState.boundProfiles.first { $0.id == id }
        }
        if isSingleSelect { return nil }
        if appState.showsAllProfiles { return nil }
        if appState.enabledBoundProfiles.count == 1 {
            return appState.enabledBoundProfiles.first
        }
        return nil
    }

    private var showHostURL: Bool {
        Set(appState.hosts.map(\.endpointKey)).count > 1
    }

    private func activate(_ b: BoundProfile) {
        if let selection {
            // Radio: pick this profile for compose
            selection.wrappedValue = b.id
            appState.selectBoundProfile(b.id)
            onChange?(b)
            return
        }
        // Filter: toggle chip on/off
        appState.toggleBoundProfile(b.id)
        if appState.enabledBoundProfileIds.contains(b.id) {
            onChange?(b)
        }
    }

    private func label(for b: BoundProfile) -> String {
        let sameName = appState.boundProfiles.filter { $0.displayName == b.displayName }
        if sameName.count > 1 {
            return "\(b.displayName) · \(b.hostLabel)"
        }
        return b.displayName
    }

    /// Used % only — same format for Claude, Grok, etc.
    private func usageSubtitle(for profile: AgentProfile) -> String? {
        guard let usage = profile.usage else { return nil }
        if let peak = usage.peakUsedPercent {
            return "\(Int(peak.rounded()))%"
        }
        // Prefer weekly window when peak is empty but week is set
        if let week = usage.sevenDayPercent {
            return "\(Int(week.rounded()))%"
        }
        if let five = usage.fiveHourPercent {
            return "\(Int(five.rounded()))%"
        }
        switch usage.status {
        case "limited": return "100%"
        case "api_key": return "key"
        case "ok": return "ready"
        case "unknown": return "?"
        case "error": return "…"
        default: return usage.canWork == false ? "!" : nil
        }
    }

    private func shortHostURL(_ url: String) -> String {
        url
            .replacingOccurrences(of: "http://", with: "")
            .replacingOccurrences(of: "https://", with: "")
    }

    private func pill(
        title: String,
        subtitle: String?,
        color: Color,
        selected: Bool,
        systemImage: String,
        traffic: Color?,
        action: @escaping () -> Void
    ) -> some View {
        // Always render the second row so the pill height doesn't wiggle
        // between refreshes (usage number disappears → chip shrinks otherwise).
        // "Usage" acts as a stable placeholder until numbers are back.
        // The traffic dot lives on that same row and is always present —
        // grey until usage arrives — so the capsule width doesn't jump when
        // the colored ball appears.
        let subtitleText = subtitle ?? "Usage"
        let subtitleIsPlaceholder = subtitle == nil
        let dotColor: Color = {
            if subtitleIsPlaceholder { return selected ? Color.black.opacity(0.28) : Color.secondary.opacity(0.55) }
            return traffic ?? (selected ? Color.black.opacity(0.45) : Color.secondary)
        }()
        return Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: systemImage)
                    .font(.caption.weight(.semibold))
                VStack(alignment: .leading, spacing: 1) {
                    Text(title)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                    HStack(spacing: 4) {
                        Circle()
                            .fill(dotColor)
                            .frame(width: 6, height: 6)
                        Text(subtitleText)
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(
                                selected
                                    ? Color.black.opacity(subtitleIsPlaceholder ? 0.45 : 0.75)
                                    : (subtitleIsPlaceholder ? .secondary : (traffic ?? .secondary))
                            )
                            .lineLimit(1)
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .foregroundStyle(selected ? Color.black : color)
            .background(
                Capsule()
                    .fill(selected ? color : color.opacity(0.14))
            )
            .overlay(
                Capsule()
                    .strokeBorder(color.opacity(selected ? 0 : 0.35), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel(subtitleIsPlaceholder ? title : "\(title), \(subtitleText) used")
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityHint(isSingleSelect ? "Select profile" : (selected ? "Filter on, double tap to turn off" : "Filter off, double tap to turn on"))
    }
}

#if os(macOS)
import AppKit

/// Background helper that finds the enclosing NSScrollView and disables its
/// scrollers, working around SwiftUI's `.scrollIndicators(.hidden)` being
/// ignored when the user has "Always show scroll bars" set system-wide.
///
/// SwiftUI mounts the NSScrollView asynchronously and its exact spot in the
/// hierarchy shifts between OS versions, so we retry a few times and also
/// scan up + across (parent subtree) instead of only walking superviews.
private struct HideNSScrollers: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        let view = NSView(frame: .zero)
        scheduleHide(from: view, attempts: 8)
        return view
    }
    func updateNSView(_ nsView: NSView, context: Context) {
        scheduleHide(from: nsView, attempts: 3)
    }
    private func scheduleHide(from view: NSView, attempts: Int) {
        DispatchQueue.main.async {
            if hide(from: view) { return }
            guard attempts > 1 else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                scheduleHide(from: view, attempts: attempts - 1)
            }
        }
    }
    @discardableResult
    private func hide(from view: NSView) -> Bool {
        // Walk up until we hit an NSScrollView, then scan siblings under each
        // ancestor as a fallback.
        var current: NSView? = view
        while let v = current {
            if let scroll = v as? NSScrollView {
                disable(scroll)
                return true
            }
            if let parent = v.superview,
               let scroll = firstScrollView(in: parent, skipping: v) {
                disable(scroll)
                return true
            }
            current = v.superview
        }
        return false
    }
    private func firstScrollView(in view: NSView, skipping: NSView?) -> NSScrollView? {
        if let sv = view as? NSScrollView { return sv }
        for sub in view.subviews where sub !== skipping {
            if let hit = firstScrollView(in: sub, skipping: nil) { return hit }
        }
        return nil
    }
    private func disable(_ scroll: NSScrollView) {
        scroll.hasHorizontalScroller = false
        scroll.hasVerticalScroller = false
        scroll.scrollerStyle = .overlay
        scroll.autohidesScrollers = true
        scroll.horizontalScroller?.isHidden = true
        scroll.verticalScroller?.isHidden = true
    }
}
#endif
