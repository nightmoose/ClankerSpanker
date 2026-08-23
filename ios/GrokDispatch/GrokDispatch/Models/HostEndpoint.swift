import Foundation
import SwiftUI

/// A ClankerSpanker host machine (Mac Mini, client laptop, …).
struct HostEndpoint: Identifiable, Codable, Equatable, Hashable, Sendable {
    var id: UUID
    /// Friendly label, e.g. "Mac Mini", "FullScore MBP"
    var name: String
    /// e.g. http://192.168.50.9:8787
    var baseURL: String

    init(id: UUID = UUID(), name: String, baseURL: String) {
        self.id = id
        self.name = name
        self.baseURL = HostEndpoint.normalizeBaseURL(baseURL)
    }

    /// scheme://host:port only — strips path like `/v1` so duplicate host entries collapse.
    static func normalizeBaseURL(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var components = URLComponents(string: trimmed),
              let host = components.host, !host.isEmpty
        else {
            return trimmed.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        }
        components.path = ""
        components.query = nil
        components.fragment = nil
        components.user = nil
        components.password = nil
        // Prefer explicit port when present; URLComponents keeps default ports off.
        if let url = components.url {
            return url.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        }
        let scheme = (components.scheme ?? "http").lowercased()
        let port = components.port.map { ":\($0)" } ?? ""
        return "\(scheme)://\(host.lowercased())\(port)"
    }

    /// Equality key for deduping: host:port (case-insensitive).
    var endpointKey: String {
        guard let u = URL(string: baseURL), let host = u.host?.lowercased() else {
            return baseURL.lowercased()
        }
        let port = u.port ?? (u.scheme?.lowercased() == "https" ? 443 : 80)
        return "\(host):\(port)"
    }

    var tokenKey: String { "hostToken.\(id.uuidString)" }

    func loadToken() -> String {
        if let t = KeychainHelper.loadString(key: tokenKey), !t.isEmpty {
            return t
        }
        // Legacy single-host key
        if let t = KeychainHelper.loadString(key: KeychainHelper.Keys.hostToken), !t.isEmpty {
            return t
        }
        #if os(macOS)
        // Loopback hosts: read live gateway token from disk (source of truth).
        if isLoopback, let t = LocalHostConfigFile.readToken(), !t.isEmpty {
            return t
        }
        #endif
        return ""
    }

    func saveToken(_ token: String) {
        let t = token.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty {
            KeychainHelper.delete(key: tokenKey)
        } else {
            KeychainHelper.save(string: t, key: tokenKey)
            // Keep legacy key in sync for first/local host
            if isLoopback {
                KeychainHelper.save(string: t, key: KeychainHelper.Keys.hostToken)
                KeychainHelper.save(string: baseURL, key: KeychainHelper.Keys.hostURL)
            }
        }
    }

    var isLoopback: Bool {
        guard let u = URL(string: baseURL), let host = u.host?.lowercased() else { return false }
        return host == "127.0.0.1" || host == "localhost" || host == "::1"
    }

    func deleteToken() {
        KeychainHelper.delete(key: tokenKey)
    }
}

/// Profile chip bound to a specific host (multi-machine control).
struct BoundProfile: Identifiable, Hashable, Sendable {
    var host: HostEndpoint
    var profile: AgentProfile

    var id: String { "\(host.id.uuidString)|\(profile.id)" }

    var displayName: String { profile.name }
    var hostLabel: String { host.name }
    var uiColor: Color { profile.uiColor }
    var backendLabel: String {
        if profile.isBot { return "Bot" }
        if profile.isClaude { return "Claude" }
        if profile.isAntigravity { return "Antigravity" }
        return "Grok"
    }
}

/// Session list row tied to the host it lives on.
struct HostedSession: Identifiable, Hashable, Sendable {
    var hostId: UUID
    var session: SessionSummary

    var id: String { "\(hostId.uuidString)|\(session.id)" }
}

/// Navigation payload into session detail.
struct SessionRoute: Hashable, Sendable {
    var hostId: UUID
    var sessionId: String
    /// When set, open Transcript and scroll/expand this entry.
    var messageId: String? = nil
}

enum HostStore {
    private static let hostsKey = "clankerspanker.hosts.v1"
    private static let selectedBoundKey = "clankerspanker.selectedBoundProfileId"
    private static let enabledBoundKey = "clankerspanker.enabledBoundProfileIds.v1"

    /// Legacy sentinel for the removed "All" chip. Still recognized on load so
    /// older installs migrate cleanly into multi-select (all chips on).
    static let allProfilesId = "__all__"

    static func loadHosts() -> [HostEndpoint] {
        guard let data = UserDefaults.standard.data(forKey: hostsKey),
              let hosts = try? JSONDecoder().decode([HostEndpoint].self, from: data)
        else {
            return migrateLegacyHost()
        }
        let cleaned = dedupeHosts(hosts)
        // Persist cleanup so Settings / next launch don't re-show ghost duplicates.
        if cleaned.map(\.id) != hosts.map(\.id) || cleaned.map(\.baseURL) != hosts.map(\.baseURL) {
            saveHosts(cleaned)
        }
        return cleaned
    }

    static func saveHosts(_ hosts: [HostEndpoint]) {
        let cleaned = dedupeHosts(hosts)
        if let data = try? JSONEncoder().encode(cleaned) {
            UserDefaults.standard.set(data, forKey: hostsKey)
        }
    }

    /// Keep one host per endpoint. Prefer a named non-empty token holder; migrate token if needed.
    static func dedupeHosts(_ hosts: [HostEndpoint]) -> [HostEndpoint] {
        var byKey: [String: HostEndpoint] = [:]
        var order: [String] = []

        for raw in hosts {
            var h = raw
            h.baseURL = HostEndpoint.normalizeBaseURL(h.baseURL)
            let key = h.endpointKey
            if byKey[key] == nil {
                byKey[key] = h
                order.append(key)
                continue
            }
            guard var kept = byKey[key] else { continue }
            // Prefer non-generic name
            let generic = ["", "Primary", "Host"]
            if generic.contains(kept.name), !generic.contains(h.name) {
                kept.name = h.name
            }
            // Prefer host that already has a token
            let keptTok = kept.loadToken()
            let otherTok = h.loadToken()
            if keptTok.isEmpty, !otherTok.isEmpty {
                kept.saveToken(otherTok)
            }
            byKey[key] = kept
            // Drop orphan token for the discarded id
            if h.id != kept.id {
                h.deleteToken()
            }
        }

        return order.compactMap { byKey[$0] }
    }

    /// Primary/focus profile (compose defaults, host pick). Not the filter set.
    static var selectedBoundProfileId: String? {
        get { UserDefaults.standard.string(forKey: selectedBoundKey) }
        set { UserDefaults.standard.set(newValue, forKey: selectedBoundKey) }
    }

    /// Multi-select filter: which profile chips are ON. Empty means "not yet
    /// migrated / enable all after profiles load".
    static var enabledBoundProfileIds: [String] {
        get { UserDefaults.standard.stringArray(forKey: enabledBoundKey) ?? [] }
        set { UserDefaults.standard.set(newValue, forKey: enabledBoundKey) }
    }

    /// One-time: promote legacy single hostURL/token into a HostEndpoint list.
    private static func migrateLegacyHost() -> [HostEndpoint] {
        let url = KeychainHelper.loadString(key: KeychainHelper.Keys.hostURL)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let token = KeychainHelper.loadString(key: KeychainHelper.Keys.hostToken) ?? ""
        guard !url.isEmpty, !token.isEmpty else { return [] }
        var host = HostEndpoint(name: "Primary", baseURL: url)
        // Stable id for migration so tokens stay findable if re-migrated
        if let existing = UserDefaults.standard.string(forKey: "clankerspanker.legacyHostId"),
           let uuid = UUID(uuidString: existing)
        {
            host.id = uuid
        } else {
            UserDefaults.standard.set(host.id.uuidString, forKey: "clankerspanker.legacyHostId")
        }
        host.saveToken(token)
        saveHosts([host])
        return [host]
    }
}
