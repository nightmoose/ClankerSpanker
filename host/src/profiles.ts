import type { AgentProfile, HostConfigFile, PublicAgentProfile, SessionBackend } from "./types.js";

/** Built-in defaults until the user customizes ~/.grok-dispatch/config.json */
export function defaultProfiles(): AgentProfile[] {
  return [
    {
      id: "nightmoose",
      name: "NightMoose",
      backend: "grok",
      color: "#73B8FF",
      model: "grok-build",
    },
    {
      id: "fullscore",
      name: "FullScore",
      backend: "claude",
      color: "#F97316",
      // Set ANTHROPIC_API_KEY (or claudeConfigDir) in config.json for this profile
      env: {},
    },
    {
      id: "astro",
      name: "Astro",
      backend: "claude",
      color: "#FB923C",
      env: {},
    },
  ];
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
    const backend: SessionBackend = p.backend === "claude" ? "claude" : "grok";
    out.push({
      id,
      name: p.name.trim(),
      backend,
      color: (p.color ?? (backend === "claude" ? "#F97316" : "#73B8FF")).trim(),
      env: p.env && typeof p.env === "object" ? { ...p.env } : {},
      claudeConfigDir: p.claudeConfigDir?.trim() || undefined,
      model: p.model?.trim() || undefined,
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
    hasCredentials: profileHasCredentials(p),
  }));
}

export function profileHasCredentials(p: AgentProfile): boolean {
  if (p.backend === "claude") {
    const key = p.env?.ANTHROPIC_API_KEY?.trim() || p.env?.ANTHROPIC_AUTH_TOKEN?.trim();
    if (key) return true;
    if (p.claudeConfigDir) return true;
    // Fall back to ambient machine login
    return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  }
  // Grok uses machine-level grok login / XAI_API_KEY
  return Boolean(process.env.XAI_API_KEY || p.env?.XAI_API_KEY);
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
  return env;
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
  };
  return named[c] ?? "#A1A1AA";
}
