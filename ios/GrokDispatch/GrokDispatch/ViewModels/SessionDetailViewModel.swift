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
    @Published var selectedAnswers: [Int: String] = [:]

    let sessionId: String
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
            unlockIfWaitingOnUser()
            if detail?.status != .running {
                streamingText = ""
            }
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
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
        guard let approvalId = detail?.pendingApproval?.id ?? detail?.pendingApprovalId else { return }
        isResolving = true
        defer { isResolving = false }
        do {
            detail = try await api.approve(
                sessionId: sessionId,
                approvalId: approvalId,
                comment: comment.isEmpty ? nil : comment,
                host: host
            )
            comment = ""
            errorMessage = nil
            streamingText = ""
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func reject(api: APIClient) async {
        guard let approvalId = detail?.pendingApproval?.id ?? detail?.pendingApprovalId else { return }
        isResolving = true
        defer { isResolving = false }
        do {
            detail = try await api.reject(
                sessionId: sessionId,
                approvalId: approvalId,
                comment: comment.isEmpty ? nil : comment,
                host: host
            )
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
            // Don't restore images if user already sent — just show error
            followUp = text
            pendingImages = images
            errorMessage = error.localizedDescription
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
        var answers: [String] = []
        for (idx, _) in q.questions.enumerated() {
            answers.append(selectedAnswers[idx] ?? "")
        }
        if answers.allSatisfy({ $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) {
            errorMessage = "Pick an answer for each question"
            return
        }
        isResolving = true
        defer { isResolving = false }
        do {
            detail = try await api.answerQuestions(
                sessionId: sessionId,
                questionId: q.id,
                answers: answers,
                comment: comment.isEmpty ? nil : comment,
                host: host
            )
            selectedAnswers = [:]
            comment = ""
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
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

        // Agent is streaming — release send lock so UI stays usable
        if type == "transcript",
           payload?["streaming"] as? Bool == true,
           let text = payload?["text"] as? String {
            streamingText += text
            isSending = false
            return
        }

        // User must act — never leave Approve spinning
        if type == "approval.needed" || type == "question.needed" {
            isSending = false
        }

        await load(api: api)
        unlockIfWaitingOnUser()

        if type == "session.completed" || type == "session.updated" || type == "transcript" {
            if detail?.status != .running {
                streamingText = ""
            }
        }
        if type == "session.completed" || type == "tool_call_update" {
            await loadDiff(api: api)
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
