import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentProfile } from "../../types.js";
import { normalizeBackend, profileProcessEnv } from "../../profiles.js";
import { getClaudeCliAccessToken, claudeCodeUserAgent } from "../../usage.js";
import type { ChatProvider, FetchLike } from "../protocol.js";
import {
  getGrokCliAccessToken,
  grokAuthJsonPathsForProfile,
  readGrokCliAccessToken,
} from "../grok-cli-auth.js";
import { getAgyAccessToken } from "../gemini-cli-auth.js";
import { createAnthropicProvider } from "./anthropic.js";
import { createGeminiProvider } from "./gemini.js";
import { createOpenAICompatProvider, remapBotModel } from "./openai-compat.js";

export type ProviderKind = "xai" | "openai-compat" | "anthropic" | "gemini" | "none";

/**
 * CLI login lives in the profile's isolated grok home
 * (`{dataDir}/grok-homes/{id}/auth.json`), which the Grok TUI refreshes.
 * The LaunchAgent has no GROK_HOME, so looking only at ~/.grok sends a
 * grant that home already rotated — api.x.ai then 403s bad-credentials.
 * Newest expiry wins inside readGrokCliCreds.
 */
export function grokCliAuthPaths(profile: AgentProfile, dataDir?: string): string[] {
  const dir = dataDir?.trim() || join(homedir(), ".grok-dispatch");
  return grokAuthJsonPathsForProfile(profile, dir);
}

export function envFromProfile(
  profile: AgentProfile,
  opts?: { dataDir?: string },
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...profileProcessEnv(profile) };
  if (!env.XAI_API_KEY?.trim()) {
    const cli = readGrokCliAccessToken(grokCliAuthPaths(profile, opts?.dataDir));
    if (cli) env.XAI_API_KEY = cli;
  }
  return env;
}

async function envFromProfileFresh(
  profile: AgentProfile,
  opts?: { dataDir?: string; fetchImpl?: FetchLike },
): Promise<Record<string, string | undefined>> {
  const env: Record<string, string | undefined> = { ...profileProcessEnv(profile) };
  const authPaths = grokCliAuthPaths(profile, opts?.dataDir);
  const fetchImpl = opts?.fetchImpl ?? fetch;
  if (!profile.env?.XAI_API_KEY?.trim() && !process.env.XAI_API_KEY?.trim()) {
    const cli = await getGrokCliAccessToken(authPaths, fetchImpl);
    if (cli) env.XAI_API_KEY = cli;
  } else if (!env.XAI_API_KEY?.trim()) {
    const cli = readGrokCliAccessToken(authPaths);
    if (cli) env.XAI_API_KEY = cli;
  }
  return env;
}

/** HTTP model slug — CLI sentinels (`claude`, `grok-build`, `antigravity`) are not API ids. */
export function httpModelFor(profile: AgentProfile): string {
  const raw = (profile.model ?? "").trim();
  const b = normalizeBackend(profile.backend);
  if (b === "claude") {
    if (!raw || raw === "claude" || raw === "default") return "claude-sonnet-4-6";
    return raw;
  }
  if (b === "antigravity") {
    const lower = raw.toLowerCase();
    if (!raw || lower === "antigravity" || lower === "agy" || lower === "gemini") {
      return "gemini-2.5-flash";
    }
    return raw;
  }
  return remapBotModel(raw || "grok-4");
}

/**
 * Pick a provider family from env + model slug.
 * Model hint wins (claude-* → anthropic, gemini-* → gemini), then OPENAI_BASE_URL,
 * then XAI, then remaining keys.
 */
export function selectProviderKind(
  env: Record<string, string | undefined>,
  model?: string,
  backend?: string,
): ProviderKind {
  const b = backend ? normalizeBackend(backend) : undefined;
  const m = (model ?? "").trim().toLowerCase();
  if (b === "claude") {
    if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) return "anthropic";
    return "none";
  }
  if (b === "antigravity") {
    if (
      env.GEMINI_API_KEY ||
      env.GOOGLE_API_KEY ||
      env.GOOGLE_GENAI_API_KEY ||
      env.GEMINI_OAUTH_TOKEN
    ) {
      return "gemini";
    }
    return "none";
  }
  if (m.startsWith("claude") && (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN)) {
    return "anthropic";
  }
  if (m.startsWith("gemini") && (env.GEMINI_API_KEY || env.GOOGLE_API_KEY || env.GOOGLE_GENAI_API_KEY || env.GEMINI_OAUTH_TOKEN)) {
    return "gemini";
  }
  if (env.OPENAI_BASE_URL?.trim() && env.OPENAI_API_KEY?.trim()) return "openai-compat";
  if (env.XAI_API_KEY?.trim()) return "xai";
  if (env.ANTHROPIC_API_KEY?.trim() || env.ANTHROPIC_AUTH_TOKEN?.trim()) return "anthropic";
  if (env.GEMINI_API_KEY?.trim() || env.GOOGLE_API_KEY?.trim() || env.GOOGLE_GENAI_API_KEY?.trim() || env.GEMINI_OAUTH_TOKEN?.trim()) {
    return "gemini";
  }
  return "none";
}

export async function pickProvider(
  profile: AgentProfile,
  fetchImpl?: FetchLike,
  opts?: { dataDir?: string },
): Promise<ChatProvider> {
  const backend = normalizeBackend(profile.backend);
  const own = profile.env ?? {};
  const env = await envFromProfileFresh(profile, { dataDir: opts?.dataDir, fetchImpl });
  const model = httpModelFor(profile);

  if (backend === "claude") {
    const apiKey = own.ANTHROPIC_API_KEY?.trim() || env.ANTHROPIC_API_KEY?.trim();
    if (apiKey) return createAnthropicProvider({ apiKey, model, fetchImpl });
    const accessToken = own.ANTHROPIC_AUTH_TOKEN?.trim() || env.ANTHROPIC_AUTH_TOKEN?.trim()
      || (await getClaudeCliAccessToken(profile));
    if (accessToken) {
      return createAnthropicProvider({
        accessToken,
        model,
        fetchImpl,
        userAgent: await claudeCodeUserAgent(),
      });
    }
    throw new Error("Claude is not signed in on this Mac. Run `claude` login — same as Sessions.");
  }

  if (backend === "antigravity") {
    const apiKey =
      own.GEMINI_API_KEY?.trim() ||
      own.GOOGLE_API_KEY?.trim() ||
      env.GEMINI_API_KEY?.trim() ||
      env.GOOGLE_API_KEY?.trim() ||
      env.GOOGLE_GENAI_API_KEY?.trim();
    if (apiKey) return createGeminiProvider({ apiKey, model, fetchImpl });
    const accessToken =
      own.GEMINI_OAUTH_TOKEN?.trim() ||
      env.GEMINI_OAUTH_TOKEN?.trim() ||
      (await getAgyAccessToken());
    if (accessToken) return createGeminiProvider({ accessToken, model, fetchImpl });
    throw new Error("Antigravity is not signed in on this Mac. Run `agy` once — same as Sessions.");
  }

  // Grok / leftover bot-backend profiles: CLI login, then explicit keys.
  const explicit = selectProviderKind(own, model, backend);
  const kind = explicit !== "none" ? explicit : selectProviderKind(env, model, backend);
  if (kind === "none") {
    throw new Error(
      "Bot has no login for this profile. Sign in with `grok`, `claude`, or `agy` on this Mac — same as Sessions.",
    );
  }
  if (kind === "anthropic") {
    const apiKey = env.ANTHROPIC_API_KEY?.trim();
    const accessToken = env.ANTHROPIC_AUTH_TOKEN?.trim() || (await getClaudeCliAccessToken(profile));
    if (apiKey) return createAnthropicProvider({ apiKey, model, fetchImpl });
    if (accessToken) {
      return createAnthropicProvider({
        accessToken,
        model,
        fetchImpl,
        userAgent: await claudeCodeUserAgent(),
      });
    }
  }
  if (kind === "gemini") {
    const apiKey =
      env.GEMINI_API_KEY?.trim() || env.GOOGLE_API_KEY?.trim() || env.GOOGLE_GENAI_API_KEY?.trim();
    if (apiKey) return createGeminiProvider({ apiKey, model, fetchImpl });
    const accessToken = env.GEMINI_OAUTH_TOKEN?.trim() || (await getAgyAccessToken());
    if (accessToken) return createGeminiProvider({ accessToken, model, fetchImpl });
  }
  if (kind === "openai-compat") {
    return createOpenAICompatProvider({
      apiKey: env.OPENAI_API_KEY!.trim(),
      baseUrl: env.OPENAI_BASE_URL!.trim(),
      model,
      kind: "openai-compat",
      fetchImpl,
    });
  }
  const explicitXai = own.XAI_API_KEY?.trim() || process.env.XAI_API_KEY?.trim();
  const authPaths = grokCliAuthPaths(profile, opts?.dataDir);
  return createOpenAICompatProvider({
    apiKey: env.XAI_API_KEY!.trim(),
    baseUrl: "https://api.x.ai/v1",
    model,
    kind: "xai",
    fetchImpl,
    // An explicit API key is not a CLI grant. Only the OAuth bearer can be refreshed.
    refreshKey: explicitXai
      ? undefined
      : async () => getGrokCliAccessToken(authPaths, fetchImpl ?? fetch, { force: true }),
  });
}

export { remapBotModel };
