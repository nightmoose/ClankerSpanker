import Foundation

@MainActor
final class DashboardViewModel: ObservableObject {
    @Published var isLoading = false
    @Published var errorMessage: String?

    func load(appState: AppState, quiet: Bool = false) async {
        if !quiet { isLoading = true }
        defer { if !quiet { isLoading = false } }
        await appState.refreshSessions()
        errorMessage = appState.lastRefreshError
    }

    @discardableResult
    func archive(sessionId: String, appState: AppState) async -> Bool {
        guard let host = appState.selectedHost else { return false }
        do {
            _ = try await appState.api.archiveSession(sessionId: sessionId, host: host)
            errorMessage = nil
            await load(appState: appState)
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    @discardableResult
    func unarchive(sessionId: String, appState: AppState) async -> Bool {
        guard let host = appState.selectedHost else { return false }
        do {
            _ = try await appState.api.unarchiveSession(sessionId: sessionId, host: host)
            errorMessage = nil
            await load(appState: appState)
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func attach(disk: DiskSessionHint, appState: AppState) async -> SessionRoute? {
        guard let cwd = disk.cwd, !cwd.isEmpty else {
            errorMessage = "That Grok session has no cwd on disk — open it from the Mac TUI once, or dispatch fresh."
            return nil
        }
        guard let host = appState.selectedHost else {
            errorMessage = "No host selected"
            return nil
        }
        isLoading = true
        defer { isLoading = false }
        do {
            let detail = try await appState.api.attach(
                grokSessionId: disk.id,
                cwd: cwd,
                title: disk.title,
                prompt: nil,
                profileId: appState.selectedBoundProfile?.profile.id,
                host: host
            )
            await load(appState: appState)
            return SessionRoute(hostId: host.id, sessionId: detail.id)
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    func attachAgy(disk: DiskSessionHint, appState: AppState) async -> SessionRoute? {
        guard let cwd = disk.cwd, !cwd.isEmpty else {
            errorMessage = "Could not resolve project path for that Gemini CLI session."
            return nil
        }
        guard let host = appState.selectedHost else {
            errorMessage = "No host selected"
            return nil
        }
        isLoading = true
        defer { isLoading = false }
        do {
            let geminiProfile = appState.selectedBoundProfile?.profile.isAntigravity == true
                ? appState.selectedBoundProfile?.profile.id
                : appState.boundProfiles.first(where: { $0.profile.isAntigravity })?.profile.id
            let detail = try await appState.api.attachAgy(
                conversationId: disk.id,
                cwd: cwd,
                title: disk.title,
                prompt: nil,
                profileId: geminiProfile,
                host: host
            )
            await load(appState: appState)
            return SessionRoute(hostId: host.id, sessionId: detail.id)
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    func attachClaude(disk: DiskSessionHint, mode: String, appState: AppState) async -> SessionRoute? {
        guard let cwd = disk.cwd, !cwd.isEmpty else {
            errorMessage = "Could not resolve project path for that Claude session."
            return nil
        }
        guard let host = appState.selectedHost else {
            errorMessage = "No host selected"
            return nil
        }
        isLoading = true
        defer { isLoading = false }
        do {
            let detail = try await appState.api.attachClaude(
                claudeSessionId: disk.id,
                cwd: cwd,
                title: disk.title,
                mode: mode,
                transcriptPath: disk.transcriptPath,
                profileId: appState.selectedBoundProfile?.profile.id,
                host: host
            )
            await load(appState: appState)
            return SessionRoute(hostId: host.id, sessionId: detail.id)
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }
}
