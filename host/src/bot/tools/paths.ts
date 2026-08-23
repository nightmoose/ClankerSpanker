import { existsSync, statSync } from "node:fs";
import { resolve, relative, sep, join } from "node:path";

export const OUTBOX_DIR = ".bot-outbox";

export function resolveUnderCwd(cwd: string, requested: string): string {
  const base = resolve(cwd);
  const target = resolve(base, requested);
  const rel = relative(base, target);
  if (rel.startsWith("..") || rel === ".." || (rel.length > 0 && rel.split(sep)[0] === "..")) {
    throw new Error(`Path escapes cwd: ${requested}`);
  }
  return target;
}

export function assertOutboxPath(cwd: string, requested: string): string {
  const target = resolveUnderCwd(cwd, requested);
  const outbox = resolve(cwd, OUTBOX_DIR);
  const rel = relative(outbox, target);
  if (rel.startsWith("..") || rel === "..") {
    throw new Error(`write_file is confined to ${OUTBOX_DIR}/ (got ${requested})`);
  }
  return target;
}

export function outboxDir(cwd: string): string {
  return join(resolve(cwd), OUTBOX_DIR);
}

export function isExistingDir(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}
