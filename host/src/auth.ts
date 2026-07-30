import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { HostConfigFile } from "./types.js";

export function extractBearer(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m?.[1]?.trim() ?? null;
}

/**
 * Constant-time token comparison.
 *
 * `===` on a secret short-circuits at the first differing byte, leaking the
 * token's length and prefix through response timing. `timingSafeEqual` throws
 * on length mismatch, which would leak length by itself, so unequal lengths are
 * rejected up front — that tells an attacker only what they already know from
 * the request they sent.
 *
 * An empty configured token must never authorise anyone: an unconfigured host
 * would otherwise accept an empty credential as valid.
 */
export function tokensMatch(supplied: string | undefined | null, expected: string | undefined | null): boolean {
  if (!supplied || !expected) return false;
  const a = Buffer.from(supplied, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function isAuthorized(req: IncomingMessage, config: HostConfigFile): boolean {
  // Allow unauthenticated health checks only — enforced at route level.
  const token = extractBearer(req);
  if (token) return tokensMatch(token, config.hostToken);

  // Also accept X-Grok-Dispatch-Token (handy for WS clients, which cannot set
  // arbitrary headers in a browser). Named for the old product name; renaming
  // it breaks every client already holding a token, so it stays for now.
  const alt = req.headers["x-grok-dispatch-token"];
  if (typeof alt === "string") return tokensMatch(alt, config.hostToken);
  return false;
}

export function unauthorizedBody(): string {
  return JSON.stringify({ error: "Unauthorized", message: "Valid Bearer host token required" });
}
