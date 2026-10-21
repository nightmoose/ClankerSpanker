import { copyFileSync, existsSync, fstatSync, readdirSync, renameSync, statSync, truncateSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * RFC-068: keep the gateway's own log files bounded.
 *
 * launchd opens StandardOutPath / StandardErrorPath in append mode, so the
 * files grow forever (51 MB on the owner's Mac on 2026-10-20). The gateway
 * cannot reopen launchd's descriptors, so it rotates with copy-then-truncate:
 * copy `x.log` to `x.log.1` (older copies shift to .2, .3), then truncate
 * `x.log` in place. Because the descriptor is append-only, the next write
 * lands at the start of the emptied file.
 *
 * Only a file that IS this process's stdout or stderr (same device and
 * inode) is touched, so a standalone install, another gateway, or a file the
 * operator points elsewhere is never rotated by mistake. Under systemd the
 * output goes to the journal, nothing matches, and this is a no-op.
 */

export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_KEEP = 3;
export const CHECK_INTERVAL_MS = 10 * 60 * 1000;

type Ident = { dev: number; ino: number };

export function fdIdentity(fd: number): Ident | null {
  try {
    const st = fstatSync(fd);
    return st.isFile() ? { dev: st.dev, ino: st.ino } : null;
  } catch {
    return null;
  }
}

/** Log files under `dir` that are this process's stdout or stderr. */
export function ownLogFiles(dir: string, fds: Array<Ident | null>): string[] {
  const wanted = fds.filter((f): f is Ident => f !== null);
  if (wanted.length === 0 || !existsSync(dir)) return [];
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".log")) continue;
    const path = join(dir, name);
    try {
      const st = statSync(path);
      if (st.isFile() && wanted.some((w) => w.dev === st.dev && w.ino === st.ino)) found.push(path);
    } catch {
      // vanished between readdir and stat
    }
  }
  return found;
}

/** Rotate `path` if it is larger than `maxBytes`. Returns true when rotated. */
export function rotateIfLarge(path: string, maxBytes = DEFAULT_MAX_BYTES, keep = DEFAULT_KEEP): boolean {
  if (maxBytes <= 0 || keep < 1) return false;
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return false;
  }
  if (size <= maxBytes) return false;
  const oldest = `${path}.${keep}`;
  if (existsSync(oldest)) unlinkSync(oldest);
  for (let i = keep - 1; i >= 1; i--) {
    const from = `${path}.${i}`;
    if (existsSync(from)) renameSync(from, `${path}.${i + 1}`);
  }
  copyFileSync(path, `${path}.1`);
  truncateSync(path, 0);
  return true;
}

export type LogRotationOptions = {
  maxBytes?: number;
  keep?: number;
  dir?: string;
  intervalMs?: number;
};

/** Check now and then every `intervalMs`. Returns a stop function. */
export function startLogRotation(opts: LogRotationOptions = {}): () => void {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  if (maxBytes <= 0) return () => {};
  const dir = opts.dir ?? join(homedir(), "Library", "Logs");
  const keep = opts.keep ?? DEFAULT_KEEP;
  const check = () => {
    for (const path of ownLogFiles(dir, [fdIdentity(1), fdIdentity(2)])) {
      try {
        if (rotateIfLarge(path, maxBytes, keep)) {
          console.log(`[logs] rotated ${path} (over ${Math.round(maxBytes / 1024 / 1024)} MB, keeping ${keep})`);
        }
      } catch (err) {
        console.warn(`[logs] could not rotate ${path}: ${err instanceof Error ? err.message : err}`);
      }
    }
  };
  check();
  const timer = setInterval(check, opts.intervalMs ?? CHECK_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
