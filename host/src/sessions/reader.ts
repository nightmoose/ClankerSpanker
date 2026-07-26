import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { findClaudeBinaryCandidates, firstExistingBinary } from "../platform.js";

const execFileAsync = promisify(execFile);

export type SessionSource = "grok" | "claude";

export interface DiskSessionHint {
  id: string;
  source: SessionSource;
  cwd?: string;
  title?: string;
  updatedAt?: string;
  model?: string;
  /** Absolute path to Claude jsonl when source=claude */
  transcriptPath?: string;
}

/** Best-effort scan of ~/.grok/sessions for display / resume hints. */
export function listDiskSessions(limit = 40): DiskSessionHint[] {
  const root = join(homedir(), ".grok", "sessions");
  if (!existsSync(root)) return [];

  const results: DiskSessionHint[] = [];

  for (const group of readdirSync(root)) {
    if (group.startsWith(".") || group.endsWith(".sqlite")) continue;
    const groupPath = join(root, group);
    let st;
    try {
      st = statSync(groupPath);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    for (const sid of readdirSync(groupPath)) {
      const summaryPath = join(groupPath, sid, "summary.json");
      if (!existsSync(summaryPath)) continue;
      try {
        const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as {
          info?: { session_id?: string; cwd?: string };
          session_summary?: string;
          generated_title?: string;
          updated_at?: string;
          current_model_id?: string;
        };
        results.push({
          id: summary.info?.session_id ?? sid,
          source: "grok",
          cwd: summary.info?.cwd,
          title: summary.generated_title ?? summary.session_summary,
          updatedAt: summary.updated_at,
          model: summary.current_model_id,
        });
      } catch {
        /* skip corrupt */
      }
    }
  }

  return results
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
    .slice(0, limit);
}

/**
 * Claude Code sessions live at:
 *   ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl
 * Encoding: absolute path with non-alphanumerics → `-` (leading slash becomes leading `-`).
 */
export function listClaudeSessions(limit = 40): DiskSessionHint[] {
  const root = join(homedir(), ".claude", "projects");
  if (!existsSync(root)) return [];

  const results: DiskSessionHint[] = [];

  for (const proj of readdirSync(root)) {
    if (proj.startsWith(".")) continue;
    const projPath = join(root, proj);
    let st;
    try {
      st = statSync(projPath);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    const cwd = decodeClaudeProjectDir(proj);

    for (const name of readdirSync(projPath)) {
      if (!name.endsWith(".jsonl")) continue;
      if (name.includes("agent-") || name.includes("subagent")) continue;
      const filePath = join(projPath, name);
      let fst;
      try {
        fst = statSync(filePath);
      } catch {
        continue;
      }
      if (!fst.isFile() || fst.size < 20) continue;

      const id = name.replace(/\.jsonl$/, "");
      // Skip non-UUID-ish names
      if (!/^[0-9a-f-]{20,}$/i.test(id)) continue;

      results.push({
        id,
        source: "claude",
        cwd,
        title: undefined, // filled below lazily-ish
        updatedAt: new Date(fst.mtimeMs).toISOString(),
        transcriptPath: filePath,
        model: "claude",
      });
    }
  }

  // Sort and hydrate titles for the newest N only (cheap enough)
  results.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  const top = results.slice(0, limit);
  for (const s of top) {
    if (s.transcriptPath) {
      s.title = peekClaudeTitle(s.transcriptPath) ?? `Claude ${s.id.slice(0, 8)}`;
    }
  }
  return top;
}

/** Reverse Claude's project folder encoding; verify path exists when possible. */
export function decodeClaudeProjectDir(encoded: string): string | undefined {
  if (!encoded.startsWith("-")) return undefined;
  // Naive reverse: -Users-foo-bar → /Users/foo/bar
  let candidate = "/" + encoded.slice(1).replace(/-/g, "/");
  // Collapse accidental double slashes from "--" encodings
  candidate = candidate.replace(/\/{2,}/g, "/");
  if (existsSync(candidate)) return candidate;

  // Heuristic: common home Projects paths with hyphens in names
  const home = homedir();
  const guesses = [
    candidate,
    candidate.replace("/Claude/Projects/", "/Claude Projects/"),
    join(home, "Projects", basename(candidate)),
    join(home, "Documents", "Claude Projects", basename(candidate)),
  ];
  for (const g of guesses) {
    if (existsSync(g)) return g;
  }
  // Return naive path for display even if missing
  return candidate;
}

function peekClaudeTitle(jsonlPath: string): string | undefined {
  try {
    const raw = readFileSync(jsonlPath, "utf8");
    // Only scan start of file for first user message (up to ~200KB)
    const head = raw.slice(0, 200_000);
    for (const line of head.split("\n")) {
      if (!line.trim()) continue;
      let o: Record<string, unknown>;
      try {
        o = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const text = extractUserText(o);
      if (text) {
        const line0 = text.trim().split("\n")[0] ?? text;
        return line0.length > 90 ? line0.slice(0, 87) + "…" : line0;
      }
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

function extractUserText(o: Record<string, unknown>): string | undefined {
  if (o.type === "queue-operation" && typeof o.content === "string") {
    return o.content;
  }
  if (o.type === "user") {
    const msg = o.message as { role?: string; content?: unknown } | undefined;
    return contentToText(msg?.content ?? o.content);
  }
  return undefined;
}

function contentToText(content: unknown): string | undefined {
  if (typeof content === "string" && content.trim()) return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const c of content) {
      if (typeof c === "string") parts.push(c);
      else if (c && typeof c === "object" && (c as { type?: string }).type === "text") {
        parts.push(String((c as { text?: string }).text ?? ""));
      }
    }
    const t = parts.join("\n").trim();
    return t || undefined;
  }
  return undefined;
}

/**
 * Pull a compact conversation excerpt from a Claude session jsonl
 * for handing off to Grok (or display).
 */
export async function extractClaudeContext(
  jsonlPath: string,
  maxChars = 14_000,
): Promise<{ messages: Array<{ role: string; text: string }>; excerpt: string }> {
  const messages: Array<{ role: string; text: string }> = [];
  if (!existsSync(jsonlPath)) return { messages, excerpt: "" };

  const rl = createInterface({ input: createReadStream(jsonlPath, { encoding: "utf8" }) });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (o.type === "user") {
      const msg = o.message as { content?: unknown } | undefined;
      const text = contentToText(msg?.content ?? o.content);
      if (text) messages.push({ role: "user", text: text.slice(0, 4000) });
    } else if (o.type === "assistant") {
      const msg = o.message as { content?: unknown } | undefined;
      const text = contentToText(msg?.content ?? o.content);
      if (text) messages.push({ role: "assistant", text: text.slice(0, 4000) });
    }
  }

  // Keep the tail of the conversation (most relevant for resume)
  let excerpt = "";
  const tail = messages.slice(-24);
  for (const m of tail) {
    const block = `${m.role.toUpperCase()}:\n${m.text}\n\n`;
    if (excerpt.length + block.length > maxChars) {
      // prefer keeping later messages
      excerpt = (excerpt + block).slice(-maxChars);
    } else {
      excerpt += block;
    }
  }
  return { messages: tail, excerpt: excerpt.trim() };
}

export async function gitDiff(cwd: string, maxBytes = 200_000): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["diff", "HEAD"], {
      cwd,
      maxBuffer: maxBytes,
      timeout: 15_000,
    });
    return stdout.slice(0, maxBytes);
  } catch (err) {
    const e = err as { stdout?: string; message?: string };
    if (e.stdout) return String(e.stdout).slice(0, maxBytes);
    return `// Unable to read git diff: ${e.message ?? err}`;
  }
}

export function findClaudeBinary(): string {
  return firstExistingBinary(findClaudeBinaryCandidates(), "claude");
}
