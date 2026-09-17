import SwiftUI

/// Phone hunters. Mac command center hosts sidebar + detail in the same
/// NavigationSplitView as Sessions (`BotsSidebar` / `BotsDetail`).
struct BotsView: View {
    @EnvironmentObject private var appState: AppState
    @StateObject private var vm = BotsViewModel()
    @State private var pendingRoute: SessionRoute?
    @State private var showNewBot = false
    @State private var detailBot: BotNav?

    private struct BotNav: Hashable, Identifiable {
        var id: String
    }

    var body: some View {
        NavigationStack {
            ZStack {
                DispatchBackground()
                VStack(spacing: 0) {
                    botsChrome
                    if let errorMessage = vm.errorMessage, !vm.bots.isEmpty {
                        Text(errorMessage)
                            .font(.caption)
                            .foregroundStyle(DispatchColors.danger)
                            .padding(.horizontal, 12)
                            .padding(.bottom, 6)
                    }
                    botsList
                }
            }
            .navigationTitle("")
            #if os(iOS)
            .toolbar(.hidden, for: .navigationBar)
            #endif
            .navigationDestination(item: $pendingRoute) { route in
                if let host = appState.hosts.first(where: { $0.id == route.hostId }) {
                    SessionDetailView(
                        sessionId: route.sessionId,
                        host: host,
                        scrollToMessageId: route.messageId
                    )
                } else {
                    Text("Host no longer available").foregroundStyle(.secondary)
                }
            }
            .navigationDestination(item: $detailBot) { nav in
                ZStack {
                    DispatchBackground()
                    BotsDetail(vm: vm, onOpenSession: openSession, pinnedBotId: nav.id, compact: true)
                }
                .navigationTitle(vm.bots.first(where: { $0.id == nav.id })?.name ?? "Bot")
                #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar(.visible, for: .navigationBar)
                #endif
            }
            .sheet(isPresented: $showNewBot) {
                NewBotSheet(vm: vm)
                    .environmentObject(appState)
            }
            .task { await vm.load(appState: appState) }
            .onReceive(NotificationCenter.default.publisher(for: .dispatchSocketEvent)) { note in
                guard let data = note.object as? Data,
                      let type = DispatchSocket.eventType(from: data),
                      type.hasPrefix("bot.")
                else { return }
                Task { await vm.load(appState: appState, quiet: true) }
            }
            .onChange(of: appState.selectedHost?.id) { _, _ in
                Task { await vm.load(appState: appState) }
            }
            .onChange(of: appState.tabRefreshTick) { _, _ in
                guard appState.selectedTab == .bots else { return }
                Task { await vm.load(appState: appState) }
            }
        }
    }

    private var botsChrome: some View {
        HStack(spacing: 12) {
            Button {
                showNewBot = true
            } label: {
                Image(systemName: "plus.circle.fill")
                    .font(.title3)
                    .foregroundStyle(DispatchColors.accent)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("New bot")

            Text("Bots")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)

            Spacer(minLength: 8)

            if vm.isLoading && vm.bots.isEmpty {
                ProgressView().controlSize(.small)
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 4)
        .padding(.bottom, 6)
    }

    @ViewBuilder
    private var botsList: some View {
        if let errorMessage = vm.errorMessage, vm.bots.isEmpty {
            Text(errorMessage)
                .font(.caption)
                .foregroundStyle(DispatchColors.danger)
                .padding()
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        } else if vm.bots.isEmpty && !vm.isLoading {
            VStack(spacing: 14) {
                Spacer()
                Image(systemName: "scope")
                    .font(.system(size: 44, weight: .ultraLight))
                    .foregroundStyle(.secondary)
                Text("No bots yet")
                    .font(.title3.weight(.semibold))
                Text("Create a hunter, give it a standing job, and run it from here. Drafts land in the outbox — nothing is sent.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 24)
                Button {
                    showNewBot = true
                } label: {
                    Label("New bot", systemImage: "plus.circle.fill")
                }
                .buttonStyle(.borderedProminent)
                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    ForEach(vm.bots) { bot in
                        phoneBotRow(bot)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 24)
            }
        }
    }

    private func phoneBotRow(_ bot: Bot) -> some View {
        DispatchCard {
            VStack(alignment: .leading, spacing: 10) {
                Button {
                    detailBot = BotNav(id: bot.id)
                } label: {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(bot.name)
                                .font(.body.weight(.semibold))
                                .foregroundStyle(.primary)
                                .lineLimit(1)
                            Spacer(minLength: 4)
                            Text(bot.enabled ? "On" : "Paused")
                                .font(.caption2.weight(.bold))
                                .padding(.horizontal, 8)
                                .padding(.vertical, 3)
                                .foregroundStyle(bot.enabled ? DispatchColors.success : .secondary)
                                .background((bot.enabled ? DispatchColors.success : Color.secondary).opacity(0.15))
                                .clipShape(Capsule())
                        }
                        Text(jobPreview(bot))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                        HStack(spacing: 10) {
                            Text(BotSchedule.label(bot.interval))
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                            if let last = bot.lastRunDate {
                                Text(last.formatted(.relative(presentation: .named)))
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                            } else {
                                Text("Never run")
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                            }
                        }
                    }
                }
                .buttonStyle(.plain)

                HStack(spacing: 10) {
                    Button {
                        Task {
                            if let sid = await vm.run(bot, appState: appState) {
                                openSession(sid)
                            }
                        }
                    } label: {
                        Label(vm.runningId == bot.id ? "Starting…" : "Run now", systemImage: "play.fill")
                            .font(.subheadline.weight(.semibold))
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(vm.runningId == bot.id)

                    if let sid = bot.lastSessionId {
                        Button("Last run") { openSession(sid) }
                            .font(.subheadline.weight(.semibold))
                    }
                    Spacer(minLength: 0)
                }
            }
        }
    }

    private func jobPreview(_ bot: Bot) -> String {
        let line = bot.job
            .split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .first { !$0.isEmpty }
        return line.map { String($0) } ?? "No standing job"
    }

    private func openSession(_ sessionId: String) {
        guard let host = appState.selectedHost else { return }
        pendingRoute = SessionRoute(hostId: host.id, sessionId: sessionId)
    }
}

struct BotsSidebar: View {
    @EnvironmentObject private var appState: AppState
    @ObservedObject var vm: BotsViewModel
    var onNewBot: (() -> Void)?

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Bots")
                    .font(.title3.weight(.bold))
                Spacer()
                Text("\(vm.bots.count)")
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(Capsule().fill(DispatchColors.accentSecondary.opacity(0.18)))
                    .foregroundStyle(DispatchColors.accentSecondary)
                if onNewBot != nil {
                    Button {
                        onNewBot?()
                    } label: {
                        Image(systemName: "plus.circle.fill")
                    }
                    .buttonStyle(.plain)
                    .help("New bot")
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 14)
            .padding(.bottom, 10)

            if let errorMessage = vm.errorMessage, vm.bots.isEmpty {
                Text(errorMessage)
                    .font(.caption)
                    .foregroundStyle(DispatchColors.danger)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 8)
                    .textSelection(.enabled)
            }

            Divider()

            List(selection: $vm.selectedBotId) {
                if vm.isLoading && vm.bots.isEmpty {
                    ProgressView("Loading…")
                        .controlSize(.small)
                } else if vm.bots.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("No bots on this host yet.")
                            .foregroundStyle(.secondary)
                        if onNewBot != nil {
                            Button("New bot") { onNewBot?() }
                        }
                    }
                    .padding(.vertical, 8)
                } else {
                    Section {
                        ForEach(vm.bots) { bot in
                            BotsSidebarRow(bot: bot)
                                .tag(bot.id)
                        }
                    } header: {
                        Text("Hunters")
                    }
                }
            }
            .listStyle(.sidebar)
        }
        #if os(macOS)
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.5))
        #endif
        .task { await vm.load(appState: appState) }
        .onReceive(NotificationCenter.default.publisher(for: .dispatchSocketEvent)) { note in
            guard let data = note.object as? Data,
                  let type = DispatchSocket.eventType(from: data),
                  type.hasPrefix("bot.")
            else { return }
            Task { await vm.load(appState: appState, quiet: true) }
        }
        .onChange(of: appState.selectedHost?.id) { _, _ in
            Task { await vm.load(appState: appState) }
        }
    }
}

private struct BotsSidebarRow: View {
    let bot: Bot

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(bot.name)
                    .font(.body.weight(.semibold))
                    .lineLimit(1)
                Spacer(minLength: 4)
                Text(bot.enabled ? "On" : "Paused")
                    .font(.caption2.weight(.bold))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .foregroundStyle(bot.enabled ? DispatchColors.success : .secondary)
                    .background((bot.enabled ? DispatchColors.success : Color.secondary).opacity(0.15))
                    .clipShape(Capsule())
            }
            Text(jobPreview)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
            HStack(spacing: 10) {
                Text("Every \(bot.interval)")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                if let last = bot.lastRunDate {
                    Text(last.formatted(.relative(presentation: .named)))
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                } else {
                    Text("Never run")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .padding(.vertical, 4)
    }

    private var jobPreview: String {
        let line = bot.job
            .split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .first { !$0.isEmpty }
        return line.map { String($0) } ?? "No standing job"
    }
}

struct BotsDetail: View {
    @EnvironmentObject private var appState: AppState
    @ObservedObject var vm: BotsViewModel
    var onOpenSession: ((String) -> Void)?
    var onNewBot: (() -> Void)?
    /// When set (phone push), show this bot instead of the sidebar selection.
    var pinnedBotId: String? = nil
    var compact: Bool = false

    private var displayedBot: Bot? {
        if let pinnedBotId {
            return vm.bots.first { $0.id == pinnedBotId } ?? vm.selectedBot
        }
        return vm.selectedBot
    }

    var body: some View {
        Group {
            if let bot = displayedBot {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        header(bot)
                        if let errorMessage = vm.errorMessage {
                            Text(errorMessage)
                                .font(.callout)
                                .foregroundStyle(DispatchColors.danger)
                                .textSelection(.enabled)
                        }
                        jobEditor(bot)
                        runControls(bot)
                        outboxSection(bot)
                    }
                    .padding(compact ? 16 : 24)
                    .frame(maxWidth: compact ? .infinity : 760, alignment: .leading)
                }
            } else if vm.isLoading {
                ProgressView("Loading bots…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                VStack(spacing: 16) {
                    Spacer()
                    Image(systemName: "scope")
                        .font(.system(size: 48, weight: .ultraLight))
                        .foregroundStyle(.secondary)
                    Text(vm.bots.isEmpty ? "No bots yet" : "Select a bot")
                        .font(.title2.weight(.semibold))
                    Text(vm.bots.isEmpty
                         ? "Create a hunter, give it a standing job, and set how often it runs."
                         : "Hunters live in the list on the left — same idea as Sessions.")
                        .foregroundStyle(.secondary)
                    if vm.bots.isEmpty, onNewBot != nil {
                        Button {
                            onNewBot?()
                        } label: {
                            Label("New bot", systemImage: "plus.circle.fill")
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                    }
                    Spacer()
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        #if os(macOS)
        .background(Color(nsColor: .windowBackgroundColor))
        #endif
        .sheet(item: $vm.expandedOutbox) { item in
            NavigationStack {
                ScrollView {
                    Text(item.content)
                        .font(.system(.body, design: .monospaced))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding()
                }
                .navigationTitle(item.filename)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Done") { vm.expandedOutbox = nil }
                    }
                }
            }
            #if os(macOS)
            .frame(minWidth: 560, minHeight: 420)
            #endif
        }
    }

    private func header(_ bot: Bot) -> some View {
        let titleAndStatus = VStack(alignment: .leading, spacing: 4) {
            if !compact {
                Text(bot.name)
                    .font(.title2.weight(.bold))
            }
            Text(bot.enabled ? "Scheduled" : "Paused · Run now still works")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        let interval = Picker("Interval", selection: intervalBinding(bot)) {
            ForEach(intervalChoices(for: bot), id: \.self) { value in
                Text(BotSchedule.label(value)).tag(value)
            }
        }
        .labelsHidden()
        .help("How often the host fires this job when enabled")
        let enabled = Toggle("Enabled", isOn: vm.enabledBinding(for: bot, appState: appState))
            .toggleStyle(.switch)
            .help("When on, the host fires this job when enabled. Off = Run now only.")

        return Group {
            if compact {
                VStack(alignment: .leading, spacing: 12) {
                    titleAndStatus
                    HStack {
                        interval
                            .pickerStyle(.menu)
                        Spacer()
                        enabled
                    }
                }
            } else {
                HStack(alignment: .firstTextBaseline) {
                    titleAndStatus
                    Spacer()
                    interval
                        .frame(minWidth: 160)
                    enabled
                        .labelsHidden()
                }
            }
        }
    }

    private func intervalChoices(for bot: Bot) -> [String] {
        BotSchedule.presets.contains(bot.interval)
            ? BotSchedule.presets
            : BotSchedule.presets + [bot.interval]
    }

    private func intervalBinding(_ bot: Bot) -> Binding<String> {
        Binding(
            get: { vm.bots.first(where: { $0.id == bot.id })?.interval ?? bot.interval },
            set: { newValue in
                Task { await vm.setInterval(bot, newValue, appState: appState) }
            }
        )
    }

    private func jobEditor(_ bot: Bot) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Standing job")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            TextEditor(text: vm.jobBinding(for: bot))
                .font(.system(.body, design: .monospaced))
                .frame(minHeight: 220)
                .padding(6)
                .background(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.primary.opacity(0.12)))
            HStack {
                Button {
                    Task { await vm.saveJob(bot, appState: appState) }
                } label: {
                    Label(vm.savingId == bot.id ? "Saving…" : "Save job", systemImage: "square.and.arrow.down")
                }
                .disabled(vm.savingId == bot.id)
                Spacer()
                if let last = bot.lastRunDate {
                    Text("Last run \(last.formatted(.relative(presentation: .named)))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func runControls(_ bot: Bot) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            TextField("One-shot note for the next run (optional)", text: vm.noteBinding(for: bot), axis: .vertical)
                .lineLimit(2...4)
                .textFieldStyle(.roundedBorder)
            HStack {
                Button {
                    Task {
                        if let sid = await vm.run(bot, appState: appState) {
                            onOpenSession?(sid)
                        }
                    }
                } label: {
                    Label(vm.runningId == bot.id ? "Starting…" : "Run now", systemImage: "play.fill")
                }
                .buttonStyle(.borderedProminent)
                .disabled(vm.runningId == bot.id)

                if let sid = bot.lastSessionId {
                    Button("Open last run") {
                        onOpenSession?(sid)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func outboxSection(_ bot: Bot) -> some View {
        let items = vm.outbox[bot.id] ?? []
        VStack(alignment: .leading, spacing: 8) {
            Text("Outbox · \(items.count)")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            if items.isEmpty {
                Text("No drafts yet. Run the bot; briefs and outbound drafts land here. Nothing is sent.")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            } else {
                ForEach(items.prefix(20)) { item in
                    Button {
                        vm.expandedOutbox = item
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(item.filename)
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.primary)
                                Text(item.content.prefix(90).replacingOccurrences(of: "\n", with: " "))
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(2)
                            }
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(.top, 8)
    }
}
