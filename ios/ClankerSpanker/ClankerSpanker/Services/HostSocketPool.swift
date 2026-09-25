import Foundation
import Combine

/// One WebSocket connection per registered host (RFC-024).
///
/// Before RFC-024 the app held a single `WebSocketClient` bound to
/// `selectedHost`, so approvals / question prompts / session updates on
/// non-selected hosts never reached the phone until the user switched hosts.
/// The pool owns one `WebSocketClient` per `HostEndpoint` with a token, tags
/// events with the source host's id, and republishes a merged connectivity
/// signal so UI can show "N hosts unreachable" without collapsing errors.
@MainActor
final class HostSocketPool: ObservableObject {
    /// Per-host connection state.
    @Published private(set) var connected: [UUID: Bool] = [:]
    @Published private(set) var lastError: [UUID: String] = [:]

    /// Fires on every socket message. First argument is the source host's id
    /// so downstream code (`AppState.handleSocketData`) can route by host
    /// without falling back to `selectedHost`.
    var onEvent: ((UUID, Data) -> Void)?
    /// Fires when a specific host's socket transitions offline → online, so
    /// `SessionDetailViewModel` can replay events missed during the gap.
    var onReconnect: ((UUID) -> Void)?

    private struct Slot {
        let client: WebSocketClient
        let cancellable: AnyCancellable
    }

    private var slots: [UUID: Slot] = [:]

    /// At least one host is live. Used for the reachability pill.
    var anyConnected: Bool {
        connected.values.contains(where: { $0 })
    }

    /// Sync sockets to the current host list. Idempotent.
    /// - Adds a connection for any host with a token that we don't already have.
    /// - Reconnects `WebSocketClient` when its target hostEndpoint mutates
    ///   (`WebSocketClient.connect` short-circuits if the id is unchanged).
    /// - Removes clients for hosts that dropped out of the list.
    /// - Also drops slots for hosts whose token was cleared.
    func sync(with hosts: [HostEndpoint]) {
        let currentIds = Set(hosts.map(\.id))

        for id in Array(slots.keys) where !currentIds.contains(id) {
            slots[id]?.client.disconnect()
            slots[id] = nil
            connected.removeValue(forKey: id)
            lastError.removeValue(forKey: id)
        }

        for h in hosts {
            let token = h.loadToken()
            if token.isEmpty {
                if let slot = slots[h.id] {
                    slot.client.disconnect()
                    slots[h.id] = nil
                    connected[h.id] = false
                }
                continue
            }
            if slots[h.id] == nil {
                slots[h.id] = makeSlot(for: h.id)
            }
            slots[h.id]?.client.connect(host: h)
        }
    }

    /// Close every socket (sign out / clearConfiguration).
    func disconnectAll() {
        for (id, slot) in slots {
            slot.client.disconnect()
            connected[id] = false
            lastError.removeValue(forKey: id)
            _ = slot
        }
        slots.removeAll()
    }

    /// True if this host currently has a live socket.
    func isConnected(hostId: UUID) -> Bool {
        connected[hostId] ?? false
    }

    private func makeSlot(for hostId: UUID) -> Slot {
        let client = WebSocketClient()
        client.onEvent = { [weak self] data in
            self?.onEvent?(hostId, data)
        }
        var wasConnected = false
        let cancellable = client.$isConnected
            .receive(on: RunLoop.main)
            .sink { [weak self] isConn in
                guard let self else { return }
                self.connected[hostId] = isConn
                if isConn && !wasConnected {
                    self.onReconnect?(hostId)
                }
                wasConnected = isConn
            }
        return Slot(client: client, cancellable: cancellable)
    }
}
