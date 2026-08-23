import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TOKEN_URL = "https://auth.x.ai/oauth2/token";
const REFRESH_SKEW_MS = 5 * 60_000;

export interface GrokCliCreds {
  path: string;
  accountKey: string;
  file: Record<string, unknown>;
  entry: Record<string, unknown>;
  accessToken: string;
  refreshToken?: string;
  clientId?: string;
  expiresAtMs?: number;
}

function authPaths(paths?: string[]): string[] {
  return (
    paths ?? [
      process.env.GROK_HOME?.trim()
        ? join(process.env.GROK_HOME.trim(), "auth.json")
        : join(homedir(), ".grok", "auth.json"),
      join(homedir(), ".config", "grok", "auth.json"),
    ]
  );
}

function parseExpiresAt(raw: unknown, jwt: string): number | undefined {
  if (typeof raw === "string") {
    const t = Date.parse(raw);
    if (Number.isFinite(t)) return t;
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw < 1e12 ? raw * 1000 : raw;
  }
  const parts = jwt.split(".");
  if (parts.length >= 2) {
    try {
      const payload = JSON.parse(Buffer.from(padB64(parts[1]!), "base64").toString("utf8")) as {
        exp?: number;
      };
      if (typeof payload.exp === "number") return payload.exp * 1000;
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

function padB64(s: string): string {
  return s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
}

export function readGrokCliCreds(paths?: string[]): GrokCliCreds | null {
  for (const path of authPaths(paths)) {
    if (!existsSync(path)) continue;
    try {
      const file = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      for (const [accountKey, v] of Object.entries(file)) {
        if (!v || typeof v !== "object") continue;
        const entry = v as Record<string, unknown>;
        const key = typeof entry.key === "string" ? entry.key.trim() : "";
        if (!key) continue;
        const refresh =
          typeof entry.refresh_token === "string" ? entry.refresh_token.trim() : undefined;
        const clientId =
          typeof entry.oidc_client_id === "string" ? entry.oidc_client_id.trim() : undefined;
        return {
          path,
          accountKey,
          file,
          entry,
          accessToken: key,
          refreshToken: refresh,
          clientId,
          expiresAtMs: parseExpiresAt(entry.expires_at, key),
        };
      }
    } catch {
      /* ignore malformed */
    }
  }
  return null;
}

/**
 * Grok CLI login (`grok` sign-in) stores an OIDC access token in
 * ~/.grok/auth.json as `key`. The hunter HTTP loop reuses that Bearer
 * against api.x.ai. The CLI refreshes on its own; we must too — a live
 * ACP session does not mean `key` is still valid.
 */
export function readGrokCliAccessToken(paths?: string[]): string | null {
  return readGrokCliCreds(paths)?.accessToken ?? null;
}

function persistCreds(creds: GrokCliCreds, next: { accessToken: string; refreshToken?: string; expiresAtMs?: number }): void {
  const entry = {
    ...creds.entry,
    key: next.accessToken,
    refresh_token: next.refreshToken ?? creds.refreshToken,
    expires_at: next.expiresAtMs ? new Date(next.expiresAtMs).toISOString() : creds.entry.expires_at,
  };
  const file = { ...creds.file, [creds.accountKey]: entry };
  writeFileSync(creds.path, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
}

export async function refreshGrokCliCreds(
  creds: GrokCliCreds,
  fetchImpl: typeof fetch = fetch,
): Promise<GrokCliCreds | null> {
  if (!creds.refreshToken || !creds.clientId) return null;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: creds.refreshToken,
    client_id: creds.clientId,
  });
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!data.access_token) return null;
  const expiresAtMs = Date.now() + (data.expires_in ?? 6 * 3600) * 1000;
  persistCreds(creds, {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || creds.refreshToken,
    expiresAtMs,
  });
  return {
    ...creds,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || creds.refreshToken,
    expiresAtMs,
    entry: { ...creds.entry, key: data.access_token },
  };
}

/** Access token, refreshed if expired or within 5 minutes of expiry. */
export async function getGrokCliAccessToken(
  paths?: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  let creds = readGrokCliCreds(paths);
  if (!creds) return null;
  const exp = creds.expiresAtMs;
  if (!exp || exp < Date.now() + REFRESH_SKEW_MS) {
    creds = (await refreshGrokCliCreds(creds, fetchImpl)) ?? creds;
  }
  return creds.accessToken;
}
