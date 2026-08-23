import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const KEYCHAIN_SERVICE = "gemini";
const KEYCHAIN_ACCOUNT = "antigravity";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REFRESH_SKEW_MS = 5 * 60_000;

/**
 * Installed-app OAuth clients baked into `agy`. Same public client IDs/secrets
 * the CLI uses to refresh the user's own Google token.
 */
const AGY_OAUTH_CLIENTS: Array<{ clientId: string; clientSecret: string }> = [
  {
    clientId: "884354919052-36trc1jjb3tguiac32ov6cod268c5blh.apps.googleusercontent.com",
    clientSecret: "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",
  },
  {
    clientId: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
    clientSecret: "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",
  },
];

export interface AgyOAuthCreds {
  accessToken: string;
  refreshToken?: string;
  expiryMs?: number;
  tokenType?: string;
  authMethod?: string;
  raw: Record<string, unknown>;
}

export function parseAgyCredsBlob(raw: string): AgyOAuthCreds | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let jsonText = trimmed;
  if (trimmed.startsWith("go-keyring-base64:")) {
    const b64 = trimmed.slice("go-keyring-base64:".length);
    try {
      jsonText = Buffer.from(b64, "base64").toString("utf8");
    } catch {
      return null;
    }
  }
  try {
    const obj = JSON.parse(jsonText) as Record<string, unknown>;
    const tokenObj =
      obj.token && typeof obj.token === "object"
        ? (obj.token as Record<string, unknown>)
        : obj;
    const access =
      (typeof tokenObj.access_token === "string" && tokenObj.access_token) ||
      (typeof tokenObj.accessToken === "string" && tokenObj.accessToken) ||
      "";
    if (!access.trim()) return null;
    const refresh =
      (typeof tokenObj.refresh_token === "string" && tokenObj.refresh_token) ||
      (typeof tokenObj.refreshToken === "string" && tokenObj.refreshToken) ||
      undefined;
    const expiryRaw = tokenObj.expiry ?? tokenObj.expiry_date ?? tokenObj.expires_at;
    let expiryMs: number | undefined;
    if (typeof expiryRaw === "number") {
      expiryMs = expiryRaw < 1e12 ? expiryRaw * 1000 : expiryRaw;
    } else if (typeof expiryRaw === "string") {
      const t = Date.parse(expiryRaw);
      if (Number.isFinite(t)) expiryMs = t;
    }
    return {
      accessToken: access.trim(),
      refreshToken: refresh?.trim(),
      expiryMs,
      tokenType: typeof tokenObj.token_type === "string" ? tokenObj.token_type : undefined,
      authMethod: typeof obj.auth_method === "string" ? obj.auth_method : undefined,
      raw: obj,
    };
  } catch {
    return null;
  }
}

export function encodeAgyCredsBlob(creds: AgyOAuthCreds): string {
  const token = {
    ...((creds.raw.token && typeof creds.raw.token === "object"
      ? creds.raw.token
      : {}) as Record<string, unknown>),
    access_token: creds.accessToken,
    token_type: creds.tokenType || "Bearer",
    refresh_token: creds.refreshToken,
    expiry: creds.expiryMs ? new Date(creds.expiryMs).toISOString() : undefined,
  };
  const payload = {
    ...creds.raw,
    token,
    auth_method: creds.authMethod ?? creds.raw.auth_method ?? "consumer",
  };
  return "go-keyring-base64:" + Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

async function readKeychainBlob(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  try {
    const { stdout } = await execFileAsync(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
      { timeout: 4000, maxBuffer: 256_000 },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function writeKeychainBlob(blob: string): Promise<void> {
  if (process.platform !== "darwin") return;
  try {
    await execFileAsync(
      "security",
      ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT],
      { timeout: 4000 },
    ).catch(() => undefined);
    await execFileAsync(
      "security",
      ["add-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w", blob],
      { timeout: 4000 },
    );
  } catch {
    /* best-effort */
  }
}

function readFileCreds(): AgyOAuthCreds | null {
  const candidates = [
    join(homedir(), ".gemini", "oauth_creds.json"),
    join(homedir(), ".gemini", "antigravity-cli", "oauth_creds.json"),
    join(homedir(), ".config", "gemini", "oauth_creds.json"),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const parsed = parseAgyCredsBlob(readFileSync(p, "utf8"));
      if (parsed) return parsed;
    } catch {
      /* ignore */
    }
  }
  return null;
}

export async function readAgyOAuthCreds(): Promise<AgyOAuthCreds | null> {
  const blob = await readKeychainBlob();
  if (blob) {
    const parsed = parseAgyCredsBlob(blob);
    if (parsed) return parsed;
  }
  return readFileCreds();
}

async function refreshAgyCreds(creds: AgyOAuthCreds): Promise<AgyOAuthCreds | null> {
  if (!creds.refreshToken) return null;
  for (const client of AGY_OAUTH_CLIENTS) {
    try {
      const body = new URLSearchParams({
        client_id: client.clientId,
        client_secret: client.clientSecret,
        refresh_token: creds.refreshToken,
        grant_type: "refresh_token",
      });
      const res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      if (!res.ok) continue;
      const data = (await res.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        token_type?: string;
      };
      if (!data.access_token) continue;
      const next: AgyOAuthCreds = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token || creds.refreshToken,
        expiryMs: Date.now() + (data.expires_in ?? 3600) * 1000,
        tokenType: data.token_type || "Bearer",
        authMethod: creds.authMethod,
        raw: creds.raw,
      };
      await writeKeychainBlob(encodeAgyCredsBlob(next));
      return next;
    } catch {
      /* try next client */
    }
  }
  return null;
}

/** Access token from `agy` / Gemini CLI login, refreshed if near expiry. */
export async function getAgyAccessToken(): Promise<string | null> {
  let creds = await readAgyOAuthCreds();
  if (!creds) return null;
  const exp = creds.expiryMs;
  if (!exp || exp < Date.now() + REFRESH_SKEW_MS) {
    creds = (await refreshAgyCreds(creds)) ?? creds;
  }
  return creds.accessToken?.trim() || null;
}
