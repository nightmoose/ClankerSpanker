import { spawn, type ChildProcess } from "node:child_process";
import type { AgentProfile } from "./types.js";
import { profileProcessEnv } from "./profiles.js";
import { findClaudeBinary } from "./sessions/reader.js";
import { agentPathEnv } from "./platform.js";

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
const activeLogins = new Map<string, { startedAt: number; proc: ChildProcess }>();

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
  return {
    ok: false,
    error: "Grok re-login: run `grok` / sign in with xAI on the host machine.",
  };
}

function startClaudeLogin(profile: AgentProfile, email?: string): LoginStartResult | LoginStartError {
  const existing = activeLogins.get(profile.id);
  if (existing && !existing.proc.killed) {
    // Allow re-click after 2 minutes
    if (Date.now() - existing.startedAt < 120_000) {
      return {
        ok: true,
        profileId: profile.id,
        backend: "claude",
        message: "Login already in progress — finish the browser window on this Mac.",
        email,
        alreadyRunning: true,
      };
    }
    try {
      existing.proc.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    activeLogins.delete(profile.id);
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
  proc.on("exit", () => {
    const cur = activeLogins.get(profile.id);
    if (cur?.proc === proc) activeLogins.delete(profile.id);
  });

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

export function isAuthFailureMessage(msg: string | undefined | null): boolean {
  if (!msg) return false;
  const m = msg.toLowerCase();
  return (
    m.includes("oauth") ||
    m.includes("access token") ||
    m.includes("not logged in") ||
    m.includes("please run /login") ||
    m.includes("failed to authenticate") ||
    m.includes("authentication_error") ||
    m.includes("authentication credentials") ||
    (m.includes("401") && (m.includes("auth") || m.includes("token") || m.includes("unauthorized")))
  );
}
