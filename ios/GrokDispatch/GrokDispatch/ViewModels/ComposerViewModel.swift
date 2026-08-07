import Foundation

@MainActor
final class ComposerViewModel: ObservableObject {
    @Published var prompt: String = ""
    @Published var title: String = ""
    @Published var projects: [ProjectInfo] = []
    @Published var selectedProjectId: String?
    @Published var customPath: String = ""
    /// Opt-in: plan mode locks file edits until exit_plan_mode succeeds.
    /// Default off so "just do the task" dispatches actually implement.
    @Published var planMode = false
    @Published var subagents = true
    @Published var worktree = false
    @Published var model = "grok-build"
    @Published var selectedBoundProfileId: String?
    @Published var isSubmitting = false
    @Published var errorMessage: String?
    @Published var lastCreatedSessionId: String?

    let grokModels = ["grok-build", "grok-4", "grok-3"]
    let claudeModels = ["claude", "claude-opus-4", "claude-sonnet-4"]

    func models(for bound: BoundProfile?) -> [String] {
        bound?.profile.isClaude == true ? claudeModels : grokModels
    }

    func load(appState: AppState) async {
        // Always mirror the Sessions chip selection so Claude profiles aren't lost.
        syncProfileSelection(from: appState)
        guard let bound = currentBound(appState: appState) else {
            errorMessage = "No profile selected — pick FullScore / Astro / NightMoose on Sessions"
            return
        }
        do {
            let response = try await appState.api.projects(host: bound.host)
            projects = response.projects
            if selectedProjectId == nil || !projects.contains(where: { $0.id == selectedProjectId }) {
                selectedProjectId = projects.first?.id
            }
            applyModelDefaults(for: bound)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func syncProfileSelection(from appState: AppState) {
        if let id = appState.selectedBoundProfileId,
           appState.boundProfiles.contains(where: { $0.id == id })
        {
            selectedBoundProfileId = id
        } else {
            selectedBoundProfileId = appState.boundProfiles.first?.id
        }
    }

    func currentBound(appState: AppState) -> BoundProfile? {
        if let id = selectedBoundProfileId,
           let b = appState.boundProfiles.first(where: { $0.id == id })
        {
            return b
        }
        return appState.selectedBoundProfile ?? appState.boundProfiles.first
    }

    func applyModelDefaults(for bound: BoundProfile) {
        let m = models(for: bound)
        if let pref = bound.profile.model, m.contains(pref) {
            model = pref
        } else if !m.contains(model), let first = m.first {
            model = first
        }
        // Claude profiles must never keep a leftover grok-build model string
        if bound.profile.isClaude, model.lowercased().contains("grok") {
            model = bound.profile.model ?? "claude"
        }
        if bound.profile.isGrok, model.lowercased().contains("claude"), model != "claude" {
            model = bound.profile.model ?? "grok-build"
        }
    }

    func dispatch(appState: AppState) async -> SessionRoute? {
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            errorMessage = "Write a task first"
            return nil
        }
        // Prefer the Sessions chip (appState) so profile is never "stuck" on Grok.
        syncProfileSelection(from: appState)
        guard let bound = currentBound(appState: appState) else {
            errorMessage = "Pick an agent profile (FullScore, Astro, NightMoose, …)"
            return nil
        }

        applyModelDefaults(for: bound)

        isSubmitting = true
        defer { isSubmitting = false }

        // Model is cosmetic for Claude backend; host uses profile.backend as source of truth.
        let dispatchModel: String = {
            if bound.profile.isClaude {
                return bound.profile.model ?? (model.lowercased().contains("grok") ? "claude" : model)
            }
            return model
        }()

        let trimmedCustom = customPath.trimmingCharacters(in: .whitespacesAndNewlines)
        if selectedProjectId == nil {
            if trimmedCustom.isEmpty {
                errorMessage = "Pick a working directory on the host (or enter a custom path)"
                return nil
            }
            if trimmedCustom == "/" || trimmedCustom == "\\" {
                errorMessage = "Working directory cannot be / — pick a real project folder"
                return nil
            }
        }

        var body = DispatchRequestBody(
            prompt: text,
            projectId: selectedProjectId,
            title: title.isEmpty ? nil : title,
            model: dispatchModel,
            planMode: bound.profile.isClaude ? false : planMode,
            subagents: bound.profile.isClaude ? false : subagents,
            worktree: bound.profile.isClaude ? false : worktree,
            profileId: bound.profile.id
        )
        if selectedProjectId == nil, !trimmedCustom.isEmpty {
            body.cwd = trimmedCustom
        }

        do {
            let session = try await appState.api.dispatch(body, host: bound.host)
            lastCreatedSessionId = session.id
            errorMessage = nil
            prompt = ""
            title = ""
            appState.selectBoundProfile(bound.id)
            return SessionRoute(hostId: bound.host.id, sessionId: session.id)
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }
}
