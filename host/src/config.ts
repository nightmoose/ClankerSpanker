import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { HostConfigFile, ProjectInfo } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = join(homedir(), ".grok-dispatch");
const DEFAULT_CONFIG_PATH = join(DEFAULT_DATA_DIR, "config.json");

// Note: do NOT include "other" — AskUserQuestion uses kind=other and must reach the phone.
const DEFAULT_AUTO_APPROVE = ["read", "search", "think", "fetch"];

function defaultProjects(): ProjectInfo[] {
  const home = homedir();
  // host/src → repo root is two levels up when running from source or dist/src mirror
  const repoRoot = resolve(__dirname, "../..");
  const candidates: ProjectInfo[] = [
    {
      id: "grok-dispatch",
      name: "Grok Dispatch",
      path: repoRoot,
    },
    {
      id: "projects",
      name: "Projects",
      path: join(home, "Projects"),
    },
  ];
  // de-dupe by path
  const seen = new Set<string>();
  return candidates.filter((p) => {
    if (!existsSync(p.path) || seen.has(p.path)) return false;
    seen.add(p.path);
    return true;
  });
}

function findGrokBinary(): string {
  const candidates = [
    process.env.GROK_BINARY,
    join(homedir(), ".grok/bin/grok"),
    "/opt/homebrew/bin/grok",
    "/usr/local/bin/grok",
    "grok",
  ].filter(Boolean) as string[];

  for (const c of candidates) {
    if (c === "grok" || existsSync(c)) return c;
  }
  return "grok";
}

export function loadConfig(configPath = process.env.GROK_DISPATCH_CONFIG ?? DEFAULT_CONFIG_PATH): HostConfigFile {
  mkdirSync(dirname(configPath), { recursive: true });

  if (!existsSync(configPath)) {
    const created: HostConfigFile = {
      hostToken: randomBytes(24).toString("hex"),
      bindHost: process.env.GROK_DISPATCH_HOST ?? "0.0.0.0",
      bindPort: Number(process.env.GROK_DISPATCH_PORT ?? 8787),
      grokBinary: findGrokBinary(),
      projects: defaultProjects(),
      allowCustomPaths: true,
      autoApproveKinds: DEFAULT_AUTO_APPROVE,
      notifyMac: true,
      dataDir: DEFAULT_DATA_DIR,
    };
    writeFileSync(configPath, JSON.stringify(created, null, 2) + "\n", "utf8");
    console.log(`[config] Wrote new config → ${configPath}`);
    console.log(`[config] Host token (save this for ClankerSpanker):\n  ${created.hostToken}`);
    return created;
  }

  const raw = JSON.parse(readFileSync(configPath, "utf8")) as Partial<HostConfigFile>;
  const merged: HostConfigFile = {
    hostToken: raw.hostToken ?? randomBytes(24).toString("hex"),
    bindHost: raw.bindHost ?? "0.0.0.0",
    bindPort: raw.bindPort ?? 8787,
    grokBinary: raw.grokBinary ?? findGrokBinary(),
    projects: raw.projects?.length ? raw.projects : defaultProjects(),
    allowCustomPaths: raw.allowCustomPaths ?? true,
    autoApproveKinds: raw.autoApproveKinds ?? DEFAULT_AUTO_APPROVE,
    notifyMac: raw.notifyMac ?? true,
    dataDir: raw.dataDir ?? DEFAULT_DATA_DIR,
  };

  // Env overrides
  if (process.env.GROK_DISPATCH_HOST) merged.bindHost = process.env.GROK_DISPATCH_HOST;
  if (process.env.GROK_DISPATCH_PORT) merged.bindPort = Number(process.env.GROK_DISPATCH_PORT);
  if (process.env.GROK_DISPATCH_TOKEN) merged.hostToken = process.env.GROK_DISPATCH_TOKEN;
  if (process.env.GROK_BINARY) merged.grokBinary = process.env.GROK_BINARY;

  mkdirSync(merged.dataDir, { recursive: true });
  return merged;
}

export function resolveProjectPath(
  config: HostConfigFile,
  projectId?: string,
  cwd?: string,
): { path: string; projectId?: string } {
  if (projectId) {
    const project = config.projects.find((p) => p.id === projectId);
    if (!project) throw new Error(`Unknown projectId: ${projectId}`);
    if (!existsSync(project.path)) throw new Error(`Project path missing: ${project.path}`);
    return { path: project.path, projectId: project.id };
  }

  if (cwd) {
    const resolved = resolve(cwd);
    if (!existsSync(resolved)) throw new Error(`cwd does not exist: ${resolved}`);
    if (!config.allowCustomPaths) {
      const allowed = config.projects.some((p) => resolved === p.path || resolved.startsWith(p.path + "/"));
      if (!allowed) throw new Error("Custom paths are disabled; pick an allowlisted project");
    }
    const match = config.projects.find((p) => p.path === resolved);
    return { path: resolved, projectId: match?.id };
  }

  if (config.projects[0]) {
    return { path: config.projects[0].path, projectId: config.projects[0].id };
  }

  throw new Error("No project configured. Add projects to ~/.grok-dispatch/config.json");
}

export { DEFAULT_CONFIG_PATH, DEFAULT_DATA_DIR };
