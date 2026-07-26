import Foundation

@MainActor
final class ComposerViewModel: ObservableObject {
    @Published var prompt: String = ""
    @Published var title: String = ""
    @Published var projects: [ProjectInfo] = []
    @Published var selectedProjectId: String?
    @Published var customPath: String = ""
    @Published var planMode = true
    @Published var subagents = true
    @Published var worktree = true
    @Published var model = "grok-build"
    @Published var isSubmitting = false
    @Published var errorMessage: String?
    @Published var lastCreatedSessionId: String?

    let models = ["grok-build", "grok-4", "grok-3"]

    func loadProjects(api: APIClient) async {
        do {
            let response = try await api.projects()
            projects = response.projects
            if selectedProjectId == nil {
                selectedProjectId = projects.first?.id
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func dispatch(api: APIClient) async -> SessionDetail? {
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            errorMessage = "Write a task first"
            return nil
        }
        isSubmitting = true
        defer { isSubmitting = false }

        var body = DispatchRequestBody(
            prompt: text,
            projectId: selectedProjectId,
            title: title.isEmpty ? nil : title,
            model: model,
            planMode: planMode,
            subagents: subagents,
            worktree: worktree
        )
        if selectedProjectId == nil, !customPath.isEmpty {
            body.cwd = customPath
        }

        do {
            let session = try await api.dispatch(body)
            lastCreatedSessionId = session.id
            errorMessage = nil
            prompt = ""
            title = ""
            return session
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }
}
