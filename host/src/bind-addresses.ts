import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { isTailscaleAddr } from "./platform.js";

/**
 * Where the host listens (RFC-028).
 *
 * `bindHost` values:
 *  - `"auto"` (default for new installs): loopback (IPv4 + IPv6) plus every
 *    Tailscale address this machine currently has. Phones and other laptops
 *    reach the host over Tailscale; nothing on the café / hotel / home Wi-Fi
 *    can connect at all.
 *  - `"0.0.0.0"` / `"::"`: every interface (the pre-RFC-028 default). Still
 *    honored, with a startup warning.
 *  - any other value: one address, or a comma-separated list.
 */
export const AUTO_BIND = "auto";

export function isAutoBind(bindHost: string | undefined): boolean {
  return (bindHost ?? "").trim().toLowerCase() === AUTO_BIND;
}

export function isWildcardBind(bindHost: string | undefined): boolean {
  const b = (bindHost ?? "").trim();
  return b === "0.0.0.0" || b === "::" || b === "";
}

type Nets = NodeJS.Dict<NetworkInterfaceInfo[]>;

/** Tailscale IPv6 ULA block (fd7a:115c:a1e0::/48). */
function isTailscaleV6(addr: string): boolean {
  return addr.toLowerCase().startsWith("fd7a:115c:a1e0:");
}

export function tailscaleAddresses(nets: Nets = networkInterfaces()): string[] {
  const out: string[] = [];
  for (const list of Object.values(nets)) {
    for (const n of list ?? []) {
      if (n.internal) continue;
      const fam = n.family as unknown;
      const v4 = fam === "IPv4" || fam === 4;
      if (v4 && isTailscaleAddr(n.address)) out.push(n.address);
      else if (!v4 && isTailscaleV6(n.address)) out.push(n.address);
    }
  }
  return [...new Set(out)];
}

/** Addresses to listen on for a `bindHost` value, in a stable order. */
export function resolveBindAddresses(bindHost: string | undefined, nets: Nets = networkInterfaces()): string[] {
  if (isAutoBind(bindHost)) {
    return ["127.0.0.1", "::1", ...tailscaleAddresses(nets)];
  }
  if (isWildcardBind(bindHost)) return ["0.0.0.0"];
  const parts = (bindHost ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set(parts)];
}

/** `::1` → `[::1]` for URLs and log lines. */
export function formatAddr(addr: string): string {
  return addr.includes(":") ? `[${addr}]` : addr;
}
