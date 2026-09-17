import { copyFileSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentProfile } from "./types.js";
import { MCP_CATALOG } from "./mcp-catalog.js";

/** Plugin ids Grok must not inherit from ~/.claude (unsigned HTTP MCP). */
export const GROK_DISABLED_PLUGIN_IDS: readonly string[] = [
  ...new Set(["vercel", ...MCP_CATALOG.map((s) => s.id).filter((id) => id !== "fly")]),
];

export function isolatedGrokHomePath(dataDir: string, profileId: string): string {
  return join(dataDir, "grok-homes", profileId.trim());
}

export function sharedGrokAuthPath(): string {
  // Always the machine login. Do not follow process.env.GROK_HOME — this
  // host (or a Grok worker that started it) may already be isolated.
  return join(homedir(), ".grok", "auth.json");
}

/** Isolation config so ACP does not load Claude/Cursor plugin MCP. */
export function grokIsolationConfigToml(): string {
  const disabled = GROK_DISABLED_PLUGIN_IDS.map((id) => JSON.stringify(id)).join(", ");
  return [
    "# Written by ClankerSpanker. Do not point this GROK_HOME at ~/.grok",
    "# if you want payer-isolated MCP (Claude's Vercel plugin lives there).",
    "[cli]",
    "auto_update = false",
    "",
    "[compat.claude]",
    "mcps = false",
    "",
    "[compat.cursor]",
    "mcps = false",
    "",
    "[plugins]",
    `disabled = [${disabled}]`,
    "",
  ].join("\n");
}

function linkOrCopyAuth(sharedAuth: string, dest: string): void {
  if (existsSync(dest) || !existsSync(sharedAuth)) return;
  try {
    symlinkSync(sharedAuth, dest);
  } catch {
    copyFileSync(sharedAuth, dest);
  }
}

/**
 * Ensure `homeDir` can be used as GROK_HOME for a Dispatch Grok spawn.
 * Writes isolation `config.toml` only when missing. Seeds `auth.json`
 * from the machine's shared Grok login when missing.
 */
export function ensureIsolatedGrokHome(
  homeDir: string,
  opts?: { sharedAuthPath?: string; seedAuth?: boolean },
): void {
  const dir = homeDir.trim();
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, "config.toml");
  if (!existsSync(configPath)) {
    writeFileSync(configPath, grokIsolationConfigToml(), { encoding: "utf8" });
  }
  if (opts?.seedAuth === false) return;
  linkOrCopyAuth(opts?.sharedAuthPath?.trim() || sharedGrokAuthPath(), join(dir, "auth.json"));
}

/** Directory Grok ACP should use for this profile. */
export function resolveGrokHomeForProfile(profile: AgentProfile, dataDir?: string): string | undefined {
  const explicit = profile.grokHome?.trim();
  if (explicit) return explicit;
  if (!dataDir?.trim()) return undefined;
  if (profile.backend !== "grok" && profile.backend !== "bot") return undefined;
  return isolatedGrokHomePath(dataDir, profile.id);
}

/**
 * Thread GROK_HOME (+ Claude/Cursor MCP kill switches) onto a spawn env.
 * Explicit `profile.grokHome` is used as-is (not rewritten). The default
 * isolated home is seeded on first use.
 */
export function applyGrokHomeToEnv(
  env: NodeJS.ProcessEnv,
  profile: AgentProfile,
  dataDir?: string,
): NodeJS.ProcessEnv {
  const home = resolveGrokHomeForProfile(profile, dataDir);
  if (!home) return env;
  const explicit = profile.grokHome?.trim();
  if (!explicit && dataDir?.trim()) {
    ensureIsolatedGrokHome(home);
  }
  env.GROK_HOME = home;
  env.GROK_CLAUDE_MCPS_ENABLED = "false";
  env.GROK_CURSOR_MCPS_ENABLED = "false";
  return env;
}
