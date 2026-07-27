import SwiftUI
import PhotosUI
import UIKit

struct SessionDetailView: View {
    @EnvironmentObject private var appState: AppState
    @StateObject private var vm: SessionDetailViewModel
    @State private var selectedTab = DetailTab.transcript
    @State private var isEditingTitle = false
    @State private var draftTitle = ""
    @State private var photoPickerItems: [PhotosPickerItem] = []
    @State private var showCamera = false
    @FocusState private var followUpFocused: Bool

    enum DetailTab: String, CaseIterable {
        case transcript = "Transcript"
        case tools = "Tools"
        case plan = "Plan"
        case diff = "Diff"
    }

    init(sessionId: String, host: HostEndpoint) {
        _vm = StateObject(wrappedValue: SessionDetailViewModel(sessionId: sessionId, host: host))
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
                            isActing: vm.isResolving,
                            onSubmit: { Task { await vm.submitQuestionAnswers(api: appState.api) } }
                        )
                    } else if detail.status == .awaitingApproval || detail.pendingApproval != nil {
                        ApprovalBarView(
                            approval: detail.pendingApproval,
                            comment: $vm.comment,
                            isActing: vm.isResolving,
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
                Text("Conversation is open — send text and/or screenshots for debugging.")
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
                                Image(uiImage: att.preview)
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
        .sheet(isPresented: $showCamera) {
            CameraPicker { image in
                if let image {
                    vm.addImages([image])
                }
            }
            .ignoresSafeArea()
        }
    }

    private func loadPickerItems(_ items: [PhotosPickerItem]) async {
        guard !items.isEmpty else { return }
        var images: [UIImage] = []
        for item in items {
            if let data = try? await item.loadTransferable(type: Data.self),
               let image = UIImage(data: data) {
                images.append(image)
            }
        }
        if !images.isEmpty {
            vm.addImages(images)
        }
        photoPickerItems = []
    }
}

// MARK: - Camera

private struct CameraPicker: UIViewControllerRepresentable {
    var onImage: (UIImage?) -> Void

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(onImage: onImage)
    }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let onImage: (UIImage?) -> Void
        init(onImage: @escaping (UIImage?) -> Void) { self.onImage = onImage }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            onImage(nil)
            picker.dismiss(animated: true)
        }

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            onImage(info[.originalImage] as? UIImage)
            picker.dismiss(animated: true)
        }
    }
}
