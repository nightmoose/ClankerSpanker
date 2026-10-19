import type { IncomingHttpHeaders } from "node:http";
import { isLocalMachineAddr } from "./local-machine.js";

/**
 * Tailscale Serve listener (RFC-058 phase 2).
 *
 * `tailscale serve <serveBindPort>` terminates TLS on this node and proxies
 * tailnet requests to `http://127.0.0.1:<serveBindPort>`. The TCP peer is
 * tailscaled on loopback, so the peer address says nothing about who is
 * calling. What Serve does give us is `Tailscale-User-Login`, which it sets
 * for tailnet users and strips if the client sent it. Funnel traffic and
 * tagged nodes get no such header, so they fail closed here.
 *
 * Tailscale's guidance: only trust the header on a listener bound to
 * localhost. The serve listener is always 127.0.0.1.
 */
export const TAILSCALE_USER_LOGIN = "tailscale-user-login";

/** Address the serve listener binds. Never anything but loopback. */
export const SERVE_BIND_ADDRESS = "127.0.0.1";

/**
 * Routes the serve listener does not mount. They reveal the host token
 * (`/`, `/setup`, `/connect.json`) or finish an OAuth flow meant for this
 * machine's browser (`/mcp/oauth/callback`).
 */
const SERVE_UNMOUNTED_PATHS = new Set(["/", "/setup", "/connect.json", "/mcp/oauth/callback"]);

/** True when the request carries a `Tailscale-User-Login` header at all, even empty. */
export function hasTailscaleUserHeader(headers: IncomingHttpHeaders): boolean {
  return headers[TAILSCALE_USER_LOGIN] !== undefined;
}

/** The tailnet login Serve vouched for, or undefined when absent or blank. */
export function tailscaleUserLogin(headers: IncomingHttpHeaders): string | undefined {
  const v = headers[TAILSCALE_USER_LOGIN];
  const first = Array.isArray(v) ? v[0] : v;
  const login = first?.trim();
  return login ? login : undefined;
}

/**
 * "This machine" for admin gates (profile secrets, MCP OAuth, legacy
 * `?token=`). A loopback peer is not enough: if `Tailscale-User-Login` is
 * present, the request came through (or claims to come through) Serve, which
 * means a tailnet caller, not the host. Applies on every listener, so a
 * forged header on a direct `:8787` request only loses privileges.
 */
export function isLocalMachineRequest(req: {
  headers: IncomingHttpHeaders;
  socket: { remoteAddress?: string | null };
}): boolean {
  if (hasTailscaleUserHeader(req.headers)) return false;
  return isLocalMachineAddr(req.socket.remoteAddress);
}

export type ServeGateResult = { ok: true } | { ok: false; status: 403 | 404; message: string };

/**
 * Admission check for a request on the serve listener, before any routing.
 * No identity → 403 on every path, `/health` included. Unmounted path → 404.
 */
export function serveListenerGate(headers: IncomingHttpHeaders, path: string): ServeGateResult {
  if (!tailscaleUserLogin(headers)) {
    return {
      ok: false,
      status: 403,
      message:
        "This port only answers tailnet users through `tailscale serve`. Funnel and tagged nodes are not supported.",
    };
  }
  if (SERVE_UNMOUNTED_PATHS.has(normalizePath(path))) {
    return { ok: false, status: 404, message: "Not available through tailscale serve." };
  }
  return { ok: true };
}

/** Same trailing-slash folding `handleHttp` uses, so `/setup/` is `/setup`. */
function normalizePath(path: string): string {
  return path.replace(/\/+$/, "") || "/";
}

/**
 * `serveBindPort` from config.json: a TCP port, distinct from `bindPort`.
 * Anything else turns the serve listener off.
 */
export function normalizeServeBindPort(raw: unknown, bindPort: number): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 65535) {
    console.warn(`[config] serveBindPort ${JSON.stringify(raw)} is not a port; serve listener off`);
    return undefined;
  }
  if (n === bindPort) {
    console.warn(`[config] serveBindPort must differ from bindPort (${bindPort}); serve listener off`);
    return undefined;
  }
  return n;
}
