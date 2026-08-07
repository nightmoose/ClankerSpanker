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
        self.baseURL = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
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
    var backendLabel: String { profile.isClaude ? "Claude" : "Grok" }
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
}

enum HostStore {
    private static let hostsKey = "clankerspanker.hosts.v1"
    private static let selectedBoundKey = "clankerspanker.selectedBoundProfileId"

    static func loadHosts() -> [HostEndpoint] {
        guard let data = UserDefaults.standard.data(forKey: hostsKey),
              let hosts = try? JSONDecoder().decode([HostEndpoint].self, from: data)
        else {
            return migrateLegacyHost()
        }
        return hosts
    }

    static func saveHosts(_ hosts: [HostEndpoint]) {
        if let data = try? JSONEncoder().encode(hosts) {
            UserDefaults.standard.set(data, forKey: hostsKey)
        }
    }

    static var selectedBoundProfileId: String? {
        get { UserDefaults.standard.string(forKey: selectedBoundKey) }
        set { UserDefaults.standard.set(newValue, forKey: selectedBoundKey) }
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
