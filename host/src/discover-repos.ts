import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import type { ProjectInfo } from "./types.js";

/**
 * "Import from disk" (RFC-036). Used to be a hardcoded list of one Mac's repos
 * (~/Projects/GrokDispatch, ~/mercenary, …), so every other host found
 * nothing. Now: git repositories directly in $HOME, and up to two levels under
 * the usual code roots.
 */
const SKIP = new Set(["node_modules", "Library", "Applications", "Pictures", "Movies", "Music", "Public"]);
export const DISCOVER_LIMIT = 100;

export function codeRoots(home = homedir()): Array<{ dir: string; depth: number }> {
  return [
    { dir: home, depth: 1 },
    ...["Projects", "projects", "Developer", "dev", "code", "src", "Documents", "GitHub", "repos"].map((d) => ({
      dir: join(home, d),
      depth: 2,
    })),
  ];
}

function isRepo(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

function subdirs(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const n of names) {
    if (n.startsWith(".") || SKIP.has(n)) continue;
    const full = join(dir, n);
    try {
      if (statSync(full).isDirectory()) out.push(full);
    } catch {
      /* unreadable */
    }
  }
  return out.sort();
}

/** Same folder on disk? (`~/Projects` and `~/projects` are one folder on APFS.) */
function inode(dir: string): string | undefined {
  try {
    const st = statSync(dir);
    return `${st.dev}:${st.ino}`;
  } catch {
    return undefined;
  }
}

export function discoverGitRepos(home = homedir(), limit = DISCOVER_LIMIT): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const walk = (dir: string, depth: number) => {
    if (found.length >= limit || depth === 0) return;
    for (const d of subdirs(dir)) {
      if (found.length >= limit) return;
      const id = inode(d);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      if (isRepo(d)) found.push(d); // don't descend into a repo
      else walk(d, depth - 1);
    }
  };
  const visitedRoots = new Set<string>();
  for (const { dir, depth } of codeRoots(home)) {
    const id = existsSync(dir) ? inode(dir) : undefined;
    if (!id || visitedRoots.has(id)) continue;
    visitedRoots.add(id);
    walk(dir, depth);
  }
  return found;
}

/** Stable, readable id: folder slug + short hash of the full path (no collisions). */
export function projectIdForPath(path: string): string {
  const slug = basename(path).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
  const h = createHash("sha256").update(path).digest("hex").slice(0, 6);
  return `${slug}-${h}`;
}

export function discoverRepoProjects(home = homedir()): ProjectInfo[] {
  return discoverGitRepos(home).map((p) => ({ id: projectIdForPath(p), name: basename(p), path: p, paths: [p] }));
}
