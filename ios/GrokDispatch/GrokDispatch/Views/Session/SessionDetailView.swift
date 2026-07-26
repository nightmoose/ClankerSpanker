import SwiftUI

struct SessionDetailView: View {
    @EnvironmentObject private var appState: AppState
    @StateObject private var vm: SessionDetailViewModel
    @State private var selectedTab = DetailTab.transcript
    @State private var isEditingTitle = false
    @State private var draftTitle = ""
    @FocusState private var followUpFocused: Bool

    enum DetailTab: String, CaseIterable {
        case transcript = "Transcript"
        case tools = "Tools"
        case plan = "Plan"
        case diff = "Diff"
    }

    init(sessionId: String) {
        _vm = StateObject(wrappedValue: SessionDetailViewModel(sessionId: sessionId))
    }

    var body: some View {
        ZStack {
            DispatchBackground()
            VStack(spacing: 0) {
                if let detail = vm.detail {
                    header(detail)
                    Picker("Section", selection: $selectedTab) {
                        ForEach(DetailTab.allCases, id: \.self) { tab in
                            Text(tab.rawValue).tag(tab)
                        }
                    }
                    .pickerStyle(.segmented)
                    .padding(.horizontal)
                    .padding(.vertical, 8)

                    ScrollView {
                        content(for: detail)
                            .padding()
                    }

                    if let pendingQ = detail.pendingQuestion {
                        QuestionBarView(
                            pending: pendingQ,
                            selectedAnswers: $vm.selectedAnswers,
                            comment: $vm.comment,
                            isActing: vm.isActing,
                            onSubmit: { Task { await vm.submitQuestionAnswers(api: appState.api) } }
                        )
                    } else if detail.status == .awaitingApproval || detail.pendingApproval != nil {
                        ApprovalBarView(
                            approval: detail.pendingApproval,
                            comment: $vm.comment,
                            isActing: vm.isActing,
                            onApprove: { Task { await vm.approve(api: appState.api) } },
                            onReject: { Task { await vm.reject(api: appState.api) } }
                        )
                    } else if detail.status.allowsFollowUp || detail.status == .failed {
                        // Failed still shows bar so you can retry a follow-up (host re-attaches).
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
        }
        .navigationTitle(isEditingTitle ? "Rename" : (vm.detail?.title ?? "Session"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button {
                        draftTitle = vm.detail?.title ?? ""
                        isEditingTitle = true
                    } label: {
                        Label("Rename session", systemImage: "pencil")
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
                    Button("Refresh") {
                        Task {
                            await vm.load(api: appState.api)
                            await vm.loadDiff(api: appState.api)
                        }
                    }
                    Button("Cancel session", role: .destructive) {
                        Task { await vm.cancel(api: appState.api) }
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
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
        .task {
            await vm.load(api: appState.api)
            await vm.loadDiff(api: appState.api)
        }
        .onReceive(NotificationCenter.default.publisher(for: .dispatchSocketEvent)) { note in
            guard let data = note.object as? Data else { return }
            Task { await vm.handleSocketAndReload(api: appState.api, data: data) }
        }
    }

    private func header(_ detail: SessionDetail) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Button {
                    draftTitle = detail.title
                    isEditingTitle = true
                } label: {
                    HStack(spacing: 6) {
                        Text(detail.title)
                            .font(.headline)
                            .foregroundStyle(.primary)
                            .multilineTextAlignment(.leading)
                            .lineLimit(2)
                        Image(systemName: "pencil")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                }
                .buttonStyle(.plain)
                Spacer(minLength: 8)
                StatusBadge(status: detail.status)
            }
            HStack {
                Text(detail.model)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if detail.isArchived {
                    Text("Archived")
                        .font(.caption2.weight(.bold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .foregroundStyle(.orange)
                        .background(Color.orange.opacity(0.15))
                        .clipShape(Capsule())
                }
                Spacer()
            }
            Text(detail.prompt)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(3)
            if let error = detail.error {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(DispatchColors.danger)
            }
        }
        .padding()
    }

    @ViewBuilder
    private func content(for detail: SessionDetail) -> some View {
        switch selectedTab {
        case .transcript:
            TranscriptView(entries: detail.transcript, streaming: vm.streamingText)
        case .tools:
            if detail.toolCalls.isEmpty {
                Text("No tool calls yet").foregroundStyle(.secondary)
            } else {
                LazyVStack(alignment: .leading, spacing: 10) {
                    ForEach(detail.toolCalls) { tool in
                        DispatchCard {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(tool.title).font(.subheadline.weight(.semibold))
                                HStack {
                                    if let kind = tool.kind {
                                        Text(kind).font(.caption).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    Text(tool.status).font(.caption).foregroundStyle(.secondary)
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
            DiffView(text: vm.diffText)
        }
    }

    private var followUpBar: some View {
        VStack(alignment: .leading, spacing: 8) {
            if vm.detail?.status == .idle || vm.detail?.status == .completed {
                Text("Conversation is open — send another message anytime.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let err = vm.errorMessage {
                Text(err)
                    .font(.caption)
                    .foregroundStyle(DispatchColors.danger)
            }
            HStack(spacing: 10) {
                TextField("Message agent…", text: $vm.followUp, axis: .vertical)
                    .lineLimit(1...5)
                    .padding(12)
                    .background(Color.white.opacity(0.08))
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .focused($followUpFocused)
                    .onSubmit {
                        guard !vm.isActing,
                              !vm.followUp.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        else { return }
                        Task { await vm.sendFollowUp(api: appState.api) }
                    }
                Button {
                    Task { await vm.sendFollowUp(api: appState.api) }
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.title2)
                        .foregroundStyle(DispatchColors.accent)
                }
                .disabled(vm.isActing || vm.followUp.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding()
        .background(.ultraThinMaterial)
    }
}
