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
   *   onNotify: (title: string, body: string, sessionId?: string) => void,
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

  connect() {
    if (this.stopped) return;
    this.clearReconnect();
    this.closeSocket();

    const { hostURL, token } = this.getConfig();
    if (!hostURL || !token) {
      this.onStatus("offline");
      return;
    }

    let url;
    try {
      const u = new URL(hostURL);
      u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
      u.pathname = "/ws";
      u.search = `token=${encodeURIComponent(token)}`;
      url = u.toString();
    } catch {
      this.onStatus("offline");
      return;
    }

    this.onStatus("connecting");

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
        const kind = payload.kind ? ` (${payload.kind})` : "";
        this.onNotify("Approval needed", `${title}${kind}`, sessionId);
        break;
      }
      case "question.needed": {
        this.onNotify("Agent questions", payload.title || "Answer needed", sessionId);
        break;
      }
      case "session.completed": {
        this.onNotify("Session completed", payload.title || "Done", sessionId);
        break;
      }
      case "session.failed": {
        this.onNotify("Session failed", String(payload.error || payload.message || "Failed"), sessionId);
        break;
      }
      default:
        break;
    }
  }
}

module.exports = { HostWsMonitor };
