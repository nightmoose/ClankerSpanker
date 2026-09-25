import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { ProjectInfo } from "./types.js";

/**
 * Project ↔ folder resolution (RFC-032).
 *
 * Projects were a label picked in the composer: sessions started with only a
 * folder, and every Claude/Grok session imported from disk, had no project
 * (63 of 169 on 2026-09-25). And `~/journeyquest` was stored literally —
 * Node's resolve() does not expand `~`, so that project could never match.
 */

/** `~` / `~/x` → absolute. Anything else is returned unchanged. */
export function expandHome(p: string, home = homedir()): string {
  const t = p.trim();
  if (t === "~") return home;
  if (t.startsWith("~/")) return join(home, t.slice(2));
  return t;
}

/** Filesystems here are case-insensitive by default (APFS); compare that way. */
function key(p: string): string {
  const r = resolve(p);
  return (r.length > 1 && r.endsWith(sep) ? r.slice(0, -1) : r).toLowerCase();
}

function contains(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent === sep ? parent : parent + sep);
}

/**
 * The project whose path is the longest prefix of `cwd`. Archived projects are
 * ignored. When two different projects claim that same longest path the
 * answer is ambiguous and nothing is guessed (fix the overlap instead).
 */
export function inferProjectId(
  projects: Array<Pick<ProjectInfo, "id" | "paths" | "path"> & { archived?: boolean }>,
  cwd: string | undefined,
): string | undefined {
  if (!cwd) return undefined;
  const target = key(expandHome(cwd));
  let bestLen = -1;
  let best: string[] = [];
  for (const p of projects) {
    if (p.archived) continue;
    const paths = (p.paths?.length ? p.paths : [p.path]).filter(Boolean);
    for (const raw of paths) {
      const k = key(expandHome(raw));
      if (!contains(k, target)) continue;
      if (k.length > bestLen) {
        bestLen = k.length;
        best = [p.id];
      } else if (k.length === bestLen && !best.includes(p.id)) {
        best.push(p.id);
      }
    }
  }
  return best.length === 1 ? best[0] : undefined;
}

/** Paths must be absolute after `~` expansion. Returns the offending paths. */
export function nonAbsolutePaths(paths: string[]): string[] {
  return paths.filter((p) => !isAbsolute(expandHome(p)));
}

/**
 * Human-readable overlaps between `candidate` and the other projects: the
 * same folder, or one project's folder inside another's.
 */
export function projectOverlapWarnings(
  candidate: Pick<ProjectInfo, "id" | "paths">,
  others: Array<Pick<ProjectInfo, "id" | "name" | "paths"> & { archived?: boolean }>,
): string[] {
  const out: string[] = [];
  for (const o of others) {
    if (o.id === candidate.id || o.archived) continue;
    for (const a of candidate.paths) {
      for (const b of o.paths ?? []) {
        const ka = key(expandHome(a));
        const kb = key(expandHome(b));
        if (ka === kb) out.push(`${a} is also a path of "${o.name}"`);
        else if (contains(kb, ka)) out.push(`${a} is inside "${o.name}" (${b})`);
        else if (contains(ka, kb)) out.push(`${a} contains "${o.name}" (${b})`);
      }
    }
  }
  return out;
}
