import type { IncomingMessage } from "node:http";
import { hostname as osHostname } from "node:os";
import { isLocalMachineAddr, localMachineAddresses } from "./local-machine.js";
import { hasTailscaleUserHeader } from "./tailscale-serve.js";

/**
 * Token-less pages that reveal the host token (`/setup`, `/connect.json`)
 * must only answer a browser or app running ON this machine (RFC-026).
 *
 * A locality check on the TCP peer is not enough by itself: a web page open
 * in the local browser also connects from loopback. So we also require:
 *  - the Host header to name this machine (defeats DNS rebinding, where
 *    `evil.example` is re-pointed at 127.0.0.1 and becomes "same-origin");
 *  - no cross-site fetch metadata, and no foreign Origin;
 *  - no `Tailscale-User-Login`: that header means a tailnet caller came in
 *    through `tailscale serve`, whose TCP peer is loopback (RFC-058 phase 2).
 */
export function isTrustedLocalPageRequest(
  req: Pick<IncomingMessage, "headers"> & { socket: { remoteAddress?: string | null } },
  names: Set<string> = localHostNames(),
): boolean {
  if (!isLocalMachineAddr(req.socket.remoteAddress)) return false;
  if (hasTailscaleUserHeader(req.headers)) return false;

  const hostHeader = firstHeader(req.headers.host);
  if (!hostHeader) return false;
  const hostName = stripPort(hostHeader).toLowerCase();
  if (!names.has(hostName)) return false;

  const site = firstHeader(req.headers["sec-fetch-site"])?.toLowerCase();
  if (site && site !== "same-origin" && site !== "none") return false;

  const origin = firstHeader(req.headers.origin);
  if (origin && origin.toLowerCase() !== `http://${hostHeader.toLowerCase()}`) return false;

  return true;
}

/** Names a legitimate local request may use in its Host header. */
export function localHostNames(): Set<string> {
  const names = new Set<string>(["localhost", "127.0.0.1", "::1"]);
  for (const a of localMachineAddresses()) {
    if (!a.startsWith("::ffff:")) names.add(a.toLowerCase());
  }
  const h = osHostname().toLowerCase();
  if (h) {
    names.add(h);
    const short = h.replace(/\.local$/, "");
    names.add(short);
    names.add(`${short}.local`);
  }
  return names;
}

/** `[::1]:8787` → `::1`, `localhost:8787` → `localhost`. */
export function stripPort(host: string): string {
  const h = host.trim();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end > 0 ? h.slice(1, end) : h;
  }
  const colons = h.split(":").length - 1;
  if (colons === 1) return h.slice(0, h.indexOf(":"));
  return h;
}

function firstHeader(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

/**
 * Routes that answer without the host token. They must never carry
 * `Access-Control-Allow-Origin` — a cross-origin page could otherwise read
 * them.
 */
const NO_CORS_PATHS = new Set(["/", "/setup", "/connect.json", "/mcp/oauth/callback"]);

export function corsAllowedFor(path: string): boolean {
  return !NO_CORS_PATHS.has(path);
}

/**
 * The only website origin allowed to read the gateway.
 * Keep this in sync with `host/web/gateway-client.js`.
 */
export const HOSTED_PRODUCT_ORIGIN = "https://clankerspanker.tech";

const CORS_ALLOW_HEADERS =
  "Authorization, Content-Type, X-ClankerSpanker-Token, X-Grok-Dispatch-Token";
const CORS_ALLOW_METHODS = "GET, POST, PATCH, DELETE, OPTIONS";

export type CorsHeaderMap = Record<string, string>;

/**
 * CORS for token routes (phase 1 of the hosted product site).
 *
 * `https://clankerspanker.tech` is the only website origin that may read the
 * gateway. Responses to that origin reflect it (not `*`) and opt in to
 * Private Network Access, so Chrome can finish the loopback preflight from
 * the public page (`Access-Control-Request-Private-Network: true` →
 * `Access-Control-Allow-Private-Network: true`).
 *
 * A request with no website origin — the Electron renderer sends `Origin:
 * null` from `file://`, and native clients send nothing — still gets
 * `Access-Control-Allow-Origin: *`. That wildcard is not a private-network
 * opt-in. Any other website origin, including preview deploys, gets no CORS
 * headers, so the browser cannot read the response.
 */
export function corsHeadersFor(path: string, origin: string | undefined): CorsHeaderMap | null {
  if (!corsAllowedFor(path)) return null;
  if (normalizeOrigin(origin) === HOSTED_PRODUCT_ORIGIN) {
    return {
      "Access-Control-Allow-Origin": HOSTED_PRODUCT_ORIGIN,
      Vary: "Origin",
      "Access-Control-Allow-Headers": CORS_ALLOW_HEADERS,
      "Access-Control-Allow-Methods": CORS_ALLOW_METHODS,
      "Access-Control-Allow-Private-Network": "true",
    };
  }
  if (origin === undefined || origin === "" || origin === "null") {
    return {
      "Access-Control-Allow-Origin": "*",
      Vary: "Origin",
      "Access-Control-Allow-Headers": CORS_ALLOW_HEADERS,
      "Access-Control-Allow-Methods": CORS_ALLOW_METHODS,
    };
  }
  return null;
}

function normalizeOrigin(origin: string | undefined): string {
  return (origin ?? "").trim().toLowerCase();
}
