import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentProfile, DispatchSession, ProfileUsage, PublicAgentProfile } from "./types.js";
import { profileHasCredentials } from "./profiles.js";
import { getAgyAccessToken } from "./bot/gemini-cli-auth.js";
import {
  getGrokCliAccessToken,
  grokAuthJsonPathsForProfile,
  readGrokCliCreds,
} from "./bot/grok-cli-auth.js";

const execFileAsync = promisify(execFile);

/** Claude Code public OAuth client (same as the CLI). */
const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";

/**
 * Success TTL. Anthropic rate-limits /api/oauth/usage aggressively when polled
 * too often; community tools use ~3 min.
 */
const CACHE_TTL_MS = 90_000;
const STALE_OK_MS = 15 * 60_000;
const BACKOFF_429_MS = 4 * 60_000;
/** Refresh access token this many ms before expiresAt. */
const REFRESH_SKEW_MS = 5 * 60_000;

interface CacheEntry {
  at: number;
  usage: ProfileUsage;
  backoffUntil?: number;
  lastGood?: ProfileUsage;
}

const usageCache = new Map<string, CacheEntry>();
let cachedClaudeUa: string | null = null;

interface OAuthBucket {
  utilization?: number | null;
  resets_at?: string | null;
}

interface OAuthLimitRow {
  kind?: string | null;
  percent?: number | null;
  is_active?: boolean | null;
  resets_at?: string | null;
}

export interface OAuthUsageResponse {
  five_hour?: OAuthBucket | null;
  seven_day?: OAuthBucket | null;
  seven_day_opus?: OAuthBucket | null;
  seven_day_sonnet?: OAuthBucket | null;
  limits?: OAuthLimitRow[] | null;
}

interface ClaudeOAuthCreds {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
  /** true when stored under { claudeAiOauth: {...} } */
  nested: boolean;
  /** raw object for keychain rewrite */
  raw: Record<string, unknown>;
  keychainAccount?: string;
}

/**
 * Attach live usage (Claude OAuth 5h/weekly windows) to public profiles.
 */
export async function profilesWithUsage(
  profiles: PublicAgentProfile[],
  full: AgentProfile[],
  opts?: { sessions?: DispatchSession[]; dataDir?: string },
): Promise<PublicAgentProfile[]> {
  const sessions = opts?.sessions ?? [];
  const dataDir = opts?.dataDir;
  return Promise.all(
    profiles.map(async (pub) => {
      const fullProfile = full.find((p) => p.id === pub.id);
      if (!fullProfile) return pub;
      const usage = await usageForProfile(fullProfile, sessions, dataDir);
      return { ...pub, usage };
    }),
  );
}

export async function usageForProfile(
  profile: AgentProfile,
  sessions: DispatchSession[] = [],
  dataDir?: string,
): Promise<ProfileUsage> {
  const cacheKey = `${profile.id}:${profile.backend}:${profile.claudeConfigDir ?? ""}`;
  const hit = usageCache.get(cacheKey);
  const now = Date.now();

  if (hit) {
    if (hit.backoffUntil && now < hit.backoffUntil) {
      return hit.lastGood ?? hit.usage;
    }
    if (now - hit.at < CACHE_TTL_MS) return hit.usage;
  }

  let usage: ProfileUsage;
  try {
    if (profile.backend === "claude") {
      usage = await claudeUsage(profile, hit?.lastGood);
    } else if (profile.backend === "antigravity") {
      usage = await antigravityUsage(profile);
    } else if (profile.backend === "bot") {
      usage = {
        status: "api_key",
        label: "Bot (HTTP)",
        canWork: true,
        fetchedAt: new Date().toISOString(),
      };
    } else {
      usage = await grokUsage(profile, sessions, dataDir);
    }
  } catch (err) {
    if (hit?.lastGood && now - hit.at < STALE_OK_MS) {
      return withCachedSuffix(hit.lastGood);
    }
    usage = {
      status: "error",
      label: "Usage error",
      error: err instanceof Error ? err.message : String(err),
      fetchedAt: new Date().toISOString(),
    };
  }

  const prev = usageCache.get(cacheKey);
  const lastGood =
    usage.status === "ok" || usage.status === "limited" || usage.status === "api_key"
      ? usage
      : prev?.lastGood;

  const backoffUntil =
    usage.status === "error" &&
    (usage.label?.includes("429") || usage.label?.includes("unavailable"))
      ? now + BACKOFF_429_MS
      : undefined;

  usageCache.set(cacheKey, { at: now, usage, lastGood, backoffUntil });
  return usage;
}

function withCachedSuffix(u: ProfileUsage): ProfileUsage {
  const base = u.label?.replace(/\s*\(cached\)\s*$/i, "") ?? "Usage ok";
  return { ...u, label: `${base} (cached)` };
}

/**
 * Grok has no Claude-style 5h/weekly OAuth quota API.
 * Do NOT surface minute-window TPM/RPM as "0%" chips — that lied about capacity.
 *
 * Instead: auth readiness + local host activity for this profile (sessions/tools today).
 */
/**
 * Grok weekly plan credits — same class of signal as Claude's weekly %.
 * Source: cli-chat-proxy.grok.com/v1/billing?format=credits
 * (what the Grok CLI `/usage` command uses).
 *
 * creditUsagePercent = % of weekly credits used (0–100).
 * productUsage GrokBuild = coding share of that plan.
 */
async function grokUsage(
  profile: AgentProfile,
  _sessions: DispatchSession[] = [],
  dataDir?: string,
): Promise<ProfileUsage> {
  const fetchedAt = new Date().toISOString();
  const paths = grokAuthJsonPathsForProfile(profile, dataDir);
  const creds = readGrokCliCreds(paths);
  const accessToken = await getGrokCliAccessToken(paths);
  const email =
    typeof creds?.entry.email === "string" ? creds.entry.email.trim() : undefined;
  if (!accessToken) {
    const ok = profileHasCredentials(profile);
    return {
      status: ok ? "ok" : "unknown",
      label: ok ? "Grok signed in" : "Grok not signed in",
      canWork: ok,
      fetchedAt,
    };
  }

  try {
    const res = await fetch(
      "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          "User-Agent": "clankerspanker-host/0.6",
        },
      },
    );

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        return {
          status: "error",
          label: "Grok re-login needed",
          accountEmail: email,
          canWork: false,
          error: `billing HTTP ${res.status}`,
          fetchedAt,
        };
      }
      const body = await res.text().catch(() => "");
      return {
        status: "error",
        label: `Grok usage HTTP ${res.status}`,
        accountEmail: email,
        canWork: true,
        error: body.slice(0, 200),
        fetchedAt,
      };
    }

    const data = (await res.json()) as GrokCreditsResponse;
    const cfg = data.config ?? data;
    const weekUsed = clampPct(cfg.creditUsagePercent);
    const periodEnd =
      cfg.currentPeriod?.end ?? cfg.billingPeriodEnd ?? undefined;
    const buildUsed = productUsagePercent(cfg.productUsage, "GrokBuild");
    const chatUsed = productUsagePercent(cfg.productUsage, "GrokChat");

    // Peak for chip: weekly plan is the binding "run out this week" number
    const peak = weekUsed ?? buildUsed ?? chatUsed ?? 0;
    const limited = peak >= 95;
    // Chip uses peakUsedPercent = max(windows). Prefer weekly as primary;
    // map weekly into both fields so peak == week used % (consistent with "used %").
    return {
      status: limited ? "limited" : "ok",
      fiveHourPercent: weekUsed ?? buildUsed ?? undefined,
      fiveHourResetsAt: periodEnd,
      sevenDayPercent: weekUsed ?? undefined,
      sevenDayResetsAt: periodEnd,
      label: weekUsed != null ? `${Math.round(weekUsed)}%` : "Grok ready",
      accountEmail: email,
      canWork: !limited,
      fetchedAt,
    };
  } catch (err) {
    return {
      status: "error",
      label: "Grok usage error",
      accountEmail: email,
      canWork: true,
      error: err instanceof Error ? err.message : String(err),
      fetchedAt,
    };
  }
}

interface GrokCreditsResponse {
  config?: GrokCreditsConfig;
  creditUsagePercent?: number;
  currentPeriod?: { type?: string; start?: string; end?: string };
  billingPeriodEnd?: string;
  productUsage?: Array<{ product?: string; usagePercent?: number }>;
}

interface GrokCreditsConfig {
  creditUsagePercent?: number;
  currentPeriod?: { type?: string; start?: string; end?: string };
  billingPeriodStart?: string;
  billingPeriodEnd?: string;
  productUsage?: Array<{ product?: string; usagePercent?: number }>;
}

function productUsagePercent(
  products: Array<{ product?: string; usagePercent?: number }> | undefined,
  name: string,
): number | null {
  if (!products?.length) return null;
  const hit = products.find(
    (p) => (p.product ?? "").toLowerCase() === name.toLowerCase(),
  );
  return clampPct(hit?.usagePercent);
}

/**
 * Gemini / Antigravity quota via Google Cloud Code Assist (same unofficial
 * surface Gemini CLI / community quota tools use). `agy` has no public
 * `/usage` HTTP API — this is the closest signal we can get from the
 * consumer OAuth token already on the Mac.
 */
async function antigravityUsage(profile: AgentProfile): Promise<ProfileUsage> {
  const fetchedAt = new Date().toISOString();
  const apiKey =
    profile.env?.GEMINI_API_KEY?.trim() ||
    profile.env?.GOOGLE_API_KEY?.trim() ||
    profile.env?.GOOGLE_GENAI_API_KEY?.trim() ||
    process.env.GEMINI_API_KEY?.trim() ||
    process.env.GOOGLE_API_KEY?.trim();

  const token = await getAgyAccessToken();
  if (!token) {
    if (apiKey) {
      return {
        status: "api_key",
        label: "API key (no quota %)",
        canWork: true,
        fetchedAt,
      };
    }
    const ok = profileHasCredentials(profile);
    return {
      status: ok ? "ok" : "unknown",
      label: ok ? "Gemini ready" : "Gemini not signed in",
      canWork: ok,
      fetchedAt,
    };
  }

  try {
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "antigravity",
    };
    const loadRes = await fetch("https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", {
      method: "POST",
      headers,
      body: JSON.stringify({
        metadata: { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" },
      }),
    });
    if (loadRes.status === 401 || loadRes.status === 403) {
      return {
        status: "error",
        label: "Gemini re-login needed",
        canWork: false,
        error: `loadCodeAssist HTTP ${loadRes.status}`,
        fetchedAt,
      };
    }
    if (!loadRes.ok) {
      throw new Error(`loadCodeAssist HTTP ${loadRes.status}`);
    }
    const loadJson = (await loadRes.json()) as {
      cloudaicompanionProject?: string | { id?: string };
      currentTier?: { id?: string; name?: string };
      paidTier?: { name?: string };
    };
    const project =
      typeof loadJson.cloudaicompanionProject === "string"
        ? loadJson.cloudaicompanionProject
        : loadJson.cloudaicompanionProject?.id;
    const modelsRes = await fetch("https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels", {
      method: "POST",
      headers,
      body: JSON.stringify(project ? { project } : {}),
    });
    if (!modelsRes.ok) {
      throw new Error(`fetchAvailableModels HTTP ${modelsRes.status}`);
    }
    const modelsJson = (await modelsRes.json()) as {
      models?: Record<string, { quotaInfo?: AgyQuotaInfo; displayName?: string }>;
    };
    const email = await googleUserEmail(token);
    const plan = loadJson.currentTier?.id === "free-tier" ? "free" : undefined;
    return profileUsageFromAgyModels(modelsJson.models ?? {}, {
      planName: plan,
      accountEmail: email,
      fetchedAt,
    });
  } catch (err) {
    const ok = profileHasCredentials(profile);
    return {
      status: ok ? "ok" : "error",
      label: ok ? "Gemini ready" : "Gemini usage error",
      canWork: ok,
      error: err instanceof Error ? err.message : String(err),
      fetchedAt,
    };
  }
}

export interface AgyQuotaInfo {
  remainingFraction?: number;
  resetTime?: string;
  isExhausted?: boolean;
}

/** Pure mapper — remainingFraction 0.96 → ~4% used. */
export function profileUsageFromAgyModels(
  models: Record<string, { quotaInfo?: AgyQuotaInfo; displayName?: string }>,
  opts: { planName?: string; accountEmail?: string; fetchedAt: string },
): ProfileUsage {
  const used: Array<{ pct: number; reset?: string }> = [];
  for (const [id, m] of Object.entries(models)) {
    if (/^(tab_|chat_)/i.test(id)) continue;
    const q = m.quotaInfo;
    if (!q) continue;
    if (q.isExhausted) {
      used.push({ pct: 100, reset: q.resetTime });
      continue;
    }
    if (typeof q.remainingFraction === "number" && Number.isFinite(q.remainingFraction)) {
      const remaining = q.remainingFraction > 0 && q.remainingFraction <= 1 ? q.remainingFraction : q.remainingFraction / 100;
      const pct = clampPct((1 - remaining) * 100);
      if (pct != null) used.push({ pct, reset: q.resetTime });
    }
  }
  const peak = used.length ? Math.max(...used.map((u) => u.pct)) : null;
  const reset = used.find((u) => u.pct === peak)?.reset;
  const limited = peak != null && peak >= 95;
  const planBit = opts.planName?.toLowerCase().includes("free") ? "free" : opts.planName;
  const label =
    peak != null
      ? `${Math.round(peak)}%${planBit && planBit !== "Antigravity" ? ` · ${planBit}` : ""}`
      : "Gemini ready";
  return {
    status: limited ? "limited" : "ok",
    fiveHourPercent: peak ?? undefined,
    fiveHourResetsAt: reset,
    label,
    accountEmail: opts.accountEmail,
    canWork: !limited,
    fetchedAt: opts.fetchedAt,
  };
}

async function googleUserEmail(accessToken: string): Promise<string | undefined> {
  try {
    const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { email?: string };
    return data.email?.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function claudeUsage(
  profile: AgentProfile,
  lastGood?: ProfileUsage,
): Promise<ProfileUsage> {
  const fetchedAt = new Date().toISOString();
  const fileEmail = readClaudeAccountEmail(profile);

  const apiKey =
    profile.env?.ANTHROPIC_API_KEY?.trim() ||
    profile.env?.ANTHROPIC_AUTH_TOKEN?.trim() ||
    (!profile.claudeConfigDir
      ? process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN
      : undefined);

  let creds = await readClaudeOAuthCreds(profile);
  if (!creds) {
    if (apiKey) {
      return {
        status: "api_key",
        label: "API key (no quota %)",
        accountEmail: fileEmail,
        canWork: true,
        fetchedAt,
      };
    }
    return {
      status: "unknown",
      label: "Not signed in — run claude login on host",
      accountEmail: fileEmail,
      canWork: false,
      fetchedAt,
    };
  }

  // Proactively refresh near/after expiry so usage + dispatch stay valid.
  creds = (await maybeRefreshCreds(profile, creds)) ?? creds;

  const ua = await claudeCodeUserAgent();
  let res = await fetchOAuthUsage(creds.accessToken, ua);

  // One retry after refresh on 401 (token revoked mid-flight / stale keychain).
  if (res.status === 401 && creds.refreshToken) {
    const refreshed = await refreshAndPersist(profile, creds);
    if (refreshed) {
      creds = refreshed;
      res = await fetchOAuthUsage(creds.accessToken, ua);
    }
  }

  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, 1500));
    res = await fetchOAuthUsage(creds.accessToken, ua);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 429 && lastGood) {
      return withCachedSuffix({ ...lastGood, accountEmail: lastGood.accountEmail ?? fileEmail });
    }
    if (res.status === 401 || res.status === 403) {
      return {
        status: "error",
        label: "Re-login on host",
        accountEmail: fileEmail,
        canWork: false,
        error: body.slice(0, 200),
        fetchedAt,
      };
    }
    return {
      status: "error",
      label: res.status === 429 ? "Usage temporarily unavailable" : `Usage HTTP ${res.status}`,
      accountEmail: fileEmail,
      canWork: true,
      error: body.slice(0, 200),
      fetchedAt,
    };
  }

  const data = (await res.json()) as OAuthUsageResponse;
  // Prefer file email (matches profile config dir); token is for that login when isolated.
  return profileUsageFromOAuth(data, fileEmail, fetchedAt);
}

async function fetchOAuthUsage(accessToken: string, ua: string): Promise<Response> {
  return fetch("https://api.anthropic.com/api/oauth/usage", {
    method: "GET",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
      // Required: non-claude-code UAs hit an aggressive 429 bucket.
      "User-Agent": ua,
    },
  });
}

async function maybeRefreshCreds(
  profile: AgentProfile,
  creds: ClaudeOAuthCreds,
): Promise<ClaudeOAuthCreds | null> {
  if (!creds.refreshToken) return null;
  const exp = creds.expiresAt;
  if (exp && exp > Date.now() + REFRESH_SKEW_MS) return null;
  return refreshAndPersist(profile, creds);
}

async function refreshAndPersist(
  profile: AgentProfile,
  creds: ClaudeOAuthCreds,
): Promise<ClaudeOAuthCreds | null> {
  if (!creds.refreshToken) return null;
  try {
    const res = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": await claudeCodeUserAgent(),
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: creds.refreshToken,
        client_id: CLAUDE_OAUTH_CLIENT_ID,
      }),
    });
    if (!res.ok) {
      // Do not log tokens. Leave keychain alone on failed refresh.
      return null;
    }
    const data = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      account?: { email_address?: string };
    };
    if (!data.access_token) return null;

    const expiresAt = Date.now() + (data.expires_in ?? 28_800) * 1000;
    const next: ClaudeOAuthCreds = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || creds.refreshToken,
      expiresAt,
      scopes: data.scope?.split(/\s+/).filter(Boolean) ?? creds.scopes,
      subscriptionType: creds.subscriptionType,
      rateLimitTier: creds.rateLimitTier,
      nested: creds.nested,
      raw: creds.raw,
      keychainAccount: creds.keychainAccount,
    };

    await writeClaudeOAuthCreds(profile, next);
    return next;
  } catch {
    return null;
  }
}

/** Pure mapper — exported for unit tests. */
export function profileUsageFromOAuth(
  data: OAuthUsageResponse,
  accountEmail: string | undefined,
  fetchedAt: string,
): ProfileUsage {
  const five = data.five_hour;
  const seven = data.seven_day;
  const opus = data.seven_day_opus;

  let fivePct = clampPct(five?.utilization);
  let sevenPct = clampPct(seven?.utilization);
  const opusPct = clampPct(opus?.utilization);
  let fiveResets = five?.resets_at ?? undefined;
  let sevenResets = seven?.resets_at ?? undefined;

  if (data.limits?.length) {
    for (const row of data.limits) {
      if (row.kind === "session" && fivePct == null) {
        fivePct = clampPct(row.percent);
        fiveResets = row.resets_at ?? fiveResets;
      }
      if (row.kind === "weekly_all" && sevenPct == null) {
        sevenPct = clampPct(row.percent);
        sevenResets = row.resets_at ?? sevenResets;
      }
    }
  }

  const maxUsed = Math.max(fivePct ?? 0, sevenPct ?? 0, opusPct ?? 0);
  const limited = maxUsed >= 95;

  const parts: string[] = [];
  if (fivePct != null) parts.push(`5h ${Math.round(fivePct)}%`);
  if (sevenPct != null) parts.push(`wk ${Math.round(sevenPct)}%`);
  if (opusPct != null && opusPct > 0) parts.push(`opus ${Math.round(opusPct)}%`);

  return {
    status: limited ? "limited" : "ok",
    fiveHourPercent: fivePct ?? undefined,
    fiveHourResetsAt: fiveResets,
    sevenDayPercent: sevenPct ?? undefined,
    sevenDayResetsAt: sevenResets,
    sevenDayOpusPercent: opusPct ?? undefined,
    label: parts.length ? parts.join(" · ") : "Usage ok",
    accountEmail,
    canWork: !limited,
    fetchedAt,
  };
}

/**
 * Normalize API utilization to 0–100.
 * OAuth /usage returns 0–100; some headers use 0.0–1.0 fractions.
 */
export function clampPct(n: unknown): number | null {
  if (typeof n !== "number" || Number.isNaN(n)) return null;
  let pct = n;
  if (n > 0 && n < 1) pct = n * 100;
  return Math.max(0, Math.min(100, pct));
}

/** Access token from `claude` login (Keychain / credentials file), refreshed if needed. */
export async function getClaudeCliAccessToken(profile: AgentProfile): Promise<string | null> {
  let creds = await readClaudeOAuthCreds(profile);
  if (!creds) return null;
  creds = (await maybeRefreshCreds(profile, creds)) ?? creds;
  return creds.accessToken?.trim() || null;
}

export async function claudeCodeUserAgent(): Promise<string> {
  if (cachedClaudeUa) return cachedClaudeUa;
  try {
    const { stdout } = await execFileAsync("claude", ["--version"], {
      timeout: 3000,
      maxBuffer: 4096,
    });
    const m = stdout.trim().match(/(\d+\.\d+\.\d+)/);
    if (m) {
      cachedClaudeUa = `claude-code/${m[1]}`;
      return cachedClaudeUa;
    }
  } catch {
    /* ignore */
  }
  cachedClaudeUa = "claude-code/2.0.0";
  return cachedClaudeUa;
}

async function readClaudeOAuthCreds(profile: AgentProfile): Promise<ClaudeOAuthCreds | null> {
  const service = claudeKeychainService(profile.claudeConfigDir);

  if (process.platform === "darwin") {
    try {
      const { stdout: meta } = await execFileAsync(
        "security",
        ["find-generic-password", "-s", service],
        { timeout: 4000, maxBuffer: 64_000 },
      );
      const acctMatch = meta.match(/"acct"<blob>="([^"]*)"/);
      const account = acctMatch?.[1] || process.env.USER || "claude";

      const { stdout } = await execFileAsync(
        "security",
        ["find-generic-password", "-s", service, "-w"],
        { timeout: 4000, maxBuffer: 256_000 },
      );
      const parsed = parseCredsJson(stdout.trim());
      if (parsed) {
        parsed.keychainAccount = account;
        return parsed;
      }
    } catch {
      /* files below */
    }
  }

  const candidates: string[] = [];
  if (profile.claudeConfigDir?.trim()) {
    const dir = profile.claudeConfigDir.trim();
    candidates.push(join(dir, ".credentials.json"));
    candidates.push(join(dir, "credentials.json"));
    candidates.push(join(dir, ".claude", ".credentials.json"));
  } else {
    candidates.push(join(homedir(), ".claude", ".credentials.json"));
    candidates.push(join(homedir(), ".claude", "credentials.json"));
  }
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const parsed = parseCredsJson(readFileSync(p, "utf8"));
      if (parsed) return parsed;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function parseCredsJson(raw: string): ClaudeOAuthCreds | null {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const nested = obj.claudeAiOauth && typeof obj.claudeAiOauth === "object";
    const o = (nested ? obj.claudeAiOauth : obj) as Record<string, unknown>;
    const accessToken =
      typeof o.accessToken === "string"
        ? o.accessToken
        : typeof o.access_token === "string"
          ? o.access_token
          : "";
    if (!accessToken.trim()) return null;
    const refreshToken =
      typeof o.refreshToken === "string"
        ? o.refreshToken
        : typeof o.refresh_token === "string"
          ? o.refresh_token
          : undefined;
    const expiresAt =
      typeof o.expiresAt === "number"
        ? o.expiresAt
        : typeof o.expires_at === "number"
          ? o.expires_at
          : undefined;
    return {
      accessToken: accessToken.trim(),
      refreshToken: refreshToken?.trim(),
      expiresAt,
      scopes: Array.isArray(o.scopes) ? (o.scopes as string[]) : undefined,
      subscriptionType: typeof o.subscriptionType === "string" ? o.subscriptionType : undefined,
      rateLimitTier: typeof o.rateLimitTier === "string" ? o.rateLimitTier : undefined,
      nested: Boolean(nested),
      raw: obj,
    };
  } catch {
    return null;
  }
}

/**
 * Persist refreshed tokens back to Keychain (or credentials file) so Claude CLI
 * and the host stay in sync. Never log token values.
 */
async function writeClaudeOAuthCreds(
  profile: AgentProfile,
  creds: ClaudeOAuthCreds,
): Promise<void> {
  const oauthBody: Record<string, unknown> = {
    accessToken: creds.accessToken,
    refreshToken: creds.refreshToken,
    expiresAt: creds.expiresAt,
    scopes: creds.scopes ?? [],
    subscriptionType: creds.subscriptionType,
    rateLimitTier: creds.rateLimitTier,
  };

  let payload: Record<string, unknown>;
  if (creds.nested) {
    payload = { ...creds.raw, claudeAiOauth: { ...(creds.raw.claudeAiOauth as object), ...oauthBody } };
  } else {
    payload = { ...creds.raw, ...oauthBody };
  }
  const blob = JSON.stringify(payload);
  const service = claudeKeychainService(profile.claudeConfigDir);

  if (process.platform === "darwin" && creds.keychainAccount) {
    const account = creds.keychainAccount;
    try {
      // delete + add is the reliable update path for -w secrets
      await execFileAsync("security", ["delete-generic-password", "-s", service, "-a", account], {
        timeout: 4000,
      }).catch(() => undefined);
      await execFileAsync(
        "security",
        ["add-generic-password", "-s", service, "-a", account, "-w", blob],
        { timeout: 4000 },
      );
      return;
    } catch {
      /* fall through to file */
    }
  }

  // File write for Linux / keychain failure
  const path = profile.claudeConfigDir?.trim()
    ? join(profile.claudeConfigDir.trim(), ".credentials.json")
    : join(homedir(), ".claude", ".credentials.json");
  try {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, blob, { mode: 0o600 });
  } catch {
    /* best-effort */
  }
}

export function claudeKeychainService(claudeConfigDir?: string): string {
  if (!claudeConfigDir?.trim()) return "Claude Code-credentials";
  const abs = claudeConfigDir.replace(/\/$/, "");
  const hash = createHash("sha256").update(abs).digest("hex").slice(0, 8);
  return `Claude Code-credentials-${hash}`;
}

function readClaudeAccountEmail(profile: AgentProfile): string | undefined {
  const candidates = profile.claudeConfigDir?.trim()
    ? [
        join(profile.claudeConfigDir.trim(), ".claude.json"),
        join(profile.claudeConfigDir.trim(), ".claude", ".claude.json"),
      ]
    : [join(homedir(), ".claude.json")];

  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const raw = JSON.parse(readFileSync(p, "utf8")) as {
        oauthAccount?: { emailAddress?: string };
      };
      const email = raw.oauthAccount?.emailAddress?.trim();
      if (email) return email;
    } catch {
      /* ignore */
    }
  }
  return undefined;
}
