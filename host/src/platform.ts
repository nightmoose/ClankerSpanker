import { existsSync } from "node:fs";
import { homedir, networkInterfaces, platform } from "node:os";
import { join } from "node:path";

export type HostPlatform = "darwin" | "linux" | "win32" | "other";

export function hostPlatform(): HostPlatform {
  const p = platform();
  if (p === "darwin" || p === "linux" || p === "win32") return p;
  return "other";
}

/** PATH prefix for spawned agent processes (Grok / Claude). */
export function agentPathEnv(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
  const sep = process.platform === "win32" ? ";" : ":";
  const extras: string[] = [
    join(home, ".grok", "bin"),
    join(home, ".local", "bin"),
  ];
  if (process.platform === "darwin") {
    extras.push("/opt/homebrew/bin", "/usr/local/bin");
  } else if (process.platform === "linux") {
    extras.push("/usr/local/bin", "/usr/bin");
  } else if (process.platform === "win32") {
    extras.push(join(home, "AppData", "Local", "Programs"));
  }
  return [...extras, process.env.PATH ?? ""].filter(Boolean).join(sep);
}

/** First existing absolute path, else bare command name. */
export function firstExistingBinary(candidates: string[], fallback: string): string {
  for (const c of candidates) {
    if (!c) continue;
    if (c === fallback || existsSync(c)) return c;
  }
  return fallback;
}

export function findGrokBinaryCandidates(): string[] {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
  const win = process.platform === "win32";
  const name = win ? "grok.exe" : "grok";
  return [
    process.env.GROK_BINARY,
    join(home, ".grok", "bin", name),
    join(home, ".local", "bin", name),
    ...(process.platform === "darwin"
      ? ["/opt/homebrew/bin/grok", "/usr/local/bin/grok"]
      : process.platform === "linux"
        ? ["/usr/local/bin/grok", "/usr/bin/grok"]
        : []),
    name,
  ].filter(Boolean) as string[];
}

export function findClaudeBinaryCandidates(): string[] {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
  const win = process.platform === "win32";
  const name = win ? "claude.exe" : "claude";
  return [
    process.env.CLAUDE_BINARY,
    join(home, ".local", "bin", name),
    join(home, ".claude", "bin", name),
    ...(process.platform === "darwin"
      ? ["/opt/homebrew/bin/claude", "/usr/local/bin/claude"]
      : process.platform === "linux"
        ? ["/usr/local/bin/claude", "/usr/bin/claude"]
        : []),
    name,
  ].filter(Boolean) as string[];
}

/** Antigravity CLI (`agy`) — Google's agent CLI (successor to Gemini CLI). */
export function findAgyBinaryCandidates(): string[] {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
  const win = process.platform === "win32";
  const name = win ? "agy.exe" : "agy";
  return [
    process.env.AGY_BINARY,
    process.env.ANTIGRAVITY_BINARY,
    join(home, ".local", "bin", name),
    ...(win ? [join(home, "AppData", "Local", "agy", "bin", name)] : []),
    ...(process.platform === "darwin"
      ? ["/opt/homebrew/bin/agy", "/usr/local/bin/agy"]
      : process.platform === "linux"
        ? ["/usr/local/bin/agy", "/usr/bin/agy"]
        : []),
    name,
  ].filter(Boolean) as string[];
}

export function findAgyBinary(): string {
  return firstExistingBinary(findAgyBinaryCandidates(), "agy");
}

/**
 * Best-effort LAN / Tailscale hostname:port for phone/browser clients.
 * Never hardcodes a site-specific IP.
 */
export function preferredClientHost(port: number): string {
  const fromEnv = process.env.GROK_DISPATCH_LAN_URL?.replace(/^https?:\/\//, "").trim();
  if (fromEnv) {
    return fromEnv.includes(":") ? fromEnv : `${fromEnv}:${port}`;
  }

  const nets = networkInterfaces();
  const preferred: string[] = [];
  const fallback: string[] = [];

  for (const entries of Object.values(nets)) {
    if (!entries) continue;
    for (const e of entries) {
      if (e.family !== "IPv4" && (e.family as unknown) !== 4) continue;
      if (e.internal) continue;
      // Prefer common private / CGNAT / Tailscale ranges
      if (
        e.address.startsWith("100.") || // Tailscale CGNAT
        e.address.startsWith("10.") ||
        e.address.startsWith("192.168.") ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(e.address)
      ) {
        preferred.push(e.address);
      } else {
        fallback.push(e.address);
      }
    }
  }

  const ip = preferred[0] ?? fallback[0];
  if (ip) return `${ip}:${port}`;
  return `127.0.0.1:${port}`;
}

/** Default project path guesses (only paths that exist). */
export function defaultProjectPathCandidates(): string[] {
  const home = homedir();
  return [
    join(home, "Projects"),
    join(home, "projects"),
    join(home, "Developer"),
    join(home, "dev"),
    join(home, "code"),
    join(home, "src"),
  ];
}
