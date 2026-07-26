import Foundation

@MainActor
final class DashboardViewModel: ObservableObject {
    @Published var isLoading = false
    @Published var errorMessage: String?

    func load(appState: AppState) async {
        isLoading = true
        defer { isLoading = false }
        do {
            let response = try await appState.api.sessions()
            appState.sessions = response.sessions
            appState.archivedSessions = response.archivedSessions ?? []
            appState.diskSessions = response.diskSessions ?? []
            appState.claudeSessions = response.claudeSessions ?? []
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Returns true when the host accepted the archive.
    @discardableResult
    func archive(sessionId: String, appState: AppState) async -> Bool {
        do {
            _ = try await appState.api.archiveSession(sessionId: sessionId)
            errorMessage = nil
            await load(appState: appState)
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    /// Returns true when the host accepted the unarchive.
    @discardableResult
    func unarchive(sessionId: String, appState: AppState) async -> Bool {
        do {
            _ = try await appState.api.unarchiveSession(sessionId: sessionId)
            errorMessage = nil
            await load(appState: appState)
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func attach(disk: DiskSessionHint, appState: AppState) async -> String? {
        guard let cwd = disk.cwd, !cwd.isEmpty else {
            errorMessage = "That Grok session has no cwd on disk — open it from the Mac TUI once, or dispatch fresh."
            return nil
        }
        isLoading = true
        defer { isLoading = false }
        do {
            let detail = try await appState.api.attach(
                grokSessionId: disk.id,
                cwd: cwd,
                title: disk.title,
                prompt: nil
            )
            await load(appState: appState)
            return detail.id
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    /// mode: continue-with-grok (default) | resume-claude
    func attachClaude(disk: DiskSessionHint, mode: String, appState: AppState) async -> String? {
        guard let cwd = disk.cwd, !cwd.isEmpty else {
            errorMessage = "Could not resolve project path for that Claude session."
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
                transcriptPath: disk.transcriptPath
            )
            await load(appState: appState)
            return detail.id
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }
}
