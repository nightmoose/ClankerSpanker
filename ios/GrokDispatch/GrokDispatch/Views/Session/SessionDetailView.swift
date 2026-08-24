import SwiftUI
import PhotosUI
#if canImport(UIKit)
import UIKit
#endif
#if os(macOS)
import AppKit
import UniformTypeIdentifiers
#endif

struct SessionDetailView: View {
    @EnvironmentObject private var appState: AppState
    @StateObject private var vm: SessionDetailViewModel
    @State private var selectedTab = DetailTab.transcript
    @State private var chatOnly = false
    @State private var isEditingTitle = false
    @State private var draftTitle = ""
    @State private var photoPickerItems: [PhotosPickerItem] = []
    @State private var showCamera = false
    @State private var transferTarget: BoundProfile?
    @State private var showTransferConfirm = false
    @State private var showReincarnateConfirm = false
    @State private var isReincarnating = false
    @State private var reviewTarget: BoundProfile?
    @State private var showReviewConfirm = false
    @State private var isReviewing = false
    @State private var showLoginSheet = false
    @State private var loginMessage: String?
    @State private var isStartingLogin = false
    /// When set, suppress the login banner until the server sends a session
    /// snapshot with an `updatedAt` strictly newer than this value. A fresh
    /// snapshot means a new turn has happened and re-triggers the normal
    /// needsReLogin check — so a genuine subsequent auth failure will
    /// re-surface the banner.
    @State private var loginAckedForUpdatedAt: String?
    /// Projects available on the current host — loaded on demand so the
    /// "Move to project…" menu is populated even if the user opens session
    /// detail before visiting the Projects surface.
    @State private var projectChoices: [ProjectInfo] = []
    @State private var captureSheet: CaptureSheet?
    /// When set, the transcript scrolls to this entry id after its ScrollViewReader
    /// picks up the change. Used by "Jump to message" from Notes/Tasks rows.
    @State private var pendingScrollToMessageId: String?
    /// Open the expanded markdown viewer on this entry (todo / jump).
    @State private var expandMessageId: String?
    private let initialMessageId: String?
    @State private var showDeleteConfirm = false
    @State private var showSessionDetails = false
    @Environment(\.dismiss) private var dismissView
    @FocusState private var followUpFocused: Bool
    #if os(macOS)
    @State private var isDropTargeted = false
    #endif
    /// Sentinel view id at the bottom of the transcript we scroll to when
    /// new content arrives — standard chat behavior.
    static let transcriptBottomAnchor = "__transcript_bottom__"

    enum DetailTab: String, CaseIterable {
        case transcript = "Transcript"
        case tools = "Tools"
        case plan = "Plan"
        case diff = "Diff"
        case notes = "Notes"
    }

    private enum CaptureSheet: Identifiable {
        case saveAsTodo(TranscriptEntry)
        case scanForTodo(TranscriptEntry)
        case makeNote(TranscriptEntry)
        var id: String {
            switch self {
            case .saveAsTodo(let e): return "todo-\(e.id)"
            case .scanForTodo(let e): return "scan-\(e.id)"
            case .makeNote(let e): return "note-\(e.id)"
            }
        }
    }

    init(sessionId: String, host: HostEndpoint, scrollToMessageId: String? = nil) {
        _vm = StateObject(wrappedValue: SessionDetailViewModel(sessionId: sessionId, host: host))
        self.initialMessageId = scrollToMessageId
    }

    private var canSendFollowUp: Bool {
        let hasText = !vm.followUp.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return !vm.isSending && (hasText || !vm.pendingImages.isEmpty)
    }

    var body: some View {
        ZStack {
            DispatchBackground()
            VStack(spacing: 0) {
                if let detail = vm.detail {
                    // App tabs live in MainTabView (very top). Here: meta → section → content.
                    header(detail)
                    sectionPicker

                    if needsReLogin(detail) {
                        loginBanner(for: detail)
                    }

                    transcriptScroll(detail)

                    if let pendingQ = detail.pendingQuestion {
                        QuestionBarView(
                            pending: pendingQ,
                            selectedAnswers: $vm.selectedAnswers,
                            comment: $vm.comment,
                            isActing: vm.isResolving,
                            onSubmit: { Task { await vm.submitQuestionAnswers(api: appState.api) } }
                        )
                    } else if vm.visibleApproval != nil || detail.status == .awaitingApproval {
                        ApprovalBarView(
                            approval: vm.visibleApproval ?? detail.pendingApproval,
                            comment: $vm.comment,
                            isActing: vm.isResolving,
                            onApprove: { Task { await vm.approve(api: appState.api) } },
                            onReject: { Task { await vm.reject(api: appState.api) } },
                            onApproveAlways: { Task { await vm.approveAlways(api: appState.api) } }
                        )
                    } else if detail.status.allowsFollowUp || detail.status == .failed {
                        followUpBar
                    }
                } else if vm.isLoading {
                    ProgressView("Loading session…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let err = vm.errorMessage {
                    Text(err)
                        .foregroundStyle(DispatchColors.danger)
                        .padding()
                }
            }
            #if os(macOS)
            if isDropTargeted {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(DispatchColors.accent, style: StrokeStyle(lineWidth: 2, dash: [7, 5]))
                    .background(DispatchColors.accent.opacity(0.12))
                    .overlay {
                        Text("Drop screenshot to attach")
                            .font(.headline)
                            .foregroundStyle(DispatchColors.accent)
                    }
                    .padding(12)
                    .allowsHitTesting(false)
            }
            #endif
        }
        #if os(macOS)
        .onDrop(
            of: [.image, .png, .jpeg, .gif, .webP, .tiff, .bmp, .heic, .fileURL],
            isTargeted: $isDropTargeted
        ) { providers in
            ingestDroppedProviders(providers)
            return true
        }
        .onPasteCommand(of: [.image, .png, .jpeg, .tiff, .gif, .fileURL]) { providers in
            ingestDroppedProviders(providers)
        }
        #endif
        .navigationTitle(isEditingTitle ? "Rename" : (vm.detail?.title ?? "Session"))
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button {
                        draftTitle = vm.detail?.title ?? ""
                        isEditingTitle = true
                    } label: {
                        Label("Rename session", systemImage: "pencil")
                    }

                    let transferOptions = transferCandidates
                    if !transferOptions.isEmpty {
                        Menu {
                            ForEach(transferOptions) { bound in
                                Button {
                                    transferTarget = bound
                                    showTransferConfirm = true
                                } label: {
                                    Label(
                                        "\(bound.displayName) · \(bound.backendLabel)",
                                        systemImage: bound.profile.systemImage
                                    )
                                }
                            }
                        } label: {
                            Label("Transfer to profile…", systemImage: "arrow.left.arrow.right")
                        }
                    }

                    let reviewOptions = reviewCandidates
                    if !reviewOptions.isEmpty {
                        Menu {
                            ForEach(reviewOptions) { bound in
                                Button {
                                    reviewTarget = bound
                                    showReviewConfirm = true
                                } label: {
                                    Label(
                                        "\(bound.displayName) · \(bound.backendLabel)",
                                        systemImage: bound.profile.systemImage
                                    )
                                }
                            }
                        } label: {
                            Label("Review recent work…", systemImage: "text.magnifyingglass")
                        }
                    }

                    // "Move to project…" — populates lazily on first open.
                    Menu {
                        // "Detach" option when the session is currently in a project
                        if let currentPid = vm.detail?.projectId, !currentPid.isEmpty {
                            Button(role: .destructive) {
                                Task { await vm.setProject(api: appState.api, projectId: nil) }
                            } label: {
                                Label("Detach from project", systemImage: "xmark.circle")
                            }
                            Divider()
                        }
                        if projectChoices.isEmpty {
                            Text("No projects on this host")
                        } else {
                            ForEach(projectChoices) { p in
                                Button {
                                    Task { await vm.setProject(api: appState.api, projectId: p.id) }
                                } label: {
                                    if vm.detail?.projectId == p.id {
                                        Label("\(p.name)  ✓", systemImage: "folder.fill")
                                    } else {
                                        Label(p.name, systemImage: "folder")
                                    }
                                }
                            }
                        }
                    } label: {
                        Label("Move to project…", systemImage: "folder.badge.plus")
                    }
                    .onAppear { Task { await loadProjectChoices() } }

                    if vm.detail?.isArchived != true {
                        Button {
                            showReincarnateConfirm = true
                        } label: {
                            Label("Reincarnate…", systemImage: "arrow.triangle.2.circlepath")
                        }
                    }

                    if vm.detail?.isArchived == true {
                        Button {
                            Task { await vm.unarchive(api: appState.api) }
                        } label: {
                            Label("Unarchive", systemImage: "tray.and.arrow.up")
                        }
                    } else {
                        Button {
                            Task { await vm.archive(api: appState.api) }
                        } label: {
                            Label("Archive", systemImage: "archivebox")
                        }
                    }
                    Button {
                        Task { await vm.closeAsDone(api: appState.api) }
                    } label: {
                        Label("Close as done", systemImage: "checkmark.seal")
                    }
                    Button("Refresh") {
                        Task {
                            await vm.load(api: appState.api)
                            await vm.loadDiff(api: appState.api)
                        }
                    }
                    Divider()
                    Button("Cancel session", role: .destructive) {
                        Task { await vm.cancel(api: appState.api) }
                    }
                    Button("Delete permanently…", role: .destructive) {
                        showDeleteConfirm = true
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
            }
        }
        .alert("Sign in required", isPresented: $showLoginSheet) {
            Button("Open login on this Mac") {
                Task { await startProfileLogin() }
            }
            .disabled(isStartingLogin)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(loginMessage ?? "This profile’s OAuth session expired or was revoked. Sign in on the host Mac, then retry.")
        }
        .onChange(of: vm.detail?.error) { _, newVal in
            if let d = vm.detail, needsReLogin(d), !showLoginSheet {
                loginMessage = reLoginMessage(for: d)
                showLoginSheet = true
            }
        }
        .alert("Session name", isPresented: $isEditingTitle) {
            TextField("Name", text: $draftTitle)
            Button("Cancel", role: .cancel) {}
            Button("Save") {
                let title = draftTitle
                Task { await vm.rename(api: appState.api, title: title) }
            }
        } message: {
            Text("Shown in the session list and navigation bar.")
        }
        .confirmationDialog(
            transferConfirmTitle,
            isPresented: $showTransferConfirm,
            titleVisibility: .visible
        ) {
            if let target = transferTarget {
                Button("Transfer to \(target.displayName)", role: .destructive) {
                    Task {
                        let newId = await vm.transfer(api: appState.api, profileId: target.profile.id)
                        // Mac sidebar selection follows the new Active continuation
                        if let newId {
                            appState.macSelectedSessionId = newId
                        }
                        // Filter chips: show the target profile's Active list
                        if let bound = appState.boundProfiles.first(where: {
                            $0.profile.id == target.profile.id && $0.host.id == vm.host.id
                        }) {
                            appState.selectBoundProfile(bound.id)
                        }
                        await appState.refreshSessions()
                    }
                }
            }
            Button("Cancel", role: .cancel) {
                transferTarget = nil
            }
        } message: {
            Text(transferConfirmMessage)
        }
        .confirmationDialog(
            "Reincarnate this session?",
            isPresented: $showReincarnateConfirm,
            titleVisibility: .visible
        ) {
            Button("Reincarnate", role: .destructive) {
                Task {
                    isReincarnating = true
                    defer { isReincarnating = false }
                    let newId = await vm.reincarnate(api: appState.api)
                    if let newId {
                        appState.macSelectedSessionId = newId
                    }
                    await appState.refreshSessions()
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(
                "Archives this chat and opens a fresh session in the same project, " +
                "seeded with a compact summary (plan + highlights). " +
                "Use when context feels bloated after weeks of work."
            )
        }
        .confirmationDialog(
            "Delete this session permanently?",
            isPresented: $showDeleteConfirm,
            titleVisibility: .visible
        ) {
            Button("Delete permanently", role: .destructive) {
                Task {
                    let ok = await vm.deletePermanently(api: appState.api)
                    if ok {
                        await appState.refreshSessions()
                        #if os(macOS)
                        // Detail is the split-view pane — dismiss() closes the whole window.
                        appState.macSelectedSessionId = nil
                        #else
                        dismissView()
                        #endif
                    }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(
                "Removes the session JSON, its attachments, and its tasks and notes. " +
                "Project attachments already promoted from this session stay in the project. " +
                "This cannot be undone."
            )
        }
        .confirmationDialog(
            reviewConfirmTitle,
            isPresented: $showReviewConfirm,
            titleVisibility: .visible
        ) {
            if let target = reviewTarget {
                Button("Start review as \(target.displayName)") {
                    Task {
                        isReviewing = true
                        defer { isReviewing = false }
                        let newId = await vm.reviewWork(
                            api: appState.api,
                            profileId: target.profile.id
                        )
                        if let newId {
                            // Detail VM already switched to the review; keep Mac list in sync.
                            appState.macSelectedSessionId = newId
                            if let bound = appState.boundProfiles.first(where: {
                                $0.profile.id == target.profile.id && $0.host.id == vm.host.id
                            }) {
                                appState.selectBoundProfile(bound.id)
                            }
                        }
                        await appState.refreshSessions()
                    }
                }
            }
            Button("Cancel", role: .cancel) {
                reviewTarget = nil
            }
        } message: {
            Text(reviewConfirmMessage)
        }
        .overlay {
            if isReincarnating || isReviewing {
                ZStack {
                    Color.black.opacity(0.35).ignoresSafeArea()
                    ProgressView(isReviewing ? "Starting review…" : "Reincarnating…")
                        .padding(20)
                        .background(.ultraThinMaterial)
                        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
            }
        }
        .task {
            await vm.load(api: appState.api)
            await vm.loadDiff(api: appState.api)
            if let mid = initialMessageId, !mid.isEmpty {
                selectedTab = .transcript
                pendingScrollToMessageId = mid
                expandMessageId = mid
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .dispatchSocketEvent)) { note in
            guard let data = note.object as? Data else { return }
            Task { await vm.handleSocketAndReload(api: appState.api, data: data) }
        }
        .onReceive(NotificationCenter.default.publisher(for: .dispatchSocketReconnected)) { _ in
            Task { await vm.replayMissedEvents(api: appState.api) }
        }
        .sheet(item: $captureSheet) { sheet in
            switch sheet {
            case .saveAsTodo(let entry):
                SaveAsTodoSheet(
                    sourceMessageId: entry.id,
                    initialText: entry.text,
                    sessionId: vm.sessionId,
                    host: vm.host,
                    onSaved: { _ in
                        captureSheet = nil
                        Task { await vm.load(api: appState.api) }
                    },
                    onCancel: { captureSheet = nil }
                )
                .environmentObject(appState)
            case .scanForTodo(let entry):
                ScanForTodoSheet(
                    sourceMessageId: entry.id,
                    sourceText: entry.text,
                    sessionId: vm.sessionId,
                    host: vm.host,
                    onSaved: { _ in
                        captureSheet = nil
                        Task { await vm.load(api: appState.api) }
                    },
                    onCancel: { captureSheet = nil }
                )
                .environmentObject(appState)
            case .makeNote(let entry):
                MakeNoteSheet(
                    sourceMessageId: entry.id,
                    sessionId: vm.sessionId,
                    host: vm.host,
                    onSaved: { _ in
                        captureSheet = nil
                        Task { await vm.load(api: appState.api) }
                    },
                    onCancel: { captureSheet = nil }
                )
                .environmentObject(appState)
            }
        }
        .sheet(isPresented: $showSessionDetails) {
            if let detail = vm.detail {
                SessionDetailsSheet(detail: detail, agentLabel: agentLabel(for: detail))
            }
        }
    }

    /// Profiles on this host, excluding the session's current profile.

    private func agentLabel(for detail: SessionDetail) -> String {
        if let name = detail.profileName, !name.isEmpty { return name }
        switch detail.backend?.lowercased() {
        case "claude": return "Claude"
        case "antigravity", "agy": return "Antigravity"
        case "bot": return "Bot"
        case "grok": return "Grok"
        default: return detail.backend?.capitalized ?? "Agent"
        }
    }

    private func needsReLogin(_ detail: SessionDetail) -> Bool {
        // Hunter HTTP 403 is a stale CLI access token, not "NightMoose ACP
        // signed out". ACP can still be live (this chat). Don't nag Sign in.
        if detail.backend?.lowercased() == "bot" { return false }

        // User just completed a successful login on the host — hide the
        // banner until the server produces a newer snapshot (a fresh turn,
        // which will re-run the checks below and re-show if auth broke
        // again).
        if let acked = loginAckedForUpdatedAt, detail.updatedAt <= acked {
            return false
        }

        // Session actively doing work → user's already moved past whatever
        // error came before. Never nag with the login banner mid-turn.
        switch detail.status {
        case .running, .queued, .awaitingApproval, .awaitingQuestion:
            return false
        default:
            break
        }

        // Primary: current error field is the source of truth for the
        // most recent turn's failure state.
        if let e = detail.error?.lowercased(), containsAuthMarker(e) {
            return true
        }

        // Fallback: if the last transcript entry is from the agent AND
        // carries an auth marker, honor it. If the last entry is from the
        // user, the user has already sent a follow-up past the error —
        // suppress the banner. This is the fix for "banner stays after
        // successful login": historical auth errors in older transcript
        // entries no longer drive visibility.
        guard let last = detail.transcript.last, last.role != "user" else {
            return false
        }
        return containsAuthMarker(last.text.lowercased())
    }

    private func transcriptScroll(_ detail: SessionDetail) -> some View {
        TranscriptScrollPane(
            detail: detail,
            selectedTab: selectedTab,
            streamingText: vm.streamingText,
            pendingScrollToMessageId: $pendingScrollToMessageId,
            content: { content(for: detail).padding() }
        )
    }

    private func loadProjectChoices() async {
        do {
            let res = try await appState.api.projects(host: vm.host)
            projectChoices = res.projects
                .filter { !$0.isArchived }
                .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        } catch {
            // Silent — the menu just shows the empty-state text.
        }
    }

    private func containsAuthMarker(_ e: String) -> Bool {
        e.contains("oauth")
            || e.contains("access token")
            || e.contains("failed to authenticate")
            || e.contains("authentication_error")
            || e.contains("not logged in")
            || e.contains("sign-in required")
            || e.contains("please run /login")
            || (e.contains("401") && (e.contains("auth") || e.contains("token")))
    }

    private func reLoginMessage(for detail: SessionDetail) -> String {
        let name = detail.profileName ?? detail.profileId ?? "This profile"
        return "\(name) needs to sign in again (OAuth revoked or expired). This opens a browser on the host Mac — complete login there, then send another message."
    }

    @ViewBuilder
    private func loginBanner(for detail: SessionDetail) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "person.crop.circle.badge.exclamationmark")
                    .foregroundStyle(DispatchColors.danger)
                Text("Sign-in required")
                    .font(.subheadline.weight(.bold))
                Spacer()
                Button {
                    // Manual dismiss — for the case where the user has
                    // already logged in outside the app. If auth is still
                    // broken, the next turn will re-surface the banner.
                    loginAckedForUpdatedAt = vm.detail?.updatedAt
                } label: {
                    Image(systemName: "xmark")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .padding(6)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Dismiss sign-in banner")
            }
            Text(reLoginMessage(for: detail))
                .font(.caption)
                .foregroundStyle(.secondary)
            Button {
                loginMessage = reLoginMessage(for: detail)
                showLoginSheet = true
            } label: {
                Label(
                    isStartingLogin ? "Opening login…" : "Sign in \(detail.profileName ?? "profile")…",
                    systemImage: "arrow.up.forward.app"
                )
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(DispatchColors.danger)
            .disabled(isStartingLogin)
        }
        .padding(12)
        .background(DispatchColors.danger.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .padding(.horizontal)
        .padding(.top, 8)
    }

    private func startProfileLogin() async {
        guard let detail = vm.detail else { return }
        let profileId = detail.profileId
        guard let profileId, !profileId.isEmpty else {
            vm.errorMessage = "No profile on this session"
            return
        }
        isStartingLogin = true
        defer { isStartingLogin = false }
        do {
            let email = appState.boundProfiles.first(where: {
                $0.profile.id == profileId && $0.host.endpointKey == vm.host.endpointKey
            })?.profile.usage?.accountEmail
            let res = try await appState.api.loginProfile(id: profileId, host: vm.host, email: email)
            if res.ok == false {
                loginMessage = res.error ?? "Login failed"
                showLoginSheet = true
            } else {
                loginMessage = res.message ?? "Browser opened on host — finish sign-in, then retry."
                // Keep sheet message updated via alert already dismissed; show non-blocking via errorMessage
                vm.errorMessage = nil
                // Suppress the login banner until a newer session snapshot
                // arrives from the server. If auth is genuinely still broken,
                // the next turn's failure will re-trigger it.
                loginAckedForUpdatedAt = vm.detail?.updatedAt
            }
        } catch {
            loginMessage = error.localizedDescription
            showLoginSheet = true
        }
    }

    private var transferCandidates: [BoundProfile] {
        let current = vm.detail?.profileId
        let hostId = vm.host.id
        return appState.boundProfiles.filter { b in
            b.host.id == hostId && b.profile.id != current
        }
    }

    /// All profiles on this host (including current) — same agent or a second opinion.
    private var reviewCandidates: [BoundProfile] {
        let hostId = vm.host.id
        return appState.boundProfiles.filter { $0.host.id == hostId }
    }

    private var transferConfirmTitle: String {
        if let t = transferTarget {
            return "Transfer to \(t.displayName)?"
        }
        return "Transfer session?"
    }

    private var transferConfirmMessage: String {
        guard let t = transferTarget else {
            return "Move this chat to another agent profile."
        }
        let from = vm.detail?.profileName ?? "current profile"
        return """
        Full transfer from \(from) → \(t.displayName) (\(t.backendLabel)). \
        This session is Archived under \(from). \
        A new Active session continues under \(t.displayName) with the same transcript.
        """
    }

    private var reviewConfirmTitle: String {
        if let t = reviewTarget {
            return "Review as \(t.displayName)?"
        }
        return "Review recent work?"
    }

    private var reviewConfirmMessage: String {
        let reviewer = reviewTarget?.displayName ?? "the selected agent"
        return """
        Opens a new “Review · …” session run by \(reviewer). \
        It reads this chat’s history and the git diff, then writes a critique and improvement list. \
        This session stays Active and is not transferred or archived.
        """
    }

    /// Compact meta: profile + status only. Model / cwd / usage / prompt live
    /// in the session details sheet (info button).
    private func header(_ detail: SessionDetail) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Button {
                    showSessionDetails = true
                } label: {
                    HStack(spacing: 6) {
                        if let name = detail.profileName, !name.isEmpty {
                            Text(name)
                                .font(.caption2.weight(.bold))
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .foregroundStyle(Color(hex: detail.profileColor ?? "") ?? DispatchColors.accent)
                                .background((Color(hex: detail.profileColor ?? "") ?? DispatchColors.accent).opacity(0.15))
                                .clipShape(Capsule())
                        }
                        if detail.isArchived {
                            Text("Archived")
                                .font(.caption2.weight(.bold))
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .foregroundStyle(.orange)
                                .background(Color.orange.opacity(0.15))
                                .clipShape(Capsule())
                        }
                        Image(systemName: "info.circle")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Session details")

                Spacer(minLength: 8)
                StatusBadge(status: detail.status)
            }
            if let error = detail.error, !error.isEmpty {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(DispatchColors.danger)
                    .lineLimit(2)
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
    }

    private var sectionPicker: some View {
        VStack(spacing: 6) {
            Picker("Section", selection: $selectedTab) {
                ForEach(DetailTab.allCases, id: \.self) { tab in
                    Text(tab.rawValue).tag(tab)
                }
            }
            .pickerStyle(.segmented)
            if selectedTab == .transcript {
                Toggle(isOn: $chatOnly) {
                    Text("Chat only")
                        .font(.caption.weight(.semibold))
                }
                .toggleStyle(.switch)
                .accessibilityHint("Hide tool calls, thoughts, and system lines")
            }
        }
        .padding(.horizontal)
        .padding(.top, 4)
        .padding(.bottom, 8)
        .background(.ultraThinMaterial)
    }

    @ViewBuilder
    private func content(for detail: SessionDetail) -> some View {
        switch selectedTab {
        case .transcript:
            TranscriptView(
                entries: detail.transcript,
                toolCalls: detail.toolCalls,
                streaming: vm.streamingText,
                isRunning: detail.status == .running,
                agentLabel: agentLabel(for: detail),
                chatOnly: chatOnly,
                onSaveAsTodo: { entry in captureSheet = .saveAsTodo(entry) },
                onScanForTodo: { entry in captureSheet = .scanForTodo(entry) },
                onMakeNote: { entry in captureSheet = .makeNote(entry) },
                expandMessageId: expandMessageId
            )
        case .tools:
            if detail.toolCalls.isEmpty {
                Text("No tool calls yet").foregroundStyle(.secondary)
            } else {
                LazyVStack(alignment: .leading, spacing: 10) {
                    ForEach(detail.toolCalls) { tool in
                        DispatchCard {
                            VStack(alignment: .leading, spacing: 6) {
                                Text(tool.title).font(.subheadline.weight(.semibold))
                                HStack {
                                    if let kind = tool.kind {
                                        Text(kind).font(.caption).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    Text(tool.status).font(.caption).foregroundStyle(.secondary)
                                }
                                if let locations = tool.locations, !locations.isEmpty {
                                    VStack(alignment: .leading, spacing: 3) {
                                        ForEach(locations, id: \.self) { loc in
                                            fileLocationRow(loc, cwd: detail.cwd)
                                        }
                                    }
                                    .padding(.top, 2)
                                }
                            }
                        }
                    }
                }
            }
        case .plan:
            if let plan = detail.plan, !plan.isEmpty {
                LazyVStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(plan.enumerated()), id: \.offset) { _, entry in
                        DispatchCard {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(entry.content)
                                HStack {
                                    if let p = entry.priority {
                                        Text(p).font(.caption2).foregroundStyle(.secondary)
                                    }
                                    if let s = entry.status {
                                        Text(s).font(.caption2).foregroundStyle(.secondary)
                                    }
                                }
                            }
                        }
                    }
                }
            } else {
                Text("No plan yet").foregroundStyle(.secondary)
            }
        case .diff:
            DiffView(text: vm.diffText, cwd: detail.cwd) { path in
                openFileInViewer(path, cwd: detail.cwd)
            }
        case .notes:
            SessionNotesTab(
                detail: detail,
                host: vm.host,
                projects: projectChoices,
                onJumpToMessage: { messageId in
                    // Switch tab first so the transcript's LazyVStack starts
                    // materializing its rows. The ScrollViewReader's onChange
                    // wraps its own asyncAfter so the row is present when
                    // scrollTo fires.
                    selectedTab = .transcript
                    pendingScrollToMessageId = messageId
                    expandMessageId = messageId
                },
                onOpenLocalFile: { path in
                    openFileInViewer(path, cwd: detail.cwd)
                }
            )
            .environmentObject(appState)
        }
    }

    /// Row for a `ToolLocation`. Mac: clickable, opens in FileViewerPane.
    /// iOS: plain text (file lives on the host Mac; no viewer target).
    @ViewBuilder
    private func fileLocationRow(_ loc: ToolLocation, cwd: String) -> some View {
        let display = displayPath(loc.path, cwd: cwd)
        let lineSuffix = loc.line.map { ":\($0)" } ?? ""
        HStack(spacing: 6) {
            Image(systemName: "doc.text")
                .font(.caption2)
                .foregroundStyle(.secondary)
            #if os(macOS)
            Button {
                openFileInViewer(loc.path, cwd: cwd)
            } label: {
                Text("\(display)\(lineSuffix)")
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(DispatchColors.accent)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            .buttonStyle(.plain)
            .help("Open \(loc.path) in file viewer")
            #else
            Text("\(display)\(lineSuffix)")
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
            #endif
        }
    }

    /// Trim the session's cwd from the front of a path for display; keeps the
    /// full path in the click target so the viewer opens the right file.
    private func displayPath(_ path: String, cwd: String) -> String {
        if !cwd.isEmpty && path.hasPrefix(cwd) {
            let stripped = String(path.dropFirst(cwd.count))
            return stripped.hasPrefix("/") ? String(stripped.dropFirst()) : stripped
        }
        return path
    }

    /// Resolve a possibly-relative path against the session cwd, then open in
    /// the Mac file viewer. iOS: no-op (host-side file not reachable here).
    private func openFileInViewer(_ path: String, cwd: String) {
        #if os(macOS)
        let absolute: String
        if path.hasPrefix("/") || path.hasPrefix("~") {
            absolute = path
        } else if !cwd.isEmpty {
            absolute = (cwd as NSString).appendingPathComponent(path)
        } else {
            absolute = path
        }
        appState.openInViewer(absolute)
        #endif
    }

    private var followUpBar: some View {
        VStack(alignment: .leading, spacing: 8) {
            if vm.detail?.status == .idle || vm.detail?.status == .completed {
                Text("Conversation is open — type, attach, or drop / paste a screenshot.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let err = vm.errorMessage {
                Text(err)
                    .font(.caption)
                    .foregroundStyle(DispatchColors.danger)
            }

            if !vm.pendingImages.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(vm.pendingImages) { att in
                            ZStack(alignment: .topTrailing) {
                                Image(platformImage: att.preview)
                                    .resizable()
                                    .scaledToFill()
                                    .frame(width: 64, height: 64)
                                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                                Button {
                                    vm.removeImage(id: att.id)
                                } label: {
                                    Image(systemName: "xmark.circle.fill")
                                        .symbolRenderingMode(.palette)
                                        .foregroundStyle(.white, .black.opacity(0.65))
                                }
                                .offset(x: 6, y: -6)
                            }
                        }
                    }
                    .padding(.vertical, 2)
                }
            }

            HStack(alignment: .bottom, spacing: 8) {
                #if os(macOS)
                // Mac: real file open panel so Desktop/Downloads screenshots work.
                // PhotosPicker only surfaces the Photos library — useless for local files.
                Button {
                    pickImageFilesFromDisk()
                } label: {
                    Image(systemName: "paperclip")
                        .font(.title3)
                        .foregroundStyle(DispatchColors.accent)
                        .frame(width: 36, height: 36)
                }
                .buttonStyle(.plain)
                .help("Attach images — or drop / paste a screenshot")
                .disabled(vm.isSending || vm.pendingImages.count >= 4)
                #else
                PhotosPicker(
                    selection: $photoPickerItems,
                    maxSelectionCount: max(1, 4 - vm.pendingImages.count),
                    matching: .images
                ) {
                    Image(systemName: "photo.on.rectangle.angled")
                        .font(.title3)
                        .foregroundStyle(DispatchColors.accent)
                        .frame(width: 36, height: 36)
                }
                .disabled(vm.isSending || vm.pendingImages.count >= 4)
                .onChange(of: photoPickerItems) { _, items in
                    Task { await loadPickerItems(items) }
                }

                if UIImagePickerController.isSourceTypeAvailable(.camera) {
                    Button {
                        showCamera = true
                    } label: {
                        Image(systemName: "camera")
                            .font(.title3)
                            .foregroundStyle(DispatchColors.accent)
                            .frame(width: 36, height: 36)
                    }
                    .disabled(vm.isSending || vm.pendingImages.count >= 4)
                }
                #endif

                TextField("Message agent…", text: $vm.followUp, axis: .vertical)
                    .lineLimit(1...5)
                    .padding(12)
                    .background(Color.white.opacity(0.08))
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .focused($followUpFocused)
                    .onSubmit {
                        guard canSendFollowUp else { return }
                        Task { await vm.sendFollowUp(api: appState.api) }
                    }

                Button {
                    Task { await vm.sendFollowUp(api: appState.api) }
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.title2)
                        .foregroundStyle(canSendFollowUp ? DispatchColors.accent : Color.secondary)
                }
                .disabled(!canSendFollowUp)
            }
        }
        .padding()
        .background(.ultraThinMaterial)
        #if os(iOS)
        .sheet(isPresented: $showCamera) {
            CameraPicker { image in
                if let image {
                    vm.addImages([image])
                }
                showCamera = false
            }
            .ignoresSafeArea()
        }
        #endif
    }


    #if os(macOS)
    private func pickImageFilesFromDisk() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = true
        panel.canCreateDirectories = false
        panel.message = "Choose screenshot or image files to send"
        panel.prompt = "Attach"
        panel.allowedContentTypes = [.png, .jpeg, .gif, .webP, .bmp, .tiff, .heic, .image]
        let desktop = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Desktop")
        if FileManager.default.fileExists(atPath: desktop.path) {
            panel.directoryURL = desktop
        }
        guard panel.runModal() == .OK else { return }
        var images: [PlatformImage] = []
        for url in panel.urls {
            let accessed = url.startAccessingSecurityScopedResource()
            defer { if accessed { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url),
                  let image = PlatformImage.cs_fromData(data) else { continue }
            images.append(image)
        }
        if !images.isEmpty {
            vm.addImages(images)
        } else if !panel.urls.isEmpty {
            vm.errorMessage = "Could not load selected image files"
        }
    }

    /// Drag-drop or paste (including the floating macOS screenshot thumbnail).
    private func ingestDroppedProviders(_ providers: [NSItemProvider]) {
        Task { @MainActor in
            var images: [PlatformImage] = []
            for provider in providers {
                if let img = await loadDroppedImage(provider) {
                    images.append(img)
                }
            }
            if !images.isEmpty {
                vm.addImages(images)
            } else {
                vm.errorMessage = "Could not read dropped image"
            }
        }
    }

    private func loadDroppedImage(_ provider: NSItemProvider) async -> PlatformImage? {
        if provider.canLoadObject(ofClass: NSImage.self) {
            return await withCheckedContinuation { cont in
                _ = provider.loadObject(ofClass: NSImage.self) { obj, _ in
                    cont.resume(returning: obj as? NSImage)
                }
            }
        }
        let typeIds = [
            UTType.png.identifier,
            UTType.jpeg.identifier,
            UTType.tiff.identifier,
            UTType.gif.identifier,
            UTType.webP.identifier,
            UTType.heic.identifier,
            UTType.image.identifier,
        ]
        for typeId in typeIds where provider.hasItemConformingToTypeIdentifier(typeId) {
            if let data = await loadProviderData(provider, typeId: typeId),
               let img = PlatformImage.cs_fromData(data)
            {
                return img
            }
        }
        if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier),
           let url = await loadProviderFileURL(provider),
           let data = try? Data(contentsOf: url),
           let img = PlatformImage.cs_fromData(data)
        {
            return img
        }
        return nil
    }

    private func loadProviderData(_ provider: NSItemProvider, typeId: String) async -> Data? {
        await withCheckedContinuation { cont in
            provider.loadDataRepresentation(forTypeIdentifier: typeId) { data, _ in
                cont.resume(returning: data)
            }
        }
    }

    private func loadProviderFileURL(_ provider: NSItemProvider) async -> URL? {
        await withCheckedContinuation { cont in
            provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, _ in
                if let url = item as? URL {
                    cont.resume(returning: url)
                } else if let data = item as? Data {
                    cont.resume(returning: URL(dataRepresentation: data, relativeTo: nil))
                } else if let s = item as? String {
                    cont.resume(returning: URL(fileURLWithPath: s))
                } else {
                    cont.resume(returning: nil)
                }
            }
        }
    }
    #endif

    private func loadPickerItems(_ items: [PhotosPickerItem]) async {
        guard !items.isEmpty else { return }
        var images: [PlatformImage] = []
        for item in items {
            if let data = try? await item.loadTransferable(type: Data.self),
               let image = PlatformImage.cs_fromData(data) {
                images.append(image)
            }
        }
        if !images.isEmpty {
            vm.addImages(images)
        }
        photoPickerItems = []
    }
}

// MARK: - Camera (iOS only)

#if os(iOS)
private struct CameraPicker: UIViewControllerRepresentable {
    /// Called with the captured image, or nil on cancel. Parent should set `showCamera = false`.
    var onImage: (PlatformImage?) -> Void

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        // Guard: missing source or privacy string used to hard-crash on device.
        if UIImagePickerController.isSourceTypeAvailable(.camera) {
            picker.sourceType = .camera
            picker.cameraCaptureMode = .photo
        } else {
            picker.sourceType = .photoLibrary
        }
        picker.delegate = context.coordinator
        picker.allowsEditing = false
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(onImage: onImage)
    }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let onImage: (PlatformImage?) -> Void
        init(onImage: @escaping (PlatformImage?) -> Void) { self.onImage = onImage }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            onImage(nil)
        }

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            onImage(info[.originalImage] as? UIImage)
        }
    }
}
#endif

// MARK: - Transcript scroll (isolated for type-checker + scroll-to-bottom)

/// Owns ScrollViewReader + bottom-pinning so SessionDetailView's body stays
/// type-checkable. Retries scroll targets because LazyVStack materializes late.
private struct TranscriptScrollPane<Content: View>: View {
    let detail: SessionDetail
    let selectedTab: SessionDetailView.DetailTab
    let streamingText: String
    @Binding var pendingScrollToMessageId: String?
    @ViewBuilder var content: () -> Content

    /// Coalesced signal so we don't chain six `.onChange` modifiers (type-checker).
    private var pinSignal: String {
        "\(detail.transcript.count)|\(detail.toolCalls.count)|\(streamingText.count)|\(selectedTab.rawValue)|\(detail.updatedAt)"
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                content()
            }
            .defaultScrollAnchor(.bottom)
            .onAppear {
                pinBottom(proxy, initial: true)
            }
            .onChange(of: pinSignal) { _, _ in
                // Treat content/tab changes like a (re)entry so LazyVStack
                // materialization gets enough retry time on long sessions.
                pinBottom(proxy, initial: true)
            }
            .onChange(of: pendingScrollToMessageId) { _, target in
                jumpToMessage(proxy, target)
            }
            .onAppear {
                if pendingScrollToMessageId != nil {
                    jumpToMessage(proxy, pendingScrollToMessageId)
                }
            }
        }
    }

    private func jumpToMessage(_ proxy: ScrollViewProxy, _ target: String?) {
        guard let target else { return }
        // LazyVStack may not have materialized the row yet — retry like pinBottom.
        let delays: [Double] = [0.05, 0.12, 0.28, 0.5, 0.9, 1.4]
        for delay in delays {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                withAnimation(.easeInOut(duration: 0.3)) {
                    proxy.scrollTo(target, anchor: .center)
                }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) {
            if pendingScrollToMessageId == target {
                pendingScrollToMessageId = nil
            }
        }
    }

    private func pinBottom(_ proxy: ScrollViewProxy, initial: Bool) {
        guard selectedTab == .transcript else { return }
        // A pending jump wins — otherwise the bottom-pin retries yank us off the message.
        guard pendingScrollToMessageId == nil else { return }
        let targets = bottomTargets()
        func go(animated: Bool) {
            let apply = {
                for id in targets {
                    proxy.scrollTo(id, anchor: .bottom)
                }
                proxy.scrollTo(SessionDetailView.transcriptBottomAnchor, anchor: .bottom)
            }
            if animated {
                withAnimation(.easeOut(duration: 0.18)) { apply() }
            } else {
                var t = Transaction()
                t.disablesAnimations = true
                withTransaction(t) { apply() }
            }
        }
        DispatchQueue.main.async { go(animated: false) }
        let delays: [Double] = initial
            ? [0.05, 0.12, 0.28, 0.5, 0.9, 1.4]
            : [0.03, 0.15]
        for delay in delays {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                go(animated: !initial)
            }
        }
    }

    private func bottomTargets() -> [String] {
        var ids: [String] = []
        if !streamingText.isEmpty {
            ids.append("streaming")
        } else if detail.status == .running {
            ids.append("still-working")
        }
        if let lastTool = detail.toolCalls.max(by: { $0.updatedAt < $1.updatedAt }) {
            ids.append("tool-\(lastTool.toolCallId)")
        }
        if let last = detail.transcript.last {
            ids.append(last.id)
        }
        return ids
    }
}

// MARK: - Session details sheet

/// Full session metadata (model, cwd, usage, prompt, ids) — kept off the
/// always-visible header so the chat surface stays lean.
private struct SessionDetailsSheet: View {
    let detail: SessionDetail
    let agentLabel: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section("Status") {
                    LabeledContent("State", value: detail.status.label)
                    if detail.isArchived {
                        LabeledContent("Archived", value: detail.archivedAt ?? "yes")
                    }
                    if let error = detail.error, !error.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Error")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Text(error)
                                .font(.footnote)
                                .foregroundStyle(DispatchColors.danger)
                                .textSelection(.enabled)
                        }
                    }
                }

                Section("Agent") {
                    if let name = detail.profileName, !name.isEmpty {
                        LabeledContent("Profile", value: name)
                    }
                    if let backend = detail.backend, !backend.isEmpty {
                        LabeledContent("Backend", value: backend)
                    }
                    LabeledContent("Model", value: detail.model)
                    LabeledContent("Agent", value: agentLabel)
                    if let pid = detail.profileId, !pid.isEmpty {
                        LabeledContent("Profile id", value: pid)
                    }
                }

                Section("Workspace") {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Working directory")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(detail.cwd.isEmpty ? "—" : detail.cwd)
                            .font(.system(.footnote, design: .monospaced))
                            .textSelection(.enabled)
                    }
                    if !detail.effectiveExtraDirs.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Extra folders")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            ForEach(detail.effectiveExtraDirs, id: \.self) { dir in
                                Text(dir)
                                    .font(.system(.footnote, design: .monospaced))
                                    .textSelection(.enabled)
                            }
                        }
                    }
                    if let projectId = detail.projectId, !projectId.isEmpty {
                        LabeledContent("Project id", value: projectId)
                    }
                    LabeledContent("Plan mode", value: detail.planMode ? "On" : "Off")
                    LabeledContent("Subagents", value: detail.subagents ? "On" : "Off")
                    LabeledContent("Worktree", value: detail.worktree ? "On" : "Off")
                }

                Section("Activity") {
                    LabeledContent("Tool calls", value: "\(detail.toolCallCount)")
                    LabeledContent("Messages", value: "\(detail.transcript.count)")
                    if let usage = detail.usage {
                        LabeledContent("Usage", value: usage.shortLabel)
                        LabeledContent("Input tokens", value: "\(usage.inputTokens)")
                        LabeledContent("Output tokens", value: "\(usage.outputTokens)")
                        if usage.cacheReadTokens > 0 || usage.cacheCreationTokens > 0 {
                            LabeledContent("Cache read", value: "\(usage.cacheReadTokens)")
                            LabeledContent("Cache write", value: "\(usage.cacheCreationTokens)")
                        }
                        LabeledContent("Turns", value: "\(usage.turns)")
                    }
                }

                Section("Timeline") {
                    LabeledContent("Created", value: detail.createdAt)
                    LabeledContent("Updated", value: detail.updatedAt)
                    if let completed = detail.completedAt {
                        LabeledContent("Completed", value: completed)
                    }
                    if let stop = detail.stopReason, !stop.isEmpty {
                        LabeledContent("Stop reason", value: stop)
                    }
                }

                Section("Identifiers") {
                    LabeledContent("Session id", value: detail.id)
                    if let grok = detail.grokSessionId, !grok.isEmpty {
                        LabeledContent("Grok session", value: grok)
                    }
                    if let claude = detail.claudeSessionId, !claude.isEmpty {
                        LabeledContent("Claude session", value: claude)
                    }
                }

                Section("Original prompt") {
                    Text(detail.prompt.isEmpty ? "—" : detail.prompt)
                        .font(.footnote)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .navigationTitle("Session details")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        #if os(iOS)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        #endif
    }
}
