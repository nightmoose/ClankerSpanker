import Foundation
import Combine

struct ChatImageAttachment: Identifiable, Hashable {
    let id: UUID
    let jpegData: Data
    let preview: PlatformImage

    init(id: UUID = UUID(), image: PlatformImage, maxDimension: CGFloat = 1600, quality: CGFloat = 0.72) {
        self.id = id
        let resized = image.cs_resized(maxDimension: maxDimension)
        self.preview = resized
        self.jpegData = resized.cs_jpegData(compressionQuality: quality) ?? Data()
    }
}

@MainActor
final class SessionDetailViewModel: ObservableObject {
    @Published var detail: SessionDetail?
    @Published var diffText: String = ""
    @Published var streamingText: String = ""
    @Published var isLoading = false
    /// True only while sending a follow-up (NOT while waiting on agent tools).
    @Published var isSending = false
    /// True only while approve/reject/answer is in flight.
    @Published var isResolving = false
    @Published var errorMessage: String?
    @Published var comment: String = ""
    @Published var followUp: String = ""
    @Published var pendingImages: [ChatImageAttachment] = []
    // Keyed by AgentQuestion.id (which is the question text), NOT by array index.
    // If the server re-issues the question set in a different order, index-keyed
    // answers would silently swap between questions.
    @Published var selectedAnswers: [String: String] = [:]

    /// The pending approval currently shown to the user. Held separately from
    /// `detail.pendingApproval` so a socket-driven reload that races with the
    /// user's tap cannot unmount `ApprovalBarView` mid-gesture. We only clear
    /// this on explicit signals: successful approve/reject, an
    /// `approval.resolved` socket event for this id, or the arrival of a
    /// different pending approval.
    @Published var visibleApproval: PendingApproval?
    private var lastAnsweredQuestionId: String?
    private var resolvedApprovalIds: Set<String> = []

    /// Highest event seq we've received for this session. Used by
    /// `replayMissedEvents` on socket reconnect to fetch anything that fired
    /// during the WS gap.
    private var lastEventSeq: Int = 0
    /// Socket events must run one at a time. Overlapping Tasks raced
    /// `streamingText += chunk` against the flush that clears it, so Grok
    /// showed a second bubble that was a suffix of the first while tools ran.
    private var socketChain: Task<Void, Never>?

    /// Debounced reload task. Non-critical socket events (tool_call updates,
    /// plan snapshots, usage updates) coalesce into a single load so the
    /// transcript doesn't refetch and re-render on every micro-event.
    private var pendingReloadTask: Task<Void, Never>?

    /// May change after profile transfer (host creates a new Active session and archives the old).
    private(set) var sessionId: String
    let host: HostEndpoint

    /// Back-compat for views that still check isActing
    var isActing: Bool { isSending || isResolving }

    init(sessionId: String, host: HostEndpoint) {
        self.sessionId = sessionId
        self.host = host
    }

    func load(api: APIClient) async {
        isLoading = true
        defer { isLoading = false }
        do {
            detail = try await api.session(id: sessionId, host: host)
            reconcileVisibleApproval()
            unlockIfWaitingOnUser()
            // Don't keep a streaming bubble once the turn is on disk — Gemini/Claude
            // headless turns persist the assistant reply without a flush event,
            // which otherwise left the live stream AND the saved bubble on screen.
            if detail?.status != .running
                && detail?.status != .awaitingApproval
                && detail?.status != .awaitingQuestion
            {
                streamingText = ""
            }
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func reconcileVisibleApproval() {
        let incoming = detail?.pendingApproval
        if let incoming {
            if visibleApproval?.id != incoming.id {
                visibleApproval = incoming
                resolvedApprovalIds.remove(incoming.id)
            } else {
                visibleApproval = incoming
            }
            return
        }
        if let vid = visibleApproval?.id, resolvedApprovalIds.contains(vid) {
            visibleApproval = nil
        }
    }

    func loadDiff(api: APIClient) async {
        do {
            let res = try await api.diff(id: sessionId, host: host)
            diffText = res.diff.isEmpty ? "(no changes)" : res.diff
        } catch {
            diffText = "Unable to load diff: \(error.localizedDescription)"
        }
    }

    func approve(api: APIClient) async {
        await performApproval(api: api, scope: nil)
    }

    /// "Approve always this session" — same as approve, plus the host adds a
    /// signature to the session's allowlist so future matching tool calls
    /// skip the phone entirely.
    func approveAlways(api: APIClient) async {
        await performApproval(api: api, scope: "always_session")
    }

    private func performApproval(api: APIClient, scope: String?) async {
        guard let approvalId = visibleApproval?.id ?? detail?.pendingApproval?.id ?? detail?.pendingApprovalId else { return }
        isResolving = true
        defer { isResolving = false }
        do {
            detail = try await api.approve(
                sessionId: sessionId,
                approvalId: approvalId,
                comment: comment.isEmpty ? nil : comment,
                scope: scope,
                host: host
            )
            resolvedApprovalIds.insert(approvalId)
            reconcileVisibleApproval()
            comment = ""
            errorMessage = nil
            streamingText = ""
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func reject(api: APIClient) async {
        guard let approvalId = visibleApproval?.id ?? detail?.pendingApproval?.id ?? detail?.pendingApprovalId else { return }
        isResolving = true
        defer { isResolving = false }
        do {
            detail = try await api.reject(
                sessionId: sessionId,
                approvalId: approvalId,
                comment: comment.isEmpty ? nil : comment,
                host: host
            )
            resolvedApprovalIds.insert(approvalId)
            reconcileVisibleApproval()
            comment = ""
            errorMessage = nil
            streamingText = ""
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func cancel(api: APIClient) async {
        isResolving = true
        defer { isResolving = false }
        do {
            detail = try await api.cancel(sessionId: sessionId, host: host)
            errorMessage = nil
            isSending = false
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func addImages(_ images: [PlatformImage]) {
        let room = max(0, 4 - pendingImages.count)
        guard room > 0 else {
            errorMessage = "Max 4 screenshots per message"
            return
        }
        for image in images.prefix(room) {
            pendingImages.append(ChatImageAttachment(image: image))
        }
    }

    func removeImage(id: UUID) {
        pendingImages.removeAll { $0.id == id }
    }

    func sendFollowUp(api: APIClient) async {
        let text = followUp.trimmingCharacters(in: .whitespacesAndNewlines)
        let images = pendingImages
        guard !text.isEmpty || !images.isEmpty else { return }

        let outboundText: String = {
            if text.isEmpty {
                return images.count == 1
                    ? "Please review this screenshot for debugging."
                    : "Please review these \(images.count) screenshots for debugging."
            }
            return text
        }()

        followUp = ""
        pendingImages = []
        isSending = true
        defer { isSending = false }

        let imagePayloads = images.map { att in
            PromptImagePayload(
                mimeType: "image/jpeg",
                data: att.jpegData.base64EncodedString(),
                name: "screenshot-\(att.id.uuidString.prefix(8)).jpg"
            )
        }

        do {
            if var d = detail {
                let note: String
                if images.isEmpty {
                    note = outboundText
                } else {
                    note = "📷 \(images.count) screenshot\(images.count == 1 ? "" : "s")\n\(outboundText)"
                }
                d.transcript.append(
                    TranscriptEntry(
                        id: UUID().uuidString,
                        role: "user",
                        text: note,
                        at: ISO8601DateFormatter().string(from: Date())
                    )
                )
                detail = d
            }
            // Note: this HTTP call may stay open for the whole agent turn.
            // isSending is cleared in defer; approval UI uses isResolving only.
            // Socket events will unlock if we still need user input mid-turn.
            let result = try await api.prompt(
                sessionId: sessionId,
                text: outboundText,
                images: imagePayloads.isEmpty ? nil : imagePayloads,
                host: host
            )
            detail = result
            streamingText = ""
            errorMessage = nil
            unlockIfWaitingOnUser()
        } catch {
            // Timeouts are almost always false alarms: the host accepts the
            // message and the agent starts working, but the HTTP response
            // exceeds URLSession's request timeout. WebSocket events are the
            // real source of truth. Don't restore the user's text or scare
            // them with a red error — just clear the send lock and let the
            // WS carry the response.
            let nsError = error as NSError
            let isTimeout =
                nsError.domain == NSURLErrorDomain &&
                (nsError.code == NSURLErrorTimedOut ||
                 nsError.code == NSURLErrorNetworkConnectionLost)
            if isTimeout {
                errorMessage = nil
                streamingText = ""
                unlockIfWaitingOnUser()
            } else {
                // Genuine failure — restore inputs so the user can retry.
                followUp = text
                pendingImages = images
                errorMessage = error.localizedDescription
            }
        }
    }

    func rename(api: APIClient, title: String) async {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        isResolving = true
        defer { isResolving = false }
        do {
            detail = try await api.renameSession(sessionId: sessionId, title: trimmed, host: host)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Close the session as done (agent stopped, status completed, archived).
    func closeAsDone(api: APIClient) async {
        isResolving = true
        defer { isResolving = false }
        do {
            detail = try await api.closeSession(sessionId: sessionId, host: host)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Permanently delete this session. Detail becomes nil on success so the
    /// enclosing view pops back to the list.
    func deletePermanently(api: APIClient) async -> Bool {
        isResolving = true
        defer { isResolving = false }
        do {
            try await api.deleteSession(sessionId: sessionId, host: host)
            detail = nil
            errorMessage = nil
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    /// Attach the session to a project, or detach with `nil`.
    func setProject(api: APIClient, projectId: String?) async {
        isResolving = true
        defer { isResolving = false }
        do {
            detail = try await api.setSessionProject(
                sessionId: sessionId,
                projectId: projectId,
                host: host
            )
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Full transfer: original → Archived under old profile; returns new Active session under target.
    /// Updates `sessionId` so follow-ups hit the continuation.
    @discardableResult
    func transfer(api: APIClient, profileId: String) async -> String? {
        isResolving = true
        defer { isResolving = false }
        do {
            let result = try await api.transferSession(sessionId: sessionId, profileId: profileId, host: host)
            detail = result
            sessionId = result.id
            errorMessage = nil
            return result.id
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    /// Archive this chat and open a fresh same-project session seeded with a transcript summary.
    @discardableResult
    func reincarnate(api: APIClient, note: String? = nil) async -> String? {
        isResolving = true
        defer { isResolving = false }
        do {
            let result = try await api.reincarnateSession(
                sessionId: sessionId,
                title: detail?.title,
                note: note,
                host: host
            )
            detail = result
            sessionId = result.id
            streamingText = ""
            errorMessage = nil
            return result.id
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    /// Spawn a sibling critique session. Source chat stays active on the host;
    /// this view switches to the new review session so you can read the critique.
    @discardableResult
    func reviewWork(api: APIClient, profileId: String? = nil, note: String? = nil) async -> String? {
        isResolving = true
        defer { isResolving = false }
        do {
            let result = try await api.reviewSession(
                sessionId: sessionId,
                profileId: profileId,
                title: detail?.title,
                note: note,
                includeDiff: true,
                host: host
            )
            detail = result
            sessionId = result.id
            streamingText = ""
            errorMessage = nil
            return result.id
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    func archive(api: APIClient) async {
        isResolving = true
        defer { isResolving = false }
        do {
            detail = try await api.archiveSession(sessionId: sessionId, host: host)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func unarchive(api: APIClient) async {
        isResolving = true
        defer { isResolving = false }
        do {
            detail = try await api.unarchiveSession(sessionId: sessionId, host: host)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func submitQuestionAnswers(api: APIClient) async {
        guard let q = detail?.pendingQuestion else { return }
        let submittedQuestionId = q.id
        let answers: [String] = q.questions.map { selectedAnswers[$0.id] ?? "" }
        if answers.allSatisfy({ $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) {
            errorMessage = "Pick an answer for each question"
            return
        }
        isResolving = true
        defer { isResolving = false }
        do {
            let updated = try await api.answerQuestions(
                sessionId: sessionId,
                questionId: submittedQuestionId,
                answers: answers,
                comment: comment.isEmpty ? nil : comment,
                host: host
            )
            detail = updated
            errorMessage = nil
            // Only reset the picker state if the question we just answered is
            // gone (or replaced). Preserves the user's inputs if the server
            // came back with the same question (e.g. soft-recovery path where
            // the answer needs to be re-submitted after a re-prompt).
            let stillSameQuestion =
                updated.pendingQuestion != nil && updated.pendingQuestion?.id == submittedQuestionId
            if !stillSameQuestion {
                selectedAnswers = [:]
                comment = ""
                lastAnsweredQuestionId = submittedQuestionId
            } else {
                errorMessage =
                    "Your answers were sent but the agent hasn't consumed them yet. Try again in a moment."
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// After a WebSocket reconnect, pull any events the server emitted for
    /// this session while we were disconnected and feed them through the
    /// standard socket handler. Prevents "watched a session, WiFi flipped, now
    /// state is inconsistent" from actually losing information.
    func replayMissedEvents(api: APIClient) async {
        do {
            let data = try await api.eventsSince(
                sessionId: sessionId,
                seq: lastEventSeq,
                host: host
            )
            guard
                let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                let events = root["events"] as? [[String: Any]]
            else { return }
            for event in events {
                let envelope: [String: Any] = ["event": event]
                guard let envelopeData = try? JSONSerialization.data(withJSONObject: envelope) else {
                    continue
                }
                await handleSocketAndReload(api: api, data: envelopeData)
            }
        } catch {
            // Silent — a REST failure here just means the user has to pull-to-refresh.
        }
    }

    func handleSocketAndReload(api: APIClient, data: Data) async {
        guard
            let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let event = root["event"] as? [String: Any],
            let sid = event["sessionId"] as? String,
            sid == sessionId
        else { return }

        let type = event["type"] as? String ?? ""
        let payload = event["payload"] as? [String: Any]

        // Track the highest seq we've seen so `replayMissedEvents` after a WS
        // reconnect can fetch anything that fired during the gap.
        if let seq = event["seq"] as? Int, seq > lastEventSeq {
            lastEventSeq = seq
        }

        // Streaming assistant chunk — append to the live buffer. No reload:
        // reload would refetch a session snapshot that doesn't include this
        // chunk yet and cause the transcript to visibly flap.
        if type == "transcript",
           payload?["streaming"] as? Bool == true,
           let text = payload?["text"] as? String {
            if isRedundantStreamingChunk(text) {
                return
            }
            streamingText += text
            isSending = false
            return
        }

        // User must act — never leave Approve spinning
        if type == "approval.needed" || type == "question.needed" {
            isSending = false
        }

        // Record resolved approvals so the reconcile step actually clears
        // the visible bar (and future reloads don't keep it around).
        if type == "approval.resolved", let aid = payload?["approvalId"] as? String {
            resolvedApprovalIds.insert(aid)
        }

        // Reload cadence:
        //  - Critical events (state changes, approval/question surfaces, transcript
        //    flushes) reload immediately so the UI reacts.
        //  - Everything else (tool_call_update, plan snapshots, usage, thought
        //    chunks) is debounced. A rapid burst coalesces into a single
        //    refetch instead of triggering N re-renders of the transcript.
        let criticalTypes: Set<String> = [
            "session.created",
            "session.completed",
            "session.failed",
            "session.updated",
            "approval.needed",
            "approval.resolved",
            "question.needed",
            "question.answered",
            "transcript",
        ]
        if criticalTypes.contains(type) {
            pendingReloadTask?.cancel()
            pendingReloadTask = nil
            await load(api: api)
            unlockIfWaitingOnUser()
            // Non-streaming `transcript` = server just flushed the streaming
            // buffer into a persisted entry. Clear streamingText AFTER load
            // completes so the transcript never briefly blanks between
            // "streaming bubble gone" and "flushed entry visible."
            if type == "transcript" {
                streamingText = ""
            }
        } else {
            scheduleDebouncedReload(api: api)
        }

        if type == "session.completed" || type == "tool_call_update" {
            await loadDiff(api: api)
        }
    }

    /// In-flight delta that arrived after `flushAssistant` already persisted
    /// the same words. Grok ACP emits overlapping `agent_message_chunk`s;
    /// applying them after a clear looks like a stalled duplicate bubble.
    private func isRedundantStreamingChunk(_ text: String) -> Bool {
        let chunk = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if chunk.count < 8 { return false }
        if let last = detail?.transcript.last(where: { $0.role == "assistant" }),
           last.text.contains(chunk) {
            return true
        }
        return false
    }

    /// Process socket events in arrival order. `onReceive` used to spawn an
    /// unstructured Task per envelope, so a late streaming chunk could land
    /// after the flush that cleared `streamingText`.
    func enqueueSocketEvent(api: APIClient, data: Data) {
        socketChain = Task { [socketChain] in
            await socketChain?.value
            guard !Task.isCancelled else { return }
            await handleSocketAndReload(api: api, data: data)
        }
    }

    private func scheduleDebouncedReload(api: APIClient) {
        pendingReloadTask?.cancel()
        pendingReloadTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 300_000_000) // 300ms trailing edge
            guard let self, !Task.isCancelled else { return }
            await self.load(api: api)
            self.unlockIfWaitingOnUser()
        }
    }

    /// Ensure Approve / answer controls are interactive when the host needs the user.
    private func unlockIfWaitingOnUser() {
        if detail?.status == .awaitingApproval
            || detail?.status == .awaitingQuestion
            || detail?.pendingApproval != nil
            || detail?.pendingQuestion != nil
        {
            isSending = false
        }
    }
}
