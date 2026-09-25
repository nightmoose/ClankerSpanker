import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { expandHome, inferProjectId } from "./project-resolve.js";
import { discoverRepoProjects } from "./discover-repos.js";
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
    .map(({ id, name, path }) => normalizeProject({ id, name, path }));
}

/**
 * Coerce a legacy project record (single `path`) into the current shape
 * (multi-`paths` + mirrored `path`). Idempotent. Accepts loose input so
 * legacy on-disk configs and API create bodies without `paths` typecheck.
 */
export function normalizeProject(
  raw: Partial<ProjectInfo> & { id: string; name: string },
): ProjectInfo {
  const pathsFromArray = Array.isArray(raw.paths)
    ? raw.paths.filter((p) => typeof p === "string" && p.trim().length > 0)
    : [];
  const legacyPath =
    typeof raw.path === "string" && raw.path.trim().length > 0 ? raw.path : undefined;
  // RFC-032: `~/x` is stored as typed by some clients; resolve() never expands it.
  const merged = (pathsFromArray.length > 0 ? [...pathsFromArray] : (legacyPath ? [legacyPath] : [])).map((p) =>
    expandHome(p),
  );
  const seen = new Set<string>();
  const paths = merged.filter((p) => (seen.has(p) ? false : (seen.add(p), true)));
  return {
    ...raw,
    paths,
    path: paths[0] ?? "",
  };
}

/**
 * Discover known workspaces on disk (used by the opt-in "Import" endpoint,
 * no longer merged automatically at boot).
 */
export function discoverKnownProjects(extraRoots: string[] = []): ProjectInfo[] {
  // RFC-036: scan for git repos instead of one Mac's hardcoded folder list.
  // RFC-037: plus config.json "discoverRoots".
  return discoverRepoProjects(homedir(), extraRoots).map(normalizeProject);
}

function defaultProjects(): ProjectInfo[] {
  // Retained for backwards compatibility / test fixtures. No longer called
  // from loadConfig (fresh installs start with an empty project list).
  const hostRoot = resolve(__dirname, "..");
  const repoRoot = resolve(hostRoot, "..");
  const candidates: ProjectInfo[] = [...knownWorkspaceProjects()];

  if (existsSync(join(repoRoot, "host")) && isUsableCwd(repoRoot)) {
    if (!candidates.some((p) => p.path === repoRoot)) {
      candidates.unshift(normalizeProject({
        id: "clankerspanker",
        name: "ClankerSpanker",
        path: repoRoot,
      }));
    }
  }

  let i = 0;
  for (const path of defaultProjectPathCandidates()) {
    if (!existsSync(path) || !isUsableCwd(path)) continue;
    if (candidates.some((p) => p.path === path)) continue;
    candidates.push(normalizeProject({
      id: i === 0 ? "projects-extra" : `projects-extra-${i}`,
      name: path.split(/[/\\]/).filter(Boolean).pop() ?? "Projects",
      path,
    }));
    i += 1;
  }
  const seen = new Set<string>();
  return candidates.filter((p) => {
    if (!p.path || !existsSync(p.path) || seen.has(p.path)) return false;
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

/**
 * Persist the in-memory config back to disk. Used by REST mutations
 * (project CRUD, attachments, etc.). Non-fatal on I/O error — logs and
 * moves on so the API stays responsive.
 */
/**
 * config.json holds the host token and per-profile secrets (GITHUB_TOKEN,
 * NPM_TOKEN, …). Always owner-only (RFC-026). `mode` on writeFileSync only
 * applies when the file is created, so chmod explicitly as well.
 */
export function writeConfigFile(configPath: string, value: unknown): void {
  writeFileSync(configPath, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  chmodSync(configPath, 0o600);
}

/** Tighten an existing config.json (and its `.bak*` siblings) to 0600. */
export function tightenConfigPermissions(configPath: string): void {
  const dir = dirname(configPath);
  const base = basename(configPath);
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name !== base && !name.startsWith(`${base}.bak`)) continue;
    const full = join(dir, name);
    try {
      if ((statSync(full).mode & 0o077) !== 0) {
        chmodSync(full, 0o600);
        console.log(`[config] Tightened permissions on ${full} to 0600`);
      }
    } catch {
      /* non-fatal */
    }
  }
}

export function saveConfig(
  config: HostConfigFile,
  configPath = process.env.GROK_DISPATCH_CONFIG ?? DEFAULT_CONFIG_PATH,
): boolean {
  try {
    mkdirSync(dirname(configPath), { recursive: true });
    // Normalize projects so `path` always mirrors `paths[0]` on the wire
    // for legacy clients still reading the old field.
    const projects = (config.projects ?? []).map(normalizeProject);
    const next = { ...config, projects };
    writeConfigFile(configPath, next);
    return true;
  } catch (err) {
    console.warn("[config] saveConfig failed:", err instanceof Error ? err.message : err);
    return false;
  }
}

/** Directory holding per-project files (attachments, resources). Created on demand. */
export function projectDir(dataDir: string, projectId: string): string {
  const dir = join(dataDir, "projects", projectId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function projectAttachmentsDir(dataDir: string, projectId: string): string {
  const dir = join(projectDir(dataDir, projectId), "attachments");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function loadConfig(configPath = process.env.GROK_DISPATCH_CONFIG ?? DEFAULT_CONFIG_PATH): HostConfigFile {
  mkdirSync(dirname(configPath), { recursive: true });

  if (!existsSync(configPath)) {
    const created: HostConfigFile = {
      hostId: randomUUID(),
      hostToken: randomBytes(24).toString("hex"),
      bindHost: process.env.GROK_DISPATCH_HOST ?? "auto", // RFC-028: loopback + Tailscale
      bindPort: Number(process.env.GROK_DISPATCH_PORT ?? 8787),
      grokBinary: findGrokBinary(),
      // Projects start empty on a fresh install; the UI's Import action can
      // opt in to filesystem discoveries via /projects/discover.
      projects: [],
      allowCustomPaths: true,
      profiles: defaultProfiles(),
      autoApproveKinds: DEFAULT_AUTO_APPROVE,
      notifyDesktop: true,
      dataDir: DEFAULT_DATA_DIR,
    };
    writeConfigFile(configPath, created);
    console.log(`[config] Wrote new config → ${configPath}`);
    console.log(`[config] Host token minted. Pair clients from http://localhost:${created.bindPort}/setup on this machine.`);
    console.log(
      `[config] Profiles: ${created.profiles.map((p) => `${p.name}(${p.backend})`).join(", ")}`,
    );
    console.log(
      `[config] Tip: set profiles[].env.ANTHROPIC_API_KEY (or claudeConfigDir) for each Claude account.`,
    );
    console.log(
      `[config] Tip: add a profile with backend "antigravity" after installing agy (https://antigravity.google/docs/cli/install).`,
    );
    return created;
  }

  tightenConfigPermissions(configPath);

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
      writeConfigFile(configPath, next);
      console.log(`[config] Added default profiles to ${configPath}`);
    } catch {
      /* non-fatal */
    }
  }

  // Projects are user-curated now: don't auto-append filesystem discoveries
  // at boot. Coerce any legacy single-`path` entries into the multi-`paths`
  // shape so older config.json files continue to work seamlessly.
  const rawProjects: ProjectInfo[] = Array.isArray(raw.projects) ? raw.projects : [];
  const projects = rawProjects.map(normalizeProject);

  // One-shot migration: if the on-disk file still has old single-`path`
  // records but no `paths`, rewrite it so subsequent reads are stable.
  const needsMigration = rawProjects.some(
    (p) => !Array.isArray((p as ProjectInfo).paths),
  );
  if (needsMigration) {
    try {
      const next = { ...raw, profiles, projects };
      writeConfigFile(configPath, next);
      console.log(`[config] Migrated ${projects.length} projects to paths[] shape`);
    } catch {
      /* non-fatal */
    }
  }

  // Mint + persist a host token when it is missing (e.g. deleted to rotate
  // it). Before RFC-026 a missing token was re-randomized on every boot and
  // never saved, so clients could not stay paired across restarts.
  if (typeof raw.hostToken !== "string") {
    (raw as Partial<HostConfigFile>).hostToken = randomBytes(24).toString("hex");
    try {
      writeConfigFile(configPath, raw);
      console.log(`[config] Minted a new host token. Re-pair clients from /setup on this machine.`);
    } catch {
      /* non-fatal */
    }
  }

  // Mint hostId once and persist so clients can key state to a stable identity.
  const rawHostIdString = typeof raw.hostId === "string" ? raw.hostId.trim() : "";
  if (!rawHostIdString) {
    const mintedHostId = randomUUID();
    (raw as Partial<HostConfigFile>).hostId = mintedHostId;
    try {
      writeConfigFile(configPath, raw);
      console.log(`[config] Minted hostId ${mintedHostId}`);
    } catch {
      /* non-fatal — an in-memory hostId still works for this boot */
    }
  }

  const apns =
    raw.apns && typeof raw.apns === "object"
      ? {
          keyId: typeof raw.apns.keyId === "string" ? raw.apns.keyId : undefined,
          teamId: typeof raw.apns.teamId === "string" ? raw.apns.teamId : undefined,
          keyP8: typeof raw.apns.keyP8 === "string" ? raw.apns.keyP8 : undefined,
          keyPath: typeof raw.apns.keyPath === "string" ? raw.apns.keyPath : undefined,
          bundleId: typeof raw.apns.bundleId === "string" ? raw.apns.bundleId : undefined,
          environment:
            raw.apns.environment === "sandbox" ||
            raw.apns.environment === "production" ||
            raw.apns.environment === "auto"
              ? raw.apns.environment
              : undefined,
        }
      : undefined;

  const merged: HostConfigFile = {
    hostId: typeof raw.hostId === "string" && raw.hostId.trim() ? raw.hostId : randomUUID(),
    hostToken: raw.hostToken ?? randomBytes(24).toString("hex"),
    bindHost: raw.bindHost ?? "0.0.0.0",
    bindPort: raw.bindPort ?? 8787,
    grokBinary: raw.grokBinary ?? findGrokBinary(),
    projects,
    allowCustomPaths: raw.allowCustomPaths ?? true,
    profiles,
    autoApproveKinds: raw.autoApproveKinds ?? DEFAULT_AUTO_APPROVE,
    notifyDesktop,
    apns,
    dataDir: raw.dataDir ?? DEFAULT_DATA_DIR,
    promptIdleTimeoutMs:
      typeof raw.promptIdleTimeoutMs === "number" ? raw.promptIdleTimeoutMs : undefined,
    promptMaxMs: typeof raw.promptMaxMs === "number" ? raw.promptMaxMs : undefined,
    discoverRoots: Array.isArray(raw.discoverRoots)
      ? raw.discoverRoots.filter((r): r is string => typeof r === "string" && r.trim().length > 0)
      : undefined,
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
    const projectPaths = (project.paths?.length ? project.paths : [project.path]).filter(Boolean);
    // If the caller passed a cwd, honor it as long as it's one of the
    // project's declared paths (multi-path projects need to pick one).
    if (cwd && cwd.trim().length > 0) {
      const wanted = resolve(expandHome(cwd));
      const match = projectPaths.find((p) => resolve(p) === wanted);
      if (match) {
        assertUsableCwd(match, `project ${project.id}`);
        return { path: resolve(match), projectId: project.id };
      }
    }
    const chosen = projectPaths[0] ?? project.path;
    assertUsableCwd(chosen, `project ${project.id}`);
    return { path: resolve(chosen), projectId: project.id };
  }

  if (cwd) {
    const resolved = resolve(expandHome(cwd)); // RFC-036: typed ~/x works
    assertUsableCwd(resolved, "cwd");
    if (!config.allowCustomPaths) {
      const allowed = config.projects.some(
        (p) => resolved === p.path || resolved.startsWith(p.path + "/") || resolved.startsWith(p.path + "\\"),
      );
      if (!allowed) throw new Error("Custom paths are disabled; pick an allowlisted project");
    }
    // RFC-032: longest matching project path, not only an exact first-path match.
    return { path: resolved, projectId: inferProjectId(config.projects, resolved) };
  }

  if (config.projects[0]) {
    assertUsableCwd(config.projects[0].path, "default project");
    return { path: resolve(config.projects[0].path), projectId: config.projects[0].id };
  }

  throw new Error("No project configured. Add projects to ~/.grok-dispatch/config.json");
}

/** Extra workspace folders besides cwd. Must exist; honors allowCustomPaths. */
export function normalizeExtraDirs(
  config: HostConfigFile,
  cwd: string,
  extraDirs?: string[],
): string[] {
  if (!extraDirs?.length) return [];
  const cwdResolved = resolve(cwd);
  const out: string[] = [];
  for (const raw of extraDirs) {
    const trimmed = String(raw ?? "").trim();
    if (!trimmed) continue;
    const dir = resolve(trimmed);
    if (dir === cwdResolved) continue;
    assertUsableCwd(dir, "extra folder");
    if (!config.allowCustomPaths) {
      const allowed = config.projects.some((p) => {
        const paths = (p.paths?.length ? p.paths : [p.path]).filter(Boolean);
        return paths.some((pp) => {
          const r = resolve(pp);
          return dir === r || dir.startsWith(r + "/") || dir.startsWith(r + "\\");
        });
      });
      if (!allowed) throw new Error(`Extra folder not allowlisted: ${dir}`);
    }
    if (!out.includes(dir)) out.push(dir);
  }
  return out;
}

function assertUsableCwd(path: string, label: string): void {
  if (!isUsableCwd(path)) {
    throw new Error(
      `Invalid ${label}: "${path}". Agents need a real folder to work in — "/" and missing folders are refused ` +
        `so an agent can't roam the whole disk. Pick a project, or type a folder such as ~/Projects/my-repo.`,
    );
  }
}

export { DEFAULT_CONFIG_PATH, DEFAULT_DATA_DIR };
