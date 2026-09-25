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

export function codeRoots(home = homedir(), extra: string[] = []): Array<{ dir: string; depth: number }> {
  return [
    { dir: home, depth: 1 },
    ...[
      "Projects",
      "projects",
      "Developer",
      "dev",
      "code",
      "src",
      "Documents",
      "GitHub",
      "repos",
      // RFC-037: GitHub Desktop clones to ~/Documents/GitHub/<org>/<repo>.
      "Documents/GitHub",
      "Documents/Projects",
      "Documents/Code",
    ].map((d) => ({ dir: join(home, d), depth: 2 })),
    // RFC-037: config.json "discoverRoots" — machine-specific folders.
    ...extra.map((d) => ({ dir: d.startsWith("~/") ? join(home, d.slice(2)) : d, depth: 2 })),
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

export function discoverGitRepos(home = homedir(), limit = DISCOVER_LIMIT, extraRoots: string[] = []): string[] {
  const found: string[] = [];
  const repos = new Set<string>();
  // inode → deepest remaining depth it was walked with. A shallow pass over
  // ~/Documents must not stop the deeper ~/Documents/GitHub pass (RFC-037).
  const walked = new Map<string, number>();
  const walk = (dir: string, depth: number) => {
    if (found.length >= limit || depth === 0) return;
    for (const d of subdirs(dir)) {
      if (found.length >= limit) return;
      const id = inode(d);
      if (!id) continue;
      if (isRepo(d)) {
        // don't descend into a repo
        if (!repos.has(id)) {
          repos.add(id);
          found.push(d);
        }
        continue;
      }
      const remaining = depth - 1;
      if ((walked.get(id) ?? -1) >= remaining) continue;
      walked.set(id, remaining);
      walk(d, remaining);
    }
  };
  const visitedRoots = new Set<string>();
  for (const { dir, depth } of codeRoots(home, extraRoots)) {
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

export function discoverRepoProjects(home = homedir(), extraRoots: string[] = []): ProjectInfo[] {
  return discoverGitRepos(home, DISCOVER_LIMIT, extraRoots).map((p) => ({ id: projectIdForPath(p), name: basename(p), path: p, paths: [p] }));
}
