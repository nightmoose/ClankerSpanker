import SwiftUI

struct OnboardingView: View {
    @EnvironmentObject private var appState: AppState

    @State private var hostURL = ConnectionDefaults.suggestedHostURL
    @State private var hostToken = ""
    @State private var isTesting = false
    @State private var errorMessage: String?
    @State private var successMessage: String?
    @State private var showToken = true
    @State private var showManualSteps = false

    var body: some View {
        ZStack {
            DispatchBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("ClankerSpanker")
                            .font(.largeTitle.bold())
                        #if os(macOS)
                        Text("Command center for Grok Build + Claude Code. Connect to a local host on this Mac, or any gateway on LAN / Tailscale.")
                            .foregroundStyle(.secondary)
                        #else
                        Text("Remote control for Grok Build + Claude Code on your Mac. Two fields only.")
                            .foregroundStyle(.secondary)
                        #endif
                    }
                    .padding(.top, 24)

                    #if os(macOS)
                    DispatchCard {
                        VStack(alignment: .leading, spacing: 12) {
                            Label("Use this Mac as the host", systemImage: "desktopcomputer")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(DispatchColors.accent)
                            Text("Starts the local gateway (if needed) and imports the token from ~/.grok-dispatch/config.json.")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                            DispatchButton(
                                title: isTesting ? "Starting…" : "Start & connect local host",
                                icon: "play.circle.fill",
                                isLoading: isTesting
                            ) {
                                Task { await connectLocalMac() }
                            }
                        }
                    }
                    #endif

                    // Automatic setup — recommended path. Fills the fields below.
                    DispatchCard {
                        VStack(alignment: .leading, spacing: 12) {
                            Label("Automatic setup", systemImage: "sparkles")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(DispatchColors.accent)
                            #if os(iOS) && !targetEnvironment(simulator)
                            // RFC-043: the host only shares its token with its own
                            // machine (RFC-026). Pair by QR from the Mac.
                            Text("On the Mac running the host, open \(ConnectionDefaults.setupPageURL.absoluteString) and point this iPhone's camera at the QR code. The app asks before adding the host.")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                            #else
                            Text("Grabs the host URL and token from the host on this machine, then you tap Save & connect.")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                            #endif

                            #if targetEnvironment(simulator)
                            DispatchButton(
                                title: "Use simulator defaults + fill token",
                                icon: "laptopcomputer"
                            ) {
                                hostURL = ConnectionDefaults.simulatorHostURL
                                Task { await fetchTokenFromLocalSetup() }
                            }
                            #elseif os(macOS)
                            DispatchButton(
                                title: "Fetch token from this Mac",
                                icon: "arrow.down.circle"
                            ) {
                                Task { await fetchTokenFromLocalSetup() }
                            }
                            #endif
                        }
                    }

                    DispatchCard {
                        VStack(alignment: .leading, spacing: 16) {
                            field(
                                title: "Host URL",
                                prompt: ConnectionDefaults.hostURLPlaceholder,
                                text: $hostURL,
                                secure: false
                            )
                            HStack {
                                Text("Host token")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.secondary)
                                Spacer()
                                Button(showToken ? "Hide" : "Show") {
                                    showToken.toggle()
                                }
                                .font(.caption)
                            }
                            Group {
                                if showToken {
                                    TextField("Paste token from /setup page", text: $hostToken)
                                } else {
                                    SecureField("Paste token from /setup page", text: $hostToken)
                                }
                            }
                            #if os(iOS)
                            .textInputAutocapitalization(.never)
                            #endif
                            .autocorrectionDisabled()
                            .padding(12)
                            .background(Color.white.opacity(0.06))
                            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))

                            Text("xAI API key is NOT needed. The host machine already has Grok / Claude signed in.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }

                    if let errorMessage {
                        Text(errorMessage)
                            .font(.footnote)
                            .foregroundStyle(DispatchColors.danger)
                    }
                    if let successMessage {
                        Text(successMessage)
                            .font(.footnote)
                            .foregroundStyle(DispatchColors.success)
                    }

                    DispatchButton(
                        title: isTesting ? "Connecting…" : "Save & connect",
                        icon: "link",
                        isLoading: isTesting
                    ) {
                        Task { await saveAndTest() }
                    }

                    // Manual fallback — collapsed by default so the automatic
                    // path is the visible one. Users only need this when the
                    // fetch fails or they're on a different network.
                    DispatchCard {
                        DisclosureGroup(isExpanded: $showManualSteps) {
                            VStack(alignment: .leading, spacing: 10) {
                                #if os(macOS)
                                numbered("Run the host on this Mac or another machine")
                                numbered("Open the setup page and copy the host token")
                                #else
                                numbered("On the Mac running the host, open:")
                                #endif
                                Text(ConnectionDefaults.setupPageURL.absoluteString)
                                    .font(.system(.footnote, design: .monospaced))
                                    .foregroundStyle(DispatchColors.accent)
                                    .textSelection(.enabled)
                                #if os(macOS)
                                numbered("Paste URL + token above and Save & connect")
                                #else
                                numbered("Scan the QR code with the Camera app — or type the Host URL shown there and paste the token above")
                                numbered("Tap Save & connect (leave API key blank forever)")
                                #endif
                            }
                            .padding(.top, 8)
                        } label: {
                            Label("Manual setup", systemImage: "list.number")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(.secondary)
                        }
                        .tint(DispatchColors.accent)
                    }
                }
                .padding(20)
            }
        }
        .onOpenURL { url in
            applyDeepLink(url)
        }
    }

    private func numbered(_ text: String) -> some View {
        Text("• \(text)")
            .font(.subheadline)
            .foregroundStyle(.primary.opacity(0.9))
    }

    private func field(title: String, prompt: String, text: Binding<String>, secure: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
            Group {
                if secure {
                    SecureField(prompt, text: text)
                } else {
                    TextField(prompt, text: text)
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                        #endif
                        .autocorrectionDisabled()
                }
            }
            .padding(12)
            .background(Color.white.opacity(0.06))
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
    }

    #if os(macOS)
    private func connectLocalMac() async {
        errorMessage = nil
        successMessage = nil
        isTesting = true
        defer { isTesting = false }

        guard let pair = await LocalHostController.shared.bootstrapLocalHost() else {
            errorMessage = LocalHostController.shared.lastError
                ?? "Could not start local host. Build host/ and set package path in Settings."
            return
        }
        hostURL = pair.url
        hostToken = pair.token
        appState.saveConfiguration(hostURL: pair.url, hostToken: pair.token, xaiKey: nil)
        do {
            guard let host = appState.hosts.first else {
                errorMessage = "Host not saved"
                return
            }
            try await appState.api.validate(host: host)
            successMessage = "Connected to local host"
            await appState.refreshSessions()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
    #endif

    private func applyDeepLink(_ url: URL) {
        guard url.scheme == "clankerspanker" || url.scheme == "grokdispatch" else { return }
        let comps = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let items = comps?.queryItems ?? []
        if let u = items.first(where: { $0.name == "url" })?.value {
            hostURL = u
        }
        if let t = items.first(where: { $0.name == "token" })?.value {
            hostToken = t
        }
        Task { await saveAndTest() }
    }

    /// Pull token from the host's public /connect.json on the LAN (no typing).
    private func fetchTokenFromLocalSetup() async {
        errorMessage = nil
        successMessage = nil
        isTesting = true
        defer { isTesting = false }

        let candidates = [
            hostURL.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/connect.json",
            ConnectionDefaults.simulatorHostURL + "/connect.json",
        ]

        for raw in candidates {
            guard let url = URL(string: raw) else { continue }
            do {
                let (data, response) = try await URLSession.shared.data(from: url)
                guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { continue }
                if let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let token = obj["hostToken"] as? String,
                   let remoteURL = obj["hostURL"] as? String {
                    hostToken = token
                    // Prefer the URL we already chose (simulator vs LAN) if user edited it
                    if hostURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        hostURL = remoteURL
                    }
                    successMessage = "Got token from Mac. Tap Save & connect."
                    return
                }
            } catch {
                continue
            }
        }
        errorMessage = "The host only shares its token with apps on the same machine. On the Mac, open http://localhost:8787/setup and scan the QR code with this iPhone's camera."
    }

    private func saveAndTest() async {
        errorMessage = nil
        successMessage = nil
        guard !hostURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !hostToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else {
            errorMessage = "Host URL and token are required — tap “Fetch token from Mac” first"
            return
        }

        isTesting = true
        defer { isTesting = false }

        appState.saveConfiguration(
            hostURL: hostURL,
            hostToken: hostToken,
            xaiKey: nil
        )

        do {
            guard let host = appState.hosts.first else {
                errorMessage = "Host not saved"
                return
            }
            try await appState.api.validate(host: host)
            successMessage = "Connected"
            await appState.refreshSessions()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
