"use strict";

const { HostWsMonitor } = require("./host-ws");

/**
 * Multi-host WebSocket pool (RFC-025).
 *
 * Before RFC-025 the desktop shell held a single `HostWsMonitor` bound to
 * `activeHostId`, so events / notifications / tray badge only reflected
 * one host. The pool owns one monitor per registered host with a token
 * and tags every callback (`onStatus`, `onEvent`, `onNotify`) with the
 * source host's id so downstream code can route per-host without falling
 * back to "active".
 */
class HostWsPool {
  /**
   * @param {{
   *   onStatus: (hostId: string, status: 'offline' | 'connecting' | 'live') => void,
   *   onNotify: (hostId: string, title: string, body: string, sessionId?: string, meta?: object) => void,
   *   onEvent: (hostId: string, event: object) => void,
   *   notificationsEnabled: () => boolean,
   * }} opts
   */
  constructor(opts) {
    this.onStatus = opts.onStatus;
    this.onNotify = opts.onNotify;
    this.onEvent = opts.onEvent;
    this.notificationsEnabled = opts.notificationsEnabled;
    /** @type {Map<string, {monitor: HostWsMonitor, conn: {hostURL: string, token: string}, status: string}>} */
    this.slots = new Map();
  }

  /**
   * Reconcile the pool to the current host list. Hosts without a token or
   * URL are torn down; new hosts get a monitor started; existing hosts
   * whose connection changed are restarted.
   *
   * @param {Array<{id: string, name: string}>} hosts
   * @param {(hostId: string) => {hostURL: string, token: string}} connFor
   */
  sync(hosts, connFor) {
    const ids = new Set(hosts.map((h) => h.id));

    // Remove monitors for hosts no longer in the list
    for (const id of Array.from(this.slots.keys())) {
      if (!ids.has(id)) {
        const slot = this.slots.get(id);
        slot.monitor.stop();
        this.slots.delete(id);
        this.onStatus(id, "offline");
      }
    }

    for (const h of hosts) {
      const conn = connFor(h.id) || { hostURL: "", token: "" };
      const slot = this.slots.get(h.id);

      // No token/URL → tear down any existing slot; report offline.
      if (!conn.hostURL || !conn.token) {
        if (slot) {
          slot.monitor.stop();
          this.slots.delete(h.id);
        }
        this.onStatus(h.id, "offline");
        continue;
      }

      if (slot) {
        // Connection unchanged → nothing to do.
        if (slot.conn.hostURL === conn.hostURL && slot.conn.token === conn.token) {
          continue;
        }
        slot.monitor.stop();
        this.slots.delete(h.id);
      }

      const monitor = new HostWsMonitor({
        getConfig: () => ({
          hostURL: conn.hostURL,
          token: conn.token,
          notifications: this.notificationsEnabled(),
        }),
        onStatus: (status) => this.onStatus(h.id, status),
        onNotify: (title, body, sessionId, meta) =>
          this.onNotify(h.id, title, body, sessionId, meta),
        onEvent: (event) => this.onEvent(h.id, event),
      });
      this.slots.set(h.id, { monitor, conn, status: "connecting" });
      monitor.start();
    }
  }

  /** Close every monitor (used on quit). */
  stop() {
    for (const [id, slot] of this.slots) {
      slot.monitor.stop();
      this.onStatus(id, "offline");
    }
    this.slots.clear();
  }

  /** Aggregate status: { total, live } counts for the tray pill. */
  snapshot() {
    // The monitor exposes status transitions via `onStatus`, not a getter.
    // Callers keep their own per-host status map; the pool only reports
    // how many slots exist. Live count is derived externally.
    return {
      total: this.slots.size,
      hostIds: Array.from(this.slots.keys()),
    };
  }
}

module.exports = { HostWsPool };
