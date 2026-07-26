import Foundation
import Combine

@MainActor
final class SessionDetailViewModel: ObservableObject {
    @Published var detail: SessionDetail?
    @Published var diffText: String = ""
    @Published var streamingText: String = ""
    @Published var isLoading = false
    @Published var isActing = false
    @Published var errorMessage: String?
    @Published var comment: String = ""
    @Published var followUp: String = ""
    /// Selected option label per question index
    @Published var selectedAnswers: [Int: String] = [:]

    let sessionId: String
    private var observer: NSObjectProtocol?

    init(sessionId: String) {
        self.sessionId = sessionId
        observer = NotificationCenter.default.addObserver(
            forName: .dispatchSocketEvent,
            object: nil,
            queue: .main
        ) { [weak self] note in
            guard let data = note.object as? Data else { return }
            Task { @MainActor in
                self?.handleSocket(data)
            }
        }
    }

    deinit {
        if let observer {
            NotificationCenter.default.removeObserver(observer)
        }
    }

    func load(api: APIClient) async {
        isLoading = true
        defer { isLoading = false }
        do {
            detail = try await api.session(id: sessionId)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func loadDiff(api: APIClient) async {
        do {
            let res = try await api.diff(id: sessionId)
            diffText = res.diff.isEmpty ? "(no changes)" : res.diff
        } catch {
            diffText = "Unable to load diff: \(error.localizedDescription)"
        }
    }

    func approve(api: APIClient) async {
        guard let approvalId = detail?.pendingApproval?.id ?? detail?.pendingApprovalId else { return }
        isActing = true
        defer { isActing = false }
        do {
            detail = try await api.approve(
                sessionId: sessionId,
                approvalId: approvalId,
                comment: comment.isEmpty ? nil : comment
            )
            comment = ""
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func reject(api: APIClient) async {
        guard let approvalId = detail?.pendingApproval?.id ?? detail?.pendingApprovalId else { return }
        isActing = true
        defer { isActing = false }
        do {
            detail = try await api.reject(
                sessionId: sessionId,
                approvalId: approvalId,
                comment: comment.isEmpty ? nil : comment
            )
            comment = ""
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func cancel(api: APIClient) async {
        isActing = true
        defer { isActing = false }
        do {
            detail = try await api.cancel(sessionId: sessionId)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func sendFollowUp(api: APIClient) async {
        let text = followUp.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        // Clear immediately so the field doesn't linger while the request runs.
        followUp = ""
        isActing = true
        defer { isActing = false }
        do {
            // Optimistic: show the user message at the top while the host responds.
            if var d = detail {
                d.transcript.append(
                    TranscriptEntry(
                        id: UUID().uuidString,
                        role: "user",
                        text: text,
                        at: ISO8601DateFormatter().string(from: Date())
                    )
                )
                detail = d
            }
            detail = try await api.prompt(sessionId: sessionId, text: text)
            streamingText = ""
            errorMessage = nil
        } catch {
            followUp = text
            errorMessage = error.localizedDescription
        }
    }

    func rename(api: APIClient, title: String) async {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        isActing = true
        defer { isActing = false }
        do {
            detail = try await api.renameSession(sessionId: sessionId, title: trimmed)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func archive(api: APIClient) async {
        isActing = true
        defer { isActing = false }
        do {
            detail = try await api.archiveSession(sessionId: sessionId)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func unarchive(api: APIClient) async {
        isActing = true
        defer { isActing = false }
        do {
            detail = try await api.unarchiveSession(sessionId: sessionId)
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
        isActing = true
        defer { isActing = false }
        do {
            detail = try await api.answerQuestions(
                sessionId: sessionId,
                questionId: q.id,
                answers: answers,
                comment: comment.isEmpty ? nil : comment
            )
            selectedAnswers = [:]
            comment = ""
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func handleSocket(_ data: Data) {
        guard
            let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let event = root["event"] as? [String: Any],
            let sid = event["sessionId"] as? String,
            sid == sessionId,
            let type = event["type"] as? String
        else { return }

        if type == "transcript",
           let payload = event["payload"] as? [String: Any],
           payload["streaming"] as? Bool == true,
           let text = payload["text"] as? String {
            streamingText += text
            return
        }

        // Reload full detail for structural changes
        if ["session.updated", "session.completed", "session.failed",
            "tool_call", "tool_call_update", "plan",
            "approval.needed", "approval.resolved", "transcript"].contains(type) {
            Task {
                // Prefer pulling authoritative state
                // (caller should inject api — use a soft reload if detail exists)
            }
        }
    }

    func handleSocketAndReload(api: APIClient, data: Data) async {
        handleSocket(data)
        guard
            let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let event = root["event"] as? [String: Any],
            let sid = event["sessionId"] as? String,
            sid == sessionId
        else { return }

        let type = event["type"] as? String ?? ""
        if type == "transcript",
           let payload = event["payload"] as? [String: Any],
           payload["streaming"] as? Bool == true {
            return
        }
        await load(api: api)
        if type == "session.completed" || type == "tool_call_update" {
            await loadDiff(api: api)
        }
    }
}
