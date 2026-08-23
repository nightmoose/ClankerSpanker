import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { OUTBOX_DIR } from "./tools/paths.js";

export interface OutboxItem {
  filename: string;
  relPath: string;
  updatedAt: string;
  bytes: number;
  content: string;
}

const MAX_ITEMS = 40;
const MAX_CONTENT = 48 * 1024;

/** Newest-first markdown drafts under `<cwd>/.bot-outbox/`. */
export function listOutbox(cwd: string): OutboxItem[] {
  const dir = join(cwd, OUTBOX_DIR);
  if (!existsSync(dir)) return [];
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const rows: Array<OutboxItem & { mtime: number }> = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    if (!name.endsWith(".md")) continue;
    const abs = join(dir, name);
    try {
      const st = statSync(abs);
      if (!st.isFile()) continue;
      const raw = readFileSync(abs);
      const sliced = raw.length > MAX_CONTENT ? raw.subarray(0, MAX_CONTENT) : raw;
      rows.push({
        filename: name,
        relPath: `${OUTBOX_DIR}/${name}`,
        updatedAt: st.mtime.toISOString(),
        bytes: st.size,
        content: sliced.toString("utf8"),
        mtime: st.mtimeMs,
      });
    } catch {
      /* skip unreadable */
    }
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  return rows.slice(0, MAX_ITEMS).map(({ mtime: _m, ...item }) => item);
}
