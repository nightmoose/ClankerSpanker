import { spawn, type ChildProcess } from "node:child_process";
import type { AgentProfile } from "./types.js";
import { profileProcessEnv } from "./profiles.js";
import { findClaudeBinary } from "./sessions/reader.js";
import { agentPathEnv, findGrokBinaryCandidates, firstExistingBinary } from "./platform.js";

export interface LoginStartResult {
  ok: true;
  profileId: string;
  backend: string;
  message: string;
  /** Email pre-filled when known. */
  email?: string;
  alreadyRunning?: boolean;
}

export interface LoginStartError {
  ok: false;
  error: string;
}

/** In-flight login processes per profile (avoid stacking browsers). */
const activeLogins = new Map<string, { startedAt: number; proc?: ChildProcess }>();
const LOGIN_COOLDOWN_MS = 180_000;

function loginAlreadyRunning(
  profileId: string,
): { startedAt: number; proc?: ChildProcess } | undefined {
  const existing = activeLogins.get(profileId);
  if (!existing) return undefined;
  if (Date.now() - existing.startedAt < LOGIN_COOLDOWN_MS) return existing;
  try {
    existing.proc?.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  activeLogins.delete(profileId);
  return undefined;
}

/**
 * Open an interactive login for this profile on the host machine.
 * Claude: `claude auth login` (opens browser) with CLAUDE_CONFIG_DIR when set.
 */
export function startProfileLogin(
  profile: AgentProfile,
  opts?: { email?: string },
): LoginStartResult | LoginStartError {
  if (profile.backend === "claude") {
    return startClaudeLogin(profile, opts?.email);
  }
  if (profile.backend === "antigravity") {
    return {
      ok: false,
      error: "Antigravity re-login: run `agy` once on the host machine (no remote login API yet).",
    };
  }
  if (profile.backend === "bot") {
    return {
      ok: false,
      error:
        "Bots use the same CLI login as Sessions (`grok` / `claude` / `agy` on this Mac). API keys are optional.",
    };
  }
  return startGrokLogin(profile);
}

function findGrokBinary(): string {
  return firstExistingBinary(findGrokBinaryCandidates(), "grok");
}

function startGrokLogin(profile: AgentProfile): LoginStartResult | LoginStartError {
  // osascript exits as soon as Terminal opens — do not treat that as
  // "login finished" or every retry starts a new OAuth and the browser
  // keeps asking.
  if (loginAlreadyRunning(profile.id)) {
    return {
      ok: true,
      profileId: profile.id,
      backend: "grok",
      message: "Login already in progress — finish the browser window on this Mac, then send another message.",
      alreadyRunning: true,
    };
  }

  const grokBin = findGrokBinary();
  const env = {
    ...profileProcessEnv(profile),
    PATH: agentPathEnv(),
    BROWSER: process.env.BROWSER,
  };

  // `grok login --oauth` needs a TTY to print the browser prompt. On Mac
  // open Terminal so the user actually sees it; elsewhere spawn detached.
  const proc =
    process.platform === "darwin"
      ? spawn(
          "osascript",
          [
            "-e",
            `tell application "Terminal" to do script ${JSON.stringify(`${grokBin} login --oauth`)}`,
          ],
          { env, detached: true, stdio: "ignore" },
        )
      : spawn(grokBin, ["login", "--oauth"], {
          env,
          cwd: process.env.HOME || undefined,
          detached: true,
          stdio: "ignore",
        });
  proc.unref();

  activeLogins.set(profile.id, { startedAt: Date.now(), proc });

  return {
    ok: true,
    profileId: profile.id,
    backend: "grok",
    message: `Opened Grok login for ${profile.name}. Complete sign-in in the browser on this Mac, then retry the task.`,
  };
}

function startClaudeLogin(profile: AgentProfile, email?: string): LoginStartResult | LoginStartError {
  if (loginAlreadyRunning(profile.id)) {
    return {
      ok: true,
      profileId: profile.id,
      backend: "claude",
      message: "Login already in progress — finish the browser window on this Mac.",
      email,
      alreadyRunning: true,
    };
  }

  let claudeBin: string;
  try {
    claudeBin = findClaudeBinary();
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "claude binary not found",
    };
  }

  const args = ["auth", "login", "--claudeai"];
  if (email?.trim()) {
    args.push("--email", email.trim());
  }

  const env = {
    ...profileProcessEnv(profile),
    PATH: agentPathEnv(),
    // Force GUI browser path on macOS launchd hosts
    BROWSER: process.env.BROWSER,
  };

  const proc = spawn(claudeBin, args, {
    env,
    cwd: process.env.HOME || undefined,
    detached: true,
    stdio: "ignore",
  });
  proc.unref();

  activeLogins.set(profile.id, { startedAt: Date.now(), proc });

  const dirHint = profile.claudeConfigDir
    ? ` (account dir ${profile.claudeConfigDir})`
    : " (default Claude login)";

  return {
    ok: true,
    profileId: profile.id,
    backend: "claude",
    email,
    message: `Opened Claude login for ${profile.name}${dirHint}. Complete sign-in in the browser on this Mac, then retry the task.`,
  };
}

/**
 * MCP connector (Vercel, Gmail, …) wants its own OAuth. This is not
 * NightMoose / Claude / Grok CLI login. Matching a bare "oauth" substring
 * here is what made the Sign-in alert fire on every follow-up.
 */
export function isMcpOAuthRequiredMessage(msg: string | undefined | null): boolean {
  if (!msg) return false;
  const m = msg.toLowerCase();
  if (m.includes("oauth-protected-resource") || m.includes("resource_metadata")) return true;
  if (m.includes("authrequired") && (m.includes("mcp.") || m.includes("www_authenticate") || m.includes("www-authenticate"))) {
    return true;
  }
  return false;
}

/** Host to show in the mapped MCP error, if the stderr includes a URL. */
export function mcpOAuthRequiredHost(msg: string | undefined | null): string | undefined {
  if (!msg) return undefined;
  const m = /https?:\/\/([^/\s"']+)/i.exec(msg);
  return m?.[1];
}

/**
 * Profile CLI login is dead (Grok/Claude `login` / /login). MCP AuthRequired
 * must return false — that is a connector, not the agent account.
 */
export function isAuthFailureMessage(msg: string | undefined | null): boolean {
  if (!msg) return false;
  if (isMcpOAuthRequiredMessage(msg)) return false;
  const m = msg.toLowerCase();
  return (
    m.includes("please run /login") ||
    m.includes("not logged in") ||
    m.includes("failed to authenticate") ||
    m.includes("authentication_error") ||
    m.includes("authentication credentials") ||
    m.includes("run `grok login`") ||
    m.includes("run grok login") ||
    m.includes("claude auth login") ||
    m.includes("oauth token missing") ||
    m.includes("oauth token revoked") ||
    m.includes("oauth token expired") ||
    m.includes("oauth session expired") ||
    (m.includes("401") && (m.includes("unauthorized") || m.includes("invalid api key") || m.includes("invalid_api_key")))
  );
}
