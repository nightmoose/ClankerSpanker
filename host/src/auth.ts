import type { IncomingMessage } from "node:http";
import type { HostConfigFile } from "./types.js";

export function extractBearer(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m?.[1]?.trim() ?? null;
}

export function isAuthorized(req: IncomingMessage, config: HostConfigFile): boolean {
  // Allow unauthenticated health checks only — enforced at route level.
  const token = extractBearer(req);
  if (!token) {
    // Also accept X-Grok-Dispatch-Token header (handy for WS clients)
    const alt = req.headers["x-grok-dispatch-token"];
    if (typeof alt === "string" && alt === config.hostToken) return true;
    return false;
  }
  return token === config.hostToken;
}

export function unauthorizedBody(): string {
  return JSON.stringify({ error: "Unauthorized", message: "Valid Bearer host token required" });
}
