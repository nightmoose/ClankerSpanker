import Foundation
import SwiftUI

@MainActor
final class BotsViewModel: ObservableObject {
    @Published var bots: [Bot] = []
    @Published var selectedBotId: String?
    @Published var outbox: [String: [BotOutboxItem]] = [:]
    @Published var draftJob: [String: String] = [:]
    @Published var runNote: [String: String] = [:]
    @Published var runningId: String?
    @Published var savingId: String?
    @Published var isLoading = false
    @Published var errorMessage: String?
    @Published var expandedOutbox: BotOutboxItem?

    var selectedBot: Bot? {
        bots.first { $0.id == selectedBotId } ?? bots.first
    }

    func load(appState: AppState, quiet: Bool = false) async {
        guard let host = appState.selectedHost else {
            errorMessage = "No host selected"
            return
        }
        if !quiet { isLoading = true }
        defer { isLoading = false }
        do {
            let list = try await appState.api.listBots(host: host)
            bots = list
            if selectedBotId == nil || !list.contains(where: { $0.id == selectedBotId }) {
                selectedBotId = list.first?.id
            }
            for bot in list {
                if draftJob[bot.id] == nil { draftJob[bot.id] = bot.job }
                do {
                    let box = try await appState.api.botOutbox(id: bot.id, host: host)
                    outbox[bot.id] = box.items
                } catch {
                    outbox[bot.id] = []
                }
            }
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func setEnabled(_ bot: Bot, _ enabled: Bool, appState: AppState) async {
        guard let host = appState.selectedHost else { return }
        do {
            let updated = try await appState.api.patchBot(
                id: bot.id,
                patch: BotPatch(enabled: enabled),
                host: host
            )
            if let idx = bots.firstIndex(where: { $0.id == bot.id }) {
                bots[idx] = updated
            }
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func saveJob(_ bot: Bot, appState: AppState) async {
        guard let host = appState.selectedHost else { return }
        savingId = bot.id
        defer { savingId = nil }
        do {
            let job = draftJob[bot.id] ?? bot.job
            let updated = try await appState.api.patchBot(
                id: bot.id,
                patch: BotPatch(job: job),
                host: host
            )
            if let idx = bots.firstIndex(where: { $0.id == bot.id }) {
                bots[idx] = updated
            }
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    @discardableResult
    func create(
        name: String,
        profileId: String,
        projectId: String,
        job: String,
        interval: String,
        enabled: Bool,
        appState: AppState
    ) async -> Bot? {
        guard let host = appState.selectedHost else {
            errorMessage = "No host selected"
            return nil
        }
        isLoading = true
        defer { isLoading = false }
        do {
            let created = try await appState.api.createBot(
                BotCreate(
                    name: name,
                    profileId: profileId,
                    projectId: projectId,
                    job: job,
                    interval: interval,
                    enabled: enabled
                ),
                host: host
            )
            errorMessage = nil
            await load(appState: appState, quiet: true)
            selectedBotId = created.id
            draftJob[created.id] = created.job
            return created
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    func setInterval(_ bot: Bot, _ interval: String, appState: AppState) async {
        guard let host = appState.selectedHost else { return }
        do {
            let updated = try await appState.api.patchBot(
                id: bot.id,
                patch: BotPatch(interval: interval),
                host: host
            )
            if let idx = bots.firstIndex(where: { $0.id == bot.id }) {
                bots[idx] = updated
            }
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Returns the new run's session id on success.
    @discardableResult
    func run(_ bot: Bot, appState: AppState) async -> String? {
        guard let host = appState.selectedHost else { return nil }
        runningId = bot.id
        defer { runningId = nil }
        do {
            let note = runNote[bot.id]?.trimmingCharacters(in: .whitespacesAndNewlines)
            let res = try await appState.api.runBot(
                id: bot.id,
                note: note?.isEmpty == true ? nil : note,
                host: host
            )
            runNote[bot.id] = ""
            errorMessage = nil
            await load(appState: appState, quiet: true)
            return res.session.id
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    func enabledBinding(for bot: Bot, appState: AppState) -> Binding<Bool> {
        Binding(
            get: { self.bots.first(where: { $0.id == bot.id })?.enabled ?? bot.enabled },
            set: { newValue in
                Task { await self.setEnabled(bot, newValue, appState: appState) }
            }
        )
    }

    func jobBinding(for bot: Bot) -> Binding<String> {
        Binding(
            get: { self.draftJob[bot.id] ?? bot.job },
            set: { self.draftJob[bot.id] = $0 }
        )
    }

    func noteBinding(for bot: Bot) -> Binding<String> {
        Binding(
            get: { self.runNote[bot.id] ?? "" },
            set: { self.runNote[bot.id] = $0 }
        )
    }
}
