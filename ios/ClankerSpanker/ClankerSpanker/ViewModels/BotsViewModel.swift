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
        bots.first { $0.routeKey == selectedBotId } ?? bots.first
    }

    /// RFC-024: fan out bot list across every configured host so a user with
    /// bots on multiple hosts sees them all (was: single-host list).
    /// Mutations route back to the bot's own host via `hostFor(bot:)`.
    func load(appState: AppState, quiet: Bool = false) async {
        let hosts = appState.hosts.filter { !$0.loadToken().isEmpty }
        guard !hosts.isEmpty else {
            errorMessage = "No host selected"
            bots = []
            return
        }
        if !quiet { isLoading = true }
        defer { isLoading = false }

        let api = appState.api
        struct Bundle: Sendable { let host: HostEndpoint; let bots: [Bot]; let error: String? }
        let bundles: [Bundle] = await withTaskGroup(of: Bundle.self) { group in
            for host in hosts {
                group.addTask {
                    do {
                        let list = try await api.listBots(host: host)
                        let hid = host.id.uuidString
                        return Bundle(host: host, bots: list.map { b in
                            var next = b
                            next.hostId = hid
                            return next
                        }, error: nil)
                    } catch {
                        return Bundle(host: host, bots: [], error: error.localizedDescription)
                    }
                }
            }
            var out: [Bundle] = []
            for await b in group { out.append(b) }
            return out
        }

        let merged = bundles.flatMap(\.bots)
        bots = merged
        if selectedBotId == nil || !merged.contains(where: { $0.routeKey == selectedBotId }) {
            selectedBotId = merged.first?.routeKey
        }
        for bot in merged {
            if draftJob[bot.routeKey] == nil { draftJob[bot.routeKey] = bot.job }
            if let host = hostFor(bot: bot, hosts: hosts) {
                do {
                    let box = try await appState.api.botOutbox(id: bot.id, host: host)
                    outbox[bot.routeKey] = box.items
                } catch {
                    outbox[bot.routeKey] = []
                }
            }
        }

        let failures = bundles.compactMap { b -> String? in
            b.error.map { "\(b.host.name): \($0)" }
        }
        if failures.isEmpty {
            errorMessage = nil
        } else if failures.count == bundles.count {
            errorMessage = failures.first
        } else {
            errorMessage = "\(failures.count) host(s) failed: \(failures.joined(separator: " · "))"
        }
    }

    /// Look up the host that owns this bot. Prefers the stamped hostId; falls
    /// back to `appState.selectedHost` for entries that predate RFC-024 (they
    /// have no stamp because they came from the pre-fan-out load).
    private func hostFor(bot: Bot, hosts: [HostEndpoint]) -> HostEndpoint? {
        if let raw = bot.hostId, let uuid = UUID(uuidString: raw) {
            return hosts.first { $0.id == uuid }
        }
        return nil
    }

    func hostFor(bot: Bot, appState: AppState) -> HostEndpoint? {
        hostFor(bot: bot, hosts: appState.hosts) ?? appState.selectedHost
    }

    func setEnabled(_ bot: Bot, _ enabled: Bool, appState: AppState) async {
        guard let host = hostFor(bot: bot, appState: appState) else { return }
        do {
            var updated = try await appState.api.patchBot(
                id: bot.id,
                patch: BotPatch(enabled: enabled),
                host: host
            )
            updated.hostId = host.id.uuidString
            if let idx = bots.firstIndex(where: { $0.routeKey == bot.routeKey }) {
                bots[idx] = updated
            }
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func saveJob(_ bot: Bot, appState: AppState) async {
        guard let host = hostFor(bot: bot, appState: appState) else { return }
        savingId = bot.routeKey
        defer { savingId = nil }
        do {
            let job = draftJob[bot.routeKey] ?? bot.job
            var updated = try await appState.api.patchBot(
                id: bot.id,
                patch: BotPatch(job: job),
                host: host
            )
            updated.hostId = host.id.uuidString
            if let idx = bots.firstIndex(where: { $0.routeKey == bot.routeKey }) {
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
            var created = try await appState.api.createBot(
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
            created.hostId = host.id.uuidString
            errorMessage = nil
            await load(appState: appState, quiet: true)
            selectedBotId = created.routeKey
            draftJob[created.routeKey] = created.job
            return created
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    func setInterval(_ bot: Bot, _ interval: String, appState: AppState) async {
        guard let host = hostFor(bot: bot, appState: appState) else { return }
        do {
            var updated = try await appState.api.patchBot(
                id: bot.id,
                patch: BotPatch(interval: interval),
                host: host
            )
            updated.hostId = host.id.uuidString
            if let idx = bots.firstIndex(where: { $0.routeKey == bot.routeKey }) {
                bots[idx] = updated
            }
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Returns the new run's session id on success.
    /// A host that seeded this hunter without a ContractGate project answers
    /// `Unknown projectId`. Try the other paired copies before showing that.
    @discardableResult
    func run(_ bot: Bot, appState: AppState) async -> String? {
        let targets = runTargets(for: bot, appState: appState)
        guard !targets.isEmpty else { return nil }
        runningId = bot.routeKey
        defer { runningId = nil }
        let note = runNote[bot.routeKey]?.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmed = note?.isEmpty == true ? nil : note
        var lastError: Error?
        for host in targets {
            do {
                let res = try await appState.api.runBot(id: bot.id, note: trimmed, host: host)
                runNote[bot.routeKey] = ""
                errorMessage = nil
                appState.noteSessionHost(sessionId: res.session.id, hostId: host.id)
                await load(appState: appState, quiet: true)
                return res.session.id
            } catch {
                lastError = error
                if !isUnknownProject(error) { break }
            }
        }
        errorMessage = lastError?.localizedDescription
        return nil
    }

    func hostLabel(for bot: Bot, appState: AppState) -> String? {
        hostFor(bot: bot, hosts: appState.hosts)?.name
    }

    /// This row's host first, then any other host that listed the same bot id.
    private func runTargets(for bot: Bot, appState: AppState) -> [HostEndpoint] {
        var seen = Set<UUID>()
        var out: [HostEndpoint] = []
        func add(_ host: HostEndpoint?) {
            guard let host, seen.insert(host.id).inserted else { return }
            out.append(host)
        }
        add(hostFor(bot: bot, appState: appState))
        for other in bots where other.id == bot.id && other.routeKey != bot.routeKey {
            add(hostFor(bot: other, hosts: appState.hosts))
        }
        return out
    }

    private func isUnknownProject(_ error: Error) -> Bool {
        error.localizedDescription.contains("Unknown projectId")
    }

    func enabledBinding(for bot: Bot, appState: AppState) -> Binding<Bool> {
        Binding(
            get: { self.bots.first(where: { $0.routeKey == bot.routeKey })?.enabled ?? bot.enabled },
            set: { newValue in
                Task { await self.setEnabled(bot, newValue, appState: appState) }
            }
        )
    }

    func jobBinding(for bot: Bot) -> Binding<String> {
        Binding(
            get: { self.draftJob[bot.routeKey] ?? bot.job },
            set: { self.draftJob[bot.routeKey] = $0 }
        )
    }

    func noteBinding(for bot: Bot) -> Binding<String> {
        Binding(
            get: { self.runNote[bot.routeKey] ?? "" },
            set: { self.runNote[bot.routeKey] = $0 }
        )
    }
}
