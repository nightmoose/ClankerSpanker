import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { HostConfigFile, ProjectInfo } from "./types.js";
import {
  defaultProjectPathCandidates,
  findGrokBinaryCandidates,
  firstExistingBinary,
} from "./platform.js";
import { defaultProfiles, normalizeProfiles } from "./profiles.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = join(homedir(), ".grok-dispatch");
const DEFAULT_CONFIG_PATH = join(DEFAULT_DATA_DIR, "config.json");

// Note: do NOT include "other" — AskUserQuestion uses kind=other and must reach the client.
const DEFAULT_AUTO_APPROVE = ["read", "search", "think", "fetch"];

/** Well-known local repos — only included when the path exists on this host. */
function knownWorkspaceProjects(): ProjectInfo[] {
  const home = homedir();
  const catalog: Array<{ id: string; name: string; path: string }> = [
    { id: "clankerspanker", name: "ClankerSpanker", path: join(home, "Projects", "GrokDispatch") },
    { id: "mercenary-ios", name: "Mercenary iOS", path: join(home, "mercenary-ios") },
    { id: "mercenary", name: "Mercenary", path: join(home, "mercenary") },
    { id: "bricklayer", name: "Bricklayer", path: join(home, "Projects", "Bricklayer") },
    { id: "arcadebox", name: "ArcadeBox", path: join(home, "Projects", "ArcadeBox") },
    { id: "projects", name: "Projects", path: join(home, "Projects") },
  ];
  return catalog
    .filter((p) => existsSync(p.path) && isUsableCwd(p.path))
    .map(({ id, name, path }) => ({ id, name, path }));
}

function defaultProjects(): ProjectInfo[] {
  // host/src → host root when running from dist is host/dist → one up is host, two is repo
  // When compiled: dist/config.js → ../.. = host package root; we want monorepo root if present
  const hostRoot = resolve(__dirname, "..");
  const repoRoot = resolve(hostRoot, "..");
  const candidates: ProjectInfo[] = [...knownWorkspaceProjects()];

  if (existsSync(join(repoRoot, "host")) && isUsableCwd(repoRoot)) {
    if (!candidates.some((p) => p.path === repoRoot)) {
      candidates.unshift({
        id: "clankerspanker",
        name: "ClankerSpanker",
        path: repoRoot,
      });
    }
  }

  let i = 0;
  for (const path of defaultProjectPathCandidates()) {
    if (!existsSync(path) || !isUsableCwd(path)) continue;
    if (candidates.some((p) => p.path === path)) continue;
    candidates.push({
      id: i === 0 ? "projects-extra" : `projects-extra-${i}`,
      name: path.split(/[/\\]/).filter(Boolean).pop() ?? "Projects",
      path,
    });
    i += 1;
  }
  const seen = new Set<string>();
  return candidates.filter((p) => {
    if (!existsSync(p.path) || seen.has(p.path)) return false;
    seen.add(p.path);
    return true;
  });
}

/** Reject filesystem roots and non-directories — agents hang or sandbox-deny forever. */
export function isUsableCwd(path: string): boolean {
  const resolved = resolve(path);
  if (!resolved || resolved === "/" || /^[A-Za-z]:[\\/]?$/.test(resolved)) return false;
  try {
    return statSync(resolved).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Merge known workspaces into an existing config without removing user entries.
 * Updates names for known ids when paths match; adds missing known projects.
 */
export function mergeKnownProjects(existing: ProjectInfo[]): ProjectInfo[] {
  const known = knownWorkspaceProjects();
  const byPath = new Map(existing.map((p) => [resolve(p.path), p]));
  for (const k of known) {
    const key = resolve(k.path);
    if (!byPath.has(key)) {
      byPath.set(key, k);
    }
  }
  // Drop unusable paths (deleted folders, accidental /)
  return [...byPath.values()].filter((p) => isUsableCwd(p.path));
}

function findGrokBinary(): string {
  return firstExistingBinary(findGrokBinaryCandidates(), "grok");
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
      profiles: defaultProfiles(),
      autoApproveKinds: DEFAULT_AUTO_APPROVE,
      notifyDesktop: true,
      dataDir: DEFAULT_DATA_DIR,
    };
    writeFileSync(configPath, JSON.stringify(created, null, 2) + "\n", "utf8");
    console.log(`[config] Wrote new config → ${configPath}`);
    console.log(`[config] Host token (save this for ClankerSpanker):\n  ${created.hostToken}`);
    console.log(
      `[config] Profiles: ${created.profiles.map((p) => `${p.name}(${p.backend})`).join(", ")}`,
    );
    console.log(
      `[config] Tip: set profiles[].env.ANTHROPIC_API_KEY (or claudeConfigDir) for each Claude account.`,
    );
    return created;
  }

  const raw = JSON.parse(readFileSync(configPath, "utf8")) as Partial<HostConfigFile> & {
    notifyMac?: boolean;
  };
  const notifyDesktop =
    typeof raw.notifyDesktop === "boolean"
      ? raw.notifyDesktop
      : typeof raw.notifyMac === "boolean"
        ? raw.notifyMac
        : true;

  const profiles = normalizeProfiles(raw.profiles);
  // Persist profiles into existing configs that lack them
  if (!raw.profiles?.length) {
    try {
      const next = { ...raw, profiles };
      writeFileSync(configPath, JSON.stringify(next, null, 2) + "\n", "utf8");
      console.log(`[config] Added default profiles to ${configPath}`);
    } catch {
      /* non-fatal */
    }
  }

  const baseProjects = raw.projects?.length ? raw.projects : defaultProjects();
  const projects = mergeKnownProjects(baseProjects);

  // Persist expanded project list when we discovered new known workspaces
  if (projects.length !== baseProjects.length || projects.some((p, i) => p.path !== baseProjects[i]?.path)) {
    try {
      const next = { ...raw, profiles, projects };
      writeFileSync(configPath, JSON.stringify(next, null, 2) + "\n", "utf8");
      console.log(`[config] Updated projects list (${projects.length}) in ${configPath}`);
    } catch {
      /* non-fatal */
    }
  }

  const merged: HostConfigFile = {
    hostToken: raw.hostToken ?? randomBytes(24).toString("hex"),
    bindHost: raw.bindHost ?? "0.0.0.0",
    bindPort: raw.bindPort ?? 8787,
    grokBinary: raw.grokBinary ?? findGrokBinary(),
    projects,
    allowCustomPaths: raw.allowCustomPaths ?? true,
    profiles,
    autoApproveKinds: raw.autoApproveKinds ?? DEFAULT_AUTO_APPROVE,
    notifyDesktop,
    dataDir: raw.dataDir ?? DEFAULT_DATA_DIR,
    promptIdleTimeoutMs:
      typeof raw.promptIdleTimeoutMs === "number" ? raw.promptIdleTimeoutMs : undefined,
    promptMaxMs: typeof raw.promptMaxMs === "number" ? raw.promptMaxMs : undefined,
  };

  // Env overrides
  if (process.env.GROK_DISPATCH_HOST) merged.bindHost = process.env.GROK_DISPATCH_HOST;
  if (process.env.GROK_DISPATCH_PORT) merged.bindPort = Number(process.env.GROK_DISPATCH_PORT);
  if (process.env.GROK_DISPATCH_TOKEN) merged.hostToken = process.env.GROK_DISPATCH_TOKEN;
  if (process.env.GROK_BINARY) merged.grokBinary = process.env.GROK_BINARY;
  if (process.env.GROK_DISPATCH_PROMPT_IDLE_MS) {
    merged.promptIdleTimeoutMs = Number(process.env.GROK_DISPATCH_PROMPT_IDLE_MS);
  }
  if (process.env.GROK_DISPATCH_PROMPT_MAX_MS) {
    merged.promptMaxMs = Number(process.env.GROK_DISPATCH_PROMPT_MAX_MS);
  }

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
    assertUsableCwd(project.path, `project ${project.id}`);
    return { path: resolve(project.path), projectId: project.id };
  }

  if (cwd) {
    const resolved = resolve(cwd);
    assertUsableCwd(resolved, "cwd");
    if (!config.allowCustomPaths) {
      const allowed = config.projects.some(
        (p) => resolved === p.path || resolved.startsWith(p.path + "/") || resolved.startsWith(p.path + "\\"),
      );
      if (!allowed) throw new Error("Custom paths are disabled; pick an allowlisted project");
    }
    const match = config.projects.find((p) => resolve(p.path) === resolved);
    return { path: resolved, projectId: match?.id };
  }

  if (config.projects[0]) {
    assertUsableCwd(config.projects[0].path, "default project");
    return { path: resolve(config.projects[0].path), projectId: config.projects[0].id };
  }

  throw new Error("No project configured. Add projects to ~/.grok-dispatch/config.json");
}

function assertUsableCwd(path: string, label: string): void {
  if (!isUsableCwd(path)) {
    throw new Error(
      `Invalid ${label}: "${path}". Agents need a real project directory, not / or a missing path. ` +
        `Pick Mercenary iOS / ClankerSpanker / etc. from the working-directory list.`,
    );
  }
}

export { DEFAULT_CONFIG_PATH, DEFAULT_DATA_DIR };
