"use strict";

/**
 * Main-process WebSocket client for OS notifications / tray status.
 * Independent of the renderer so alerts work while the window is hidden.
 */

class HostWsMonitor {
  /**
   * @param {{
   *   getConfig: () => { hostURL: string, token: string, notifications?: boolean },
   *   onStatus: (status: 'offline' | 'connecting' | 'live') => void,
   *   onNotify: (title: string, body: string, sessionId?: string, meta?: object) => void,
   *   onEvent?: (event: object) => void,
   * }} opts
   */
  constructor(opts) {
    this.getConfig = opts.getConfig;
    this.onStatus = opts.onStatus;
    this.onNotify = opts.onNotify;
    this.onEvent = opts.onEvent;
    /** @type {WebSocket | null} */
    this.ws = null;
    this.reconnectTimer = null;
    this.stopped = true;
    this.backoffMs = 1000;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.clearReconnect();
    this.closeSocket();
    this.onStatus("offline");
  }

  restart() {
    this.stop();
    this.stopped = false;
    this.backoffMs = 1000;
    this.connect();
  }

  clearReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  closeSocket() {
    if (this.ws) {
      try {
        this.ws.onopen = null;
        this.ws.onclose = null;
        this.ws.onerror = null;
        this.ws.onmessage = null;
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  async connect() {
    if (this.stopped) return;
    this.clearReconnect();
    this.closeSocket();
    const attempt = (this.attempt = (this.attempt || 0) + 1);

    const { hostURL, token } = this.getConfig();
    if (!hostURL || !token) {
      this.onStatus("offline");
      return;
    }

    this.onStatus("connecting");

    // RFC-029: trade the host token for a single-use ticket so the long-lived
    // token never appears in a WebSocket URL.
    let url;
    try {
      const base = String(hostURL).replace(/\/$/, "");
      const res = await fetch(`${base}/ws/ticket`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`ticket ${res.status}`);
      const { ticket } = await res.json();
      const u = new URL(hostURL);
      u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
      u.pathname = "/ws";
      u.search = `ticket=${encodeURIComponent(ticket)}`;
      url = u.toString();
    } catch {
      if (this.stopped || attempt !== this.attempt) return;
      this.onStatus("offline");
      this.scheduleReconnect();
      return;
    }
    // A newer connect() / stop() ran while we awaited the ticket.
    if (this.stopped || attempt !== this.attempt) return;

    const WS = globalThis.WebSocket;
    if (!WS) {
      console.warn("[host-ws] WebSocket unavailable");
      this.onStatus("offline");
      return;
    }

    const socket = new WS(url);
    this.ws = socket;

    socket.onopen = () => {
      this.backoffMs = 1000;
      this.onStatus("live");
    };

    socket.onclose = () => {
      this.ws = null;
      this.onStatus("offline");
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      /* onclose schedules reconnect */
    };

    socket.onmessage = (ev) => {
      this.handleMessage(String(ev.data || ""));
    };
  }

  scheduleReconnect() {
    if (this.stopped) return;
    this.clearReconnect();
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 1.6, 30_000);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    const event = msg?.kind === "event" ? msg.event : msg;
    if (!event || typeof event.type !== "string") return;

    if (this.onEvent) this.onEvent(event);

    const cfg = this.getConfig();
    if (cfg.notifications === false) return;

    const sessionId = event.sessionId;
    const payload = event.payload && typeof event.payload === "object" ? event.payload : {};

    switch (event.type) {
      case "approval.needed": {
        const title = payload.title || "Approval needed";
        const kind = payload.kind ? ` · ${payload.kind}` : "";
        const path = payload.locations && payload.locations[0]?.path ? ` · ${payload.locations[0].path}` : "";
        const detail = payload.detail ? ` · ${payload.detail}` : "";
        this.onNotify(
          "Approval needed",
          `${title}${kind}${path || detail}`,
          sessionId,
          { kind: "approval", approvalId: payload.id },
        );
        break;
      }
      case "question.needed": {
        this.onNotify("Agent question", payload.title || "Answer needed", sessionId, {
          kind: "question",
          questionId: payload.id,
        });
        break;
      }
      case "session.completed": {
        this.onNotify("Session completed", payload.title || "Done", sessionId, { kind: "completed" });
        break;
      }
      case "session.failed": {
        this.onNotify(
          "Session failed",
          String(payload.error || payload.message || "Failed"),
          sessionId,
          { kind: "failed" },
        );
        break;
      }
      default:
        break;
    }
  }
}

module.exports = { HostWsMonitor };
