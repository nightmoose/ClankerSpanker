import Foundation

@MainActor
final class ComposerViewModel: ObservableObject {
    @Published var prompt: String = ""
    @Published var title: String = ""
    @Published var projects: [ProjectInfo] = []
    @Published var selectedProjectId: String?
    /// When the selected project has multiple `paths[]`, this is the chosen
    /// one. Nil means "use the project's first path" (default). Sent to the
    /// host as `cwd` so `resolveProjectPath` picks it.
    @Published var selectedProjectPath: String?
    @Published var customPath: String = ""
    /// Extra workspace folders besides cwd (Claude `--add-dir` / prompt note).
    @Published var extraDirs: [String] = []
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
    @Published var pendingImages: [ChatImageAttachment] = []
    /// Set when the selected profile maps to a persisted hunter bot.
    var matchedBotId: String?

    let grokModels = ["grok-build", "grok-code-fast-1", "grok-4", "grok-3"]
    /// "claude" / "default" are host sentinels — they skip `--model` so the
    /// CLI's own default (usually the newest Sonnet or Opus on the plan) is
    /// used. Everything else is passed through verbatim.
    let claudeModels = [
        "claude",  // sentinel: CLI default
        "claude-opus-4-7",
        "claude-sonnet-4-6",
        "claude-haiku-4-5",
    ]
    /// Common Antigravity / Gemini slugs; host passes --model when not "antigravity".
    let antigravityModels = [
        "antigravity",
        "gemini-3.6-flash-high",
        "gemini-3.5-flash-medium",
        "gemini-3.1-pro-high",
    ]

    let botModels = [
        "grok-4",
        "grok-3",
        "claude-sonnet-4-6",
        "gemini-2.5-flash",
    ]

    func models(for bound: BoundProfile?) -> [String] {
        guard let p = bound?.profile else { return grokModels }
        if p.isBot { return botModels }
        if p.isClaude { return claudeModels }
        if p.isAntigravity { return antigravityModels }
        return grokModels
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
            applyPrefill(from: appState)
            if selectedProjectId == nil || !projects.contains(where: { $0.id == selectedProjectId }) {
                if customPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    // RFC-039: last project used on this host, else the first.
                    let last = UserDefaults.standard.string(forKey: Self.lastProjectKey(bound.host))
                    selectedProjectId = projects.first(where: { $0.id == last })?.id ?? projects.first?.id
                }
            }
            applyModelDefaults(for: bound)
            await applyBotDefaults(appState: appState, bound: bound)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Fold hunter bots into Dispatch: prefill the standing job into the
    /// existing prompt box and snap cwd to the bot's project. No extra screen.
    private func applyBotDefaults(appState: AppState, bound: BoundProfile) async {
        guard bound.profile.isBot else {
            matchedBotId = nil
            return
        }
        do {
            let bots = try await appState.api.listBots(host: bound.host)
            let bot = bots.first(where: { $0.profileId == bound.profile.id }) ?? bots.first
            matchedBotId = bot?.id
            guard let bot else { return }
            if prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                prompt = bot.job
            }
            if customPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
               let project = projects.first(where: { $0.id == bot.projectId })
            {
                selectedProjectId = project.id
                selectedProjectPath = project.effectivePaths.first
            }
        } catch {
            matchedBotId = nil
        }
    }

    /// Consume one-shot compose prefill from Projects / reincarnate helpers.
    /// Also snaps the profile picker to the project's `defaultProfileId` when
    /// one is set (and matches an available bound profile on this host).
    func applyPrefill(from appState: AppState) {
        guard let prefill = appState.composePrefill else { return }
        appState.composePrefill = nil
        if let pid = prefill.projectId,
           let project = projects.first(where: { $0.id == pid })
        {
            selectedProjectId = project.id
            customPath = ""
            selectedProjectPath = project.effectivePaths.first
            // Suggest the project's default profile if it exists on this host.
            if let defaultId = project.defaultProfileId, !defaultId.isEmpty {
                let hasMatch = appState.boundProfiles.contains(where: { $0.profile.id == defaultId })
                if hasMatch { selectedBoundProfileId = defaultId }
            }
        } else if let cwd = prefill.cwd?.trimmingCharacters(in: .whitespacesAndNewlines), !cwd.isEmpty {
            if let match = projects.first(where: { matchesPathInProject(cwd, project: $0) }) {
                selectedProjectId = match.id
                customPath = ""
                // Prefer the exact matching path from paths[] if we can find it.
                selectedProjectPath = match.effectivePaths.first(where: { $0 == cwd }) ?? match.effectivePaths.first
            } else {
                selectedProjectId = nil
                customPath = cwd
                selectedProjectPath = nil
            }
        }
        if let t = prefill.title, !t.isEmpty { title = t }
        if let p = prefill.prompt, !p.isEmpty { prompt = p }
    }

    /// True when the given cwd equals or is under any of the project's paths.
    private func matchesPathInProject(_ cwd: String, project: ProjectInfo) -> Bool {
        for p in project.effectivePaths {
            if cwd == p { return true }
            if cwd.hasPrefix(p + "/") || cwd.hasPrefix(p + "\\") { return true }
        }
        return false
    }

    func syncProfileSelection(from appState: AppState) {
        // "All" is a Sessions filter only — compose always needs a concrete agent.
        if let id = appState.selectedBoundProfileId,
           id != HostStore.allProfilesId,
           appState.boundProfiles.contains(where: { $0.id == id })
        {
            selectedBoundProfileId = id
        } else if let id = selectedBoundProfileId,
                  id != HostStore.allProfilesId,
                  appState.boundProfiles.contains(where: { $0.id == id })
        {
            // Keep the compose pick if Sessions is on All
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
        // Only reset the picker when the current value doesn't make sense for
        // this profile's backend. Anything the user has actively selected from
        // this backend's list wins — profile.model is a first-run default, not
        // an override, or the picker would be cosmetic.
        let list = models(for: bound)
        let trimmed = model.trimmingCharacters(in: .whitespacesAndNewlines)
        let lower = trimmed.lowercased()

        let belongsToOtherBackend: Bool
        if bound.profile.isClaude {
            belongsToOtherBackend =
                lower.contains("grok") || lower.contains("gemini") || trimmed == "antigravity"
        } else if bound.profile.isAntigravity {
            belongsToOtherBackend = lower.contains("grok") || lower.contains("claude")
        } else if bound.profile.isBot {
            belongsToOtherBackend = lower == "grok-build" || trimmed == "antigravity"
        } else {
            belongsToOtherBackend =
                lower.contains("claude") || lower.contains("gemini") || trimmed == "antigravity"
        }

        if trimmed.isEmpty || belongsToOtherBackend {
            model = bound.profile.model ?? list.first ?? trimmed
        }
        // else: keep the user's picker selection (was previously overwritten).
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

    /// Working directory that will be sent on dispatch (project path or custom).
    var resolvedCwd: String {
        let trimmedCustom = customPath.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedCustom.isEmpty { return trimmedCustom }
        if let pid = selectedProjectId,
           let project = projects.first(where: { $0.id == pid })
        {
            let picked = selectedProjectPath?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !picked.isEmpty, project.effectivePaths.contains(picked) { return picked }
            return project.primaryPath
        }
        return ""
    }

    func addExtraFolderPaths(_ paths: [String]) {
        let cwd = resolvedCwd
        for raw in paths {
            let p = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if p.isEmpty || p == cwd { continue }
            if !extraDirs.contains(p) { extraDirs.append(p) }
        }
    }

    func removeExtraDir(_ path: String) {
        extraDirs.removeAll { $0 == path }
    }

    /// RFC-039: per-host "last project used" so the composer stops defaulting
    /// to whatever project happens to be first.
    static func lastProjectKey(_ host: HostEndpoint) -> String { "composer.lastProjectId.\(host.id.uuidString)" }

    func dispatch(appState: AppState) async -> SessionRoute? {
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let images = pendingImages
        guard !text.isEmpty || !images.isEmpty else {
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

        // Host uses profile.backend as source of truth; model is slug for CLI / ACP.
        // Picker choice wins — profile.model is only a fallback when the picker
        // is empty or belongs to a different backend. (Previous behavior
        // unconditionally used profile.model, which made the picker cosmetic.)
        let dispatchModel: String = {
            let picked = model.trimmingCharacters(in: .whitespacesAndNewlines)
            let lower = picked.lowercased()
            if bound.profile.isClaude {
                let wrongBackend = lower.contains("grok") || lower.contains("gemini")
                if picked.isEmpty || wrongBackend { return bound.profile.model ?? "claude" }
                return picked
            }
            if bound.profile.isAntigravity {
                let wrongBackend = lower.contains("grok") || lower.contains("claude")
                if picked.isEmpty || wrongBackend { return bound.profile.model ?? "antigravity" }
                return picked
            }
            if bound.profile.isBot {
                if picked.isEmpty || picked == "grok-build" { return bound.profile.model ?? "grok-4" }
                return picked
            }
            // Grok
            let wrongBackend = lower.contains("claude") || lower.contains("gemini") || picked == "antigravity"
            if picked.isEmpty || wrongBackend { return bound.profile.model ?? "grok-build" }
            return picked
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

        let outboundText: String = {
            if text.isEmpty {
                return images.count == 1
                    ? "Please review this screenshot for debugging."
                    : "Please review these \(images.count) screenshots for debugging."
            }
            return text
        }()

        let grokOnly = bound.profile.isGrok
        var body = DispatchRequestBody(
            prompt: outboundText,
            projectId: selectedProjectId,
            title: title.isEmpty ? nil : title,
            model: dispatchModel,
            planMode: grokOnly ? planMode : false,
            subagents: grokOnly ? subagents : false,
            worktree: grokOnly ? worktree : false,
            profileId: bound.profile.id,
            botId: bound.profile.isBot ? matchedBotId : nil
        )
        if !images.isEmpty {
            body.images = images.map { att in
                PromptImagePayload(
                    mimeType: "image/jpeg",
                    data: att.jpegData.base64EncodedString(),
                    name: "screenshot-\(att.id.uuidString.prefix(8)).jpg"
                )
            }
        }
        if selectedProjectId == nil, !trimmedCustom.isEmpty {
            body.cwd = trimmedCustom
        } else if let pid = selectedProjectId,
                  let project = projects.first(where: { $0.id == pid }),
                  project.effectivePaths.count > 1,
                  let picked = selectedProjectPath?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !picked.isEmpty,
                  project.effectivePaths.contains(picked)
        {
            // Multi-path project: send the chosen path so the server picks it
            // instead of defaulting to paths[0].
            body.cwd = picked
        }
        let extras = extraDirs
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && $0 != body.cwd && $0 != resolvedCwd }
        if !extras.isEmpty { body.extraDirs = extras }

        do {
            let session = try await appState.api.dispatch(body, host: bound.host)
            lastCreatedSessionId = session.id
            if let pid = selectedProjectId {
                UserDefaults.standard.set(pid, forKey: Self.lastProjectKey(bound.host))
            }
            errorMessage = nil
            prompt = ""
            title = ""
            pendingImages = []
            extraDirs = []
            appState.selectBoundProfile(bound.id)
            return SessionRoute(hostId: bound.host.id, sessionId: session.id)
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }
}
