import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentProfile, HostConfigFile, PublicAgentProfile, SessionBackend } from "./types.js";

/** Built-in defaults until the user customizes ~/.grok-dispatch/config.json */
export function defaultProfiles(): AgentProfile[] {
  // Defaults for *new* configs only. Real multi-account wiring is per-machine
  // in ~/.grok-dispatch/config.json (claudeConfigDir / env).
  return [
    {
      id: "nightmoose",
      name: "NightMoose",
      backend: "grok",
      color: "#73B8FF",
      model: "grok-build",
    },
    {
      id: "personal",
      name: "Personal",
      backend: "claude",
      color: "#A78BFA",
      model: "claude",
      // Default Claude login under $HOME (~/.claude). Override with claudeConfigDir.
      env: {},
    },
    {
      id: "fullscore",
      name: "FullScore",
      backend: "claude",
      color: "#F97316",
      model: "claude",
      // Example isolation: set claudeConfigDir to a dedicated dir (e.g. ~/.claude-work).
      env: {},
    },
  ];
}

/** Map a raw profile backend string. Unknown values still fall through to grok — except `bot`. */
export function normalizeBackend(raw?: string): SessionBackend {
  const b = (raw ?? "").trim().toLowerCase();
  if (b === "claude") return "claude";
  if (b === "antigravity" || b === "agy" || b === "gemini") return "antigravity";
  if (b === "bot") return "bot";
  return "grok";
}

function defaultColorForBackend(backend: SessionBackend): string {
  if (backend === "claude") return "#F97316";
  if (backend === "antigravity") return "#34A853"; // Google green
  if (backend === "bot") return "#E879F9";
  return "#73B8FF";
}

export function normalizeProfiles(raw?: AgentProfile[] | null): AgentProfile[] {
  if (!raw?.length) return defaultProfiles();
  const seen = new Set<string>();
  const out: AgentProfile[] = [];
  for (const p of raw) {
    if (!p?.id?.trim() || !p?.name?.trim()) continue;
    const id = p.id.trim();
    if (seen.has(id)) continue;
    seen.add(id);
    const backend = normalizeBackend(p.backend);
    out.push({
      id,
      name: p.name.trim(),
      backend,
      color: (p.color ?? defaultColorForBackend(backend)).trim(),
      env: p.env && typeof p.env === "object" ? { ...p.env } : {},
      claudeConfigDir: p.claudeConfigDir?.trim() || undefined,
      antigravityConfigDir: p.antigravityConfigDir?.trim() || undefined,
      model: p.model?.trim() || undefined,
      systemPrompt: p.systemPrompt?.trim() || undefined,
      toolAllowlist: Array.isArray(p.toolAllowlist)
        ? p.toolAllowlist.map((s) => String(s).trim()).filter((s) => s.length > 0)
        : undefined,
    });
  }
  return out.length ? out : defaultProfiles();
}

export function publicProfiles(config: HostConfigFile): PublicAgentProfile[] {
  return (config.profiles ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    backend: p.backend,
    color: p.color,
    model: p.model,
    systemPrompt: p.systemPrompt,
    toolAllowlist: p.toolAllowlist,
    hasCredentials: profileHasCredentials(p),
  }));
}

export function profileHasCredentials(p: AgentProfile): boolean {
  if (p.backend === "claude") {
    const key = p.env?.ANTHROPIC_API_KEY?.trim() || p.env?.ANTHROPIC_AUTH_TOKEN?.trim();
    if (key) return true;
    if (p.claudeConfigDir) return true;
    // Ambient API key env
    if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return true;
    // Default CLI login often lives as OAuth under ~/.claude.json (no API key env)
    return existsSync(join(homedir(), ".claude.json"));
  }
  if (p.backend === "antigravity") {
    const key =
      p.env?.GEMINI_API_KEY?.trim() ||
      p.env?.GOOGLE_API_KEY?.trim() ||
      p.env?.GOOGLE_GENAI_API_KEY?.trim();
    if (key) return true;
    if (
      process.env.GEMINI_API_KEY ||
      process.env.GOOGLE_API_KEY ||
      process.env.GOOGLE_GENAI_API_KEY
    ) {
      return true;
    }
    // Interactive `agy` login stores credentials in OS keyring + local settings
    const home = homedir();
    const configDir = p.antigravityConfigDir?.trim() || join(home, ".gemini", "antigravity-cli");
    if (existsSync(configDir)) return true;
    if (existsSync(join(home, ".gemini"))) return true;
    return false;
  }
  if (p.backend === "bot") {
    const env = { ...process.env, ...(p.env ?? {}) };
    if (env.XAI_API_KEY?.trim()) return true;
    if (env.ANTHROPIC_API_KEY?.trim() || env.ANTHROPIC_AUTH_TOKEN?.trim()) return true;
    if (env.OPENAI_API_KEY?.trim() && env.OPENAI_BASE_URL?.trim()) return true;
    if (env.GEMINI_API_KEY?.trim() || env.GOOGLE_API_KEY?.trim() || env.GOOGLE_GENAI_API_KEY?.trim()) {
      return true;
    }
    // Same Grok CLI login NightMoose uses for ACP.
    const grokHome = process.env.GROK_HOME?.trim() || join(homedir(), ".grok");
    if (existsSync(join(grokHome, "auth.json"))) return true;
    if (existsSync(join(homedir(), ".config", "grok", "auth.json"))) return true;
    return false;
  }
  // Grok: API key env OR CLI login (~/.grok/auth.json from `grok` sign-in)
  if (process.env.XAI_API_KEY?.trim() || p.env?.XAI_API_KEY?.trim()) return true;
  const grokHome = process.env.GROK_HOME?.trim() || join(homedir(), ".grok");
  if (existsSync(join(grokHome, "auth.json"))) return true;
  if (existsSync(join(homedir(), ".config", "grok", "auth.json"))) return true;
  return false;
}

export function resolveProfile(
  config: HostConfigFile,
  profileId?: string | null,
  preferredBackend?: SessionBackend,
): AgentProfile {
  const profiles = config.profiles?.length ? config.profiles : defaultProfiles();
  if (profileId) {
    const hit = profiles.find((p) => p.id === profileId);
    if (!hit) throw new Error(`Unknown profileId: ${profileId}`);
    return hit;
  }
  if (preferredBackend) {
    const hit = profiles.find((p) => p.backend === preferredBackend);
    if (hit) return hit;
  }
  return profiles[0]!;
}

/** Env map for spawning an agent process under this profile. */
export function profileProcessEnv(profile: AgentProfile): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...(profile.env ?? {}) };
  if (profile.claudeConfigDir) {
    // Claude Code respects CLAUDE_CONFIG_DIR for multi-account isolation when set
    env.CLAUDE_CONFIG_DIR = profile.claudeConfigDir;
  }
  if (profile.antigravityConfigDir) {
    // Hint for future multi-login; also set XDG-style home override if useful
    env.ANTIGRAVITY_CONFIG_DIR = profile.antigravityConfigDir;
  }
  return env;
}

/** Default model slug for a backend when profile/request omit one. */
export function defaultModelForBackend(backend: SessionBackend): string {
  if (backend === "claude") return "claude";
  if (backend === "antigravity") return "antigravity";
  if (backend === "bot") return "grok-4";
  return "grok-build";
}

/**
 * Model strings that mean "let the CLI pick its own default." When the
 * session model matches one of these, runners should NOT pass `--model` —
 * the CLI's own default (usually the newest Sonnet / Opus for the account
 * plan) is preferable to pinning an old slug.
 */
const CLAUDE_MODEL_SENTINELS: ReadonlySet<string> = new Set(["claude", "default", ""]);

/** True when the given model string is a placeholder that should not be passed to `claude --model`. */
export function isClaudeModelSentinel(model?: string | null): boolean {
  return CLAUDE_MODEL_SENTINELS.has((model ?? "").trim().toLowerCase());
}

/** Grok ACP meta (plan mode / worktree / subagents) — not used by CLI backends. */
export function isGrokBackend(backend?: SessionBackend | string | null): boolean {
  return !backend || backend === "grok";
}

/** CSS-friendly color for web; clients may also parse hex. */
export function resolveColorHex(color: string): string {
  const c = color.trim().toLowerCase();
  if (c.startsWith("#") && (c.length === 7 || c.length === 4)) return color.trim();
  const named: Record<string, string> = {
    orange: "#F97316",
    amber: "#F59E0B",
    blue: "#73B8FF",
    sky: "#38BDF8",
    purple: "#A78BFA",
    green: "#4ADE80",
    red: "#F87171",
    pink: "#F472B6",
    teal: "#2DD4BF",
    fuchsia: "#E879F9",
  };
  return named[c] ?? "#A1A1AA";
}
