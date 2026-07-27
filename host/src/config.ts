import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

function defaultProjects(): ProjectInfo[] {
  // host/src → host root when running from dist is host/dist → one up is host, two is repo
  // When compiled: dist/config.js → ../.. = host package root; we want monorepo root if present
  const hostRoot = resolve(__dirname, "..");
  const repoRoot = resolve(hostRoot, "..");
  const candidates: ProjectInfo[] = [
    {
      id: "clankerspanker",
      name: "ClankerSpanker",
      path: existsSync(join(repoRoot, "host")) ? repoRoot : hostRoot,
    },
  ];
  let i = 0;
  for (const path of defaultProjectPathCandidates()) {
    if (!existsSync(path)) continue;
    candidates.push({
      id: i === 0 ? "projects" : `projects-${i}`,
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

  const merged: HostConfigFile = {
    hostToken: raw.hostToken ?? randomBytes(24).toString("hex"),
    bindHost: raw.bindHost ?? "0.0.0.0",
    bindPort: raw.bindPort ?? 8787,
    grokBinary: raw.grokBinary ?? findGrokBinary(),
    projects: raw.projects?.length ? raw.projects : defaultProjects(),
    allowCustomPaths: raw.allowCustomPaths ?? true,
    profiles,
    autoApproveKinds: raw.autoApproveKinds ?? DEFAULT_AUTO_APPROVE,
    notifyDesktop,
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
      const allowed = config.projects.some(
        (p) => resolved === p.path || resolved.startsWith(p.path + "/") || resolved.startsWith(p.path + "\\"),
      );
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
