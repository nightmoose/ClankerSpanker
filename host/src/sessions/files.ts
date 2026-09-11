import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import type {
  DispatchSession,
  HostConfigFile,
  SessionFileContent,
  SessionFileEntry,
} from "../types.js";

export const MAX_FILE_BYTES = 1_500_000;
export const MAX_LIST = 250;

const TEXT_EXTS = new Set([
  "md",
  "markdown",
  "txt",
  "text",
  "json",
  "jsonl",
  "yaml",
  "yml",
  "toml",
  "xml",
  "html",
  "htm",
  "css",
  "scss",
  "less",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "swift",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "kts",
  "c",
  "h",
  "cpp",
  "cc",
  "cxx",
  "hpp",
  "hh",
  "cs",
  "sh",
  "bash",
  "zsh",
  "fish",
  "ps1",
  "sql",
  "graphql",
  "proto",
  "gradle",
  "plist",
  "gitignore",
  "dockerignore",
  "editorconfig",
  "env",
  "ini",
  "cfg",
  "conf",
  "log",
  "diff",
  "patch",
  "csv",
  "tsv",
  "r",
  "lua",
  "php",
  "ex",
  "exs",
  "hs",
  "elm",
  "vue",
  "svelte",
  "lock",
]);

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "heic"]);

function mimeFor(ext: string): string {
  const e = ext.toLowerCase();
  if (e === "png") return "image/png";
  if (e === "jpg" || e === "jpeg") return "image/jpeg";
  if (e === "gif") return "image/gif";
  if (e === "webp") return "image/webp";
  if (e === "svg") return "image/svg+xml";
  if (e === "json") return "application/json";
  if (e === "md" || e === "markdown") return "text/markdown";
  if (e === "html" || e === "htm") return "text/html";
  if (e === "css") return "text/css";
  if (e === "js" || e === "mjs" || e === "cjs") return "text/javascript";
  if (IMAGE_EXTS.has(e)) return "application/octet-stream";
  if (TEXT_EXTS.has(e)) return "text/plain";
  return "application/octet-stream";
}

function addRoot(roots: string[], p?: string): void {
  if (!p) return;
  const r = resolve(p);
  if (!roots.includes(r)) roots.push(r);
}

/** Absolute dirs a session may list/read: cwd, extraDirs, attachment stores. */
export function sessionFileRoots(session: DispatchSession, config: HostConfigFile): string[] {
  const roots: string[] = [];
  addRoot(roots, session.cwd);
  for (const d of session.extraDirs ?? []) addRoot(roots, d);
  addRoot(roots, join(config.dataDir, "sessions", session.id, "attachments"));
  if (session.projectId) {
    addRoot(roots, join(config.dataDir, "projects", session.projectId, "attachments"));
  }
  return roots;
}

/** Resolve a path, walking up to an existing ancestor so /var vs /private/var matches. */
function realOrResolve(p: string): string {
  const abs = resolve(p);
  try {
    if (existsSync(abs)) return realpathSync(abs);
  } catch {
    /* dangling symlink */
  }
  const tail: string[] = [];
  let cur = abs;
  while (cur !== dirname(cur)) {
    tail.unshift(basename(cur));
    cur = dirname(cur);
    try {
      if (existsSync(cur)) return join(realpathSync(cur), ...tail);
    } catch {
      break;
    }
  }
  return abs;
}

export function isPathAllowed(absPath: string, roots: string[]): boolean {
  const resolved = realOrResolve(absPath);
  return roots.some((root) => {
    const r = realOrResolve(root);
    return resolved === r || resolved.startsWith(r + sep);
  });
}

function looksText(buf: Buffer, ext: string): boolean {
  if (TEXT_EXTS.has(ext.toLowerCase())) return true;
  if (IMAGE_EXTS.has(ext.toLowerCase())) return false;
  const sample = buf.subarray(0, Math.min(buf.length, 800));
  if (sample.includes(0)) return false;
  let weird = 0;
  for (const b of sample) {
    if (b < 9 || (b > 13 && b < 32) || b === 127) weird += 1;
  }
  return weird / Math.max(sample.length, 1) < 0.05;
}

function listDirFiles(dir: string, kind: SessionFileEntry["kind"], out: SessionFileEntry[]): void {
  if (!existsSync(dir) || out.length >= MAX_LIST) return;
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (out.length >= MAX_LIST) return;
    if (name.startsWith(".")) continue;
    const full = join(dir, name);
    try {
      const st = statSync(full);
      if (!st.isFile()) continue;
      out.push({
        path: full,
        kind,
        title: name,
        updatedAt: st.mtime.toISOString(),
      });
    } catch {
      /* skip */
    }
  }
}

/** Prompt prefix so Grok / Antigravity know extra folders exist. */
export function extraDirsAgentNote(dirs?: string[]): string {
  const clean = [...new Set((dirs ?? []).map((d) => String(d ?? "").trim()).filter(Boolean))];
  if (!clean.length) return "";
  return (
    `[Additional workspace folders besides cwd — you may read and edit these:]\n` +
    clean.map((d) => `- ${d}`).join("\n") +
    "\n\n"
  );
}

export function listSessionFiles(
  session: DispatchSession,
  config: HostConfigFile,
): SessionFileEntry[] {
  const out: SessionFileEntry[] = [];
  const seen = new Set<string>();

  const push = (entry: SessionFileEntry) => {
    const key = resolve(entry.path);
    if (seen.has(key) || out.length >= MAX_LIST) return;
    seen.add(key);
    out.push({ ...entry, path: key, title: entry.title ?? basename(key) });
  };

  if (session.cwd) {
    push({ path: session.cwd, kind: "folder", title: basename(session.cwd) || session.cwd });
  }
  for (const dir of session.extraDirs ?? []) {
    push({ path: dir, kind: "folder", title: basename(dir) || dir });
  }

  for (const tool of session.toolCalls ?? []) {
    for (const loc of tool.locations ?? []) {
      const raw = String(loc.path ?? "").trim();
      if (!raw) continue;
      const abs = raw.startsWith("/") ? resolve(raw) : resolve(session.cwd, raw);
      try {
        const st = statSync(abs);
        push({
          path: abs,
          kind: st.isDirectory() ? "folder" : "file",
          title: basename(abs),
          updatedAt: st.mtime.toISOString(),
        });
      } catch {
        push({ path: abs, kind: "file", title: basename(abs) });
      }
    }
  }

  listDirFiles(join(config.dataDir, "sessions", session.id, "attachments"), "attachment", out);
  if (session.projectId) {
    listDirFiles(
      join(config.dataDir, "projects", session.projectId, "attachments"),
      "attachment",
      out,
    );
  }

  return out.slice(0, MAX_LIST);
}

export function readSessionFile(
  session: DispatchSession,
  config: HostConfigFile,
  requestedPath: string,
): SessionFileContent {
  const raw = String(requestedPath ?? "").trim();
  if (!raw) throw new Error("path is required");
  const abs = raw.startsWith("/") ? resolve(raw) : resolve(session.cwd, raw);
  const roots = sessionFileRoots(session, config);
  if (!isPathAllowed(abs, roots)) {
    throw new Error("Path is outside this session's workspace");
  }
  if (!existsSync(abs)) throw new Error("File not found");
  const st = statSync(abs);
  if (st.isDirectory()) {
    throw new Error("Path is a directory");
  }
  const size = st.size;
  const name = basename(abs);
  const ext = extname(abs).replace(/^\./, "");
  const mimeType = mimeFor(ext);
  const cap = Math.min(size, MAX_FILE_BYTES);
  const buf = readFileSync(abs).subarray(0, cap);
  const truncated = size > MAX_FILE_BYTES;
  if (looksText(buf, ext)) {
    return {
      path: abs,
      name,
      mimeType: mimeType.startsWith("text/") || mimeType === "application/json" ? mimeType : "text/plain",
      size,
      encoding: "utf8",
      text: buf.toString("utf8"),
      truncated,
      binary: false,
    };
  }
  return {
    path: abs,
    name,
    mimeType,
    size,
    encoding: "base64",
    data: buf.toString("base64"),
    truncated,
    binary: true,
  };
}
