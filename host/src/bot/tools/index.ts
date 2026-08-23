import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import type { ToolSpec } from "../protocol.js";
import type { FetchLike } from "../protocol.js";
import { assertOutboxPath, OUTBOX_DIR, resolveUnderCwd } from "./paths.js";

export interface ToolContext {
  cwd: string;
  sessionId: string;
  fetchImpl: FetchLike;
}

export interface BotTool {
  spec: ToolSpec;
  /** Auto-run; never parks an approval. */
  auto: boolean;
  /** Always park, even if autoApproveKinds includes this kind. */
  alwaysApprove: boolean;
  /** Maps onto PendingApproval.kind / autoApproveKinds. */
  kind: string;
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
}

const READ_CAP = 256 * 1024;
const FETCH_CAP = 512 * 1024;
const MAX_GREP_HITS = 80;
const MAX_LIST = 400;

export const V1_TOOL_NAMES = [
  "read_file",
  "grep",
  "list_dir",
  "web_fetch",
  "web_search",
  "write_file",
  "propose_outbound",
] as const;

export function allTools(): BotTool[] {
  return [readFileTool, grepTool, listDirTool, webFetchTool, webSearchTool, writeFileTool, outboundTool];
}

export function toolsForAllowlist(names?: string[]): BotTool[] {
  const all = allTools();
  if (!names?.length) return all;
  const want = new Set(names);
  const picked = all.filter((t) => want.has(t.spec.name));
  return picked.length ? picked : all;
}

const readFileTool: BotTool = {
  auto: true,
  alwaysApprove: false,
  kind: "read",
  spec: {
    name: "read_file",
    description: "Read a UTF-8 text file under the project cwd. Returns a slice of the file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the project cwd" },
        offset: { type: "integer", description: "1-based start line (optional)" },
        limit: { type: "integer", description: "Max lines to return (optional)" },
      },
      required: ["path"],
    },
  },
  async execute(args, ctx) {
    const path = requireString(args, "path");
    const abs = resolveUnderCwd(ctx.cwd, path);
    let raw: string;
    try {
      const buf = readFileSync(abs);
      if (buf.length > READ_CAP) {
        raw = buf.subarray(0, READ_CAP).toString("utf8") + `\n… truncated at ${READ_CAP} bytes`;
      } else {
        raw = buf.toString("utf8");
      }
    } catch (err) {
      throw new Error(`read_file failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const lines = raw.split(/\n/);
    const offset = Math.max(1, Number(args.offset) || 1);
    const limit = Number(args.limit) > 0 ? Number(args.limit) : lines.length;
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    return slice.map((l, i) => `${offset + i}|${l}`).join("\n");
  },
};

const grepTool: BotTool = {
  auto: true,
  alwaysApprove: false,
  kind: "search",
  spec: {
    name: "grep",
    description: "Search files under cwd for a regex (case-insensitive). Skips node_modules, .git, target, dist.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string", description: "Subdirectory or file relative to cwd (default: .)" },
        glob: { type: "string", description: "Optional filename suffix filter, e.g. .md" },
      },
      required: ["pattern"],
    },
  },
  async execute(args, ctx) {
    const pattern = requireString(args, "pattern");
    let re: RegExp;
    try {
      re = new RegExp(pattern, "i");
    } catch {
      throw new Error(`Invalid regex: ${pattern}`);
    }
    const root = resolveUnderCwd(ctx.cwd, String(args.path ?? "."));
    const glob = typeof args.glob === "string" ? args.glob : "";
    const hits: string[] = [];
    walk(root, ctx.cwd, (file) => {
      if (hits.length >= MAX_GREP_HITS) return false;
      if (glob && !file.endsWith(glob) && extname(file) !== glob) return true;
      let text: string;
      try {
        const st = statSync(file);
        if (!st.isFile() || st.size > READ_CAP) return true;
        text = readFileSync(file, "utf8");
      } catch {
        return true;
      }
      const lines = text.split(/\n/);
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i]!)) {
          hits.push(`${relative(ctx.cwd, file)}:${i + 1}:${lines[i]!.slice(0, 240)}`);
          if (hits.length >= MAX_GREP_HITS) break;
        }
      }
      return hits.length < MAX_GREP_HITS;
    });
    return hits.length ? hits.join("\n") : "(no matches)";
  },
};

const listDirTool: BotTool = {
  auto: true,
  alwaysApprove: false,
  kind: "read",
  spec: {
    name: "list_dir",
    description: "List files and directories under a cwd-relative path.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory relative to cwd (default: .)" },
        recursive: { type: "boolean" },
      },
    },
  },
  async execute(args, ctx) {
    const dir = resolveUnderCwd(ctx.cwd, String(args.path ?? "."));
    const recursive = Boolean(args.recursive);
    const entries: string[] = [];
    const walkDir = (d: string): void => {
      if (entries.length >= MAX_LIST) return;
      let names: string[];
      try {
        names = readdirSync(d);
      } catch (err) {
        throw new Error(`list_dir failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      for (const name of names) {
        if (SKIP_DIR.has(name)) continue;
        const full = join(d, name);
        let isDir = false;
        try {
          isDir = statSync(full).isDirectory();
        } catch {
          continue;
        }
        entries.push(`${relative(ctx.cwd, full)}${isDir ? "/" : ""}`);
        if (recursive && isDir) walkDir(full);
        if (entries.length >= MAX_LIST) break;
      }
    };
    walkDir(dir);
    return entries.join("\n") || "(empty)";
  },
};

const webFetchTool: BotTool = {
  auto: true,
  alwaysApprove: false,
  kind: "fetch",
  spec: {
    name: "web_fetch",
    description:
      "Fetch a public http(s) URL and return text. No cookies, no login. Private/loopback addresses are rejected.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string" },
      },
      required: ["url"],
    },
  },
  async execute(args, ctx) {
    const url = requireString(args, "url");
    const res = await publicFetch(ctx.fetchImpl, url);
    const buf = Buffer.from(await res.arrayBuffer());
    const sliced = buf.length > FETCH_CAP ? buf.subarray(0, FETCH_CAP) : buf;
    const ctype = res.headers.get("content-type") ?? "";
    let body = sliced.toString("utf8");
    if (ctype.includes("html")) body = stripHtml(body);
    return `HTTP ${res.status} ${url}\n${body}`;
  },
};

const webSearchTool: BotTool = {
  auto: true,
  alwaysApprove: false,
  kind: "search",
  spec: {
    name: "web_search",
    description:
      "Public web search. Uses Hacker News (Algolia) and Wikipedia. DuckDuckGo HTML is blocked from this host. Follow interesting hits with web_fetch. For X/Twitter, web_fetch a specific post URL — site:x.com search is not available here.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    },
  },
  async execute(args, ctx) {
    const query = requireString(args, "query");
    const sections: string[] = [];
    try {
      const hn = await searchHackerNews(ctx.fetchImpl, query);
      if (hn) sections.push(hn);
    } catch (err) {
      sections.push(`HN search failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      const wiki = await searchWikipedia(ctx.fetchImpl, query);
      if (wiki) sections.push(wiki);
    } catch (err) {
      sections.push(`Wikipedia search failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!sections.length) {
      return [
        `No live search hits for ${JSON.stringify(query)}. HTML search engines challenge this host.`,
        "Do NOT conclude the market is empty. web_fetch specific URLs instead. Starting points:",
        ...SEARCH_FALLBACK_URLS.map((u) => `- ${u}`),
      ].join("\n");
    }
    return sections.join("\n\n");
  },
};

const SEARCH_FALLBACK_URLS = [
  "https://www.confluent.io/blog/schema-registry-kafka-stream-processing-yes-virginia-you-really-need-one/",
  "https://www.conduktor.io/blog/a-schema-is-not-a-contract/",
  "https://www.confluent.io/blog/data-contracts-kafka/",
  "https://developer.confluent.io/courses/governing-data-streams/data-contracts/",
];

const writeFileTool: BotTool = {
  auto: true,
  alwaysApprove: false,
  kind: "edit",
  spec: {
    name: "write_file",
    description: `Write a UTF-8 file under ${OUTBOX_DIR}/ only. Auto-runs (sandboxed); review in the Bots outbox.`,
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: `Relative path; must be inside ${OUTBOX_DIR}/`,
        },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  async execute(args, ctx) {
    const path = requireString(args, "path");
    const content = requireString(args, "content");
    const abs = assertOutboxPath(ctx.cwd, path);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf8");
    return `Wrote ${relative(ctx.cwd, abs)} (${Buffer.byteLength(content, "utf8")} bytes)`;
  },
};

export interface OutboundPayload {
  channel: string;
  to: string;
  subject?: string;
  body: string;
  reason: string;
}

const outboundTool: BotTool = {
  auto: true,
  alwaysApprove: false,
  kind: "outbound",
  spec: {
    name: "propose_outbound",
    description:
      "Write an email/X/LinkedIn draft to .bot-outbox/ for later review. NEVER sends. Does not pause the run.",
    parameters: {
      type: "object",
      properties: {
        channel: { type: "string", description: "email | x | linkedin" },
        to: { type: "string", description: "Recipient handle, URL, or email" },
        subject: { type: "string" },
        body: { type: "string" },
        reason: { type: "string", description: "Why this lead, in one or two sentences" },
      },
      required: ["channel", "to", "body", "reason"],
    },
  },
  async execute(args, ctx) {
    const payload = parseOutbound(args);
    const id = randomUUID().slice(0, 8);
    const day = new Date().toISOString().slice(0, 10);
    const rel = `${OUTBOX_DIR}/${day}-${id}.md`;
    const abs = assertOutboxPath(ctx.cwd, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    const md = renderOutboundMarkdown(payload, {
      status: "draft",
      sessionId: ctx.sessionId,
      approvedAt: new Date().toISOString(),
    });
    writeFileSync(abs, md, "utf8");
    return `Queued outbound draft at ${rel} (not sent — review in outbox)`;
  },
};

export function parseOutbound(args: Record<string, unknown>): OutboundPayload {
  return {
    channel: requireString(args, "channel"),
    to: requireString(args, "to"),
    subject: typeof args.subject === "string" ? args.subject : undefined,
    body: requireString(args, "body"),
    reason: requireString(args, "reason"),
  };
}

export function renderOutboundMarkdown(
  payload: OutboundPayload,
  meta: { status: string; sessionId: string; approvedAt: string },
): string {
  const header = [
    "---",
    `status: ${meta.status}`,
    `channel: ${payload.channel}`,
    `to: ${payload.to}`,
    payload.subject ? `subject: ${payload.subject}` : undefined,
    `reason: ${payload.reason}`,
    `sessionId: ${meta.sessionId}`,
    `approvedAt: ${meta.approvedAt}`,
    "sent: false",
    "---",
    "",
    payload.body.trim(),
    "",
  ]
    .filter((l) => l !== undefined)
    .join("\n");
  return header;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || !v.trim()) throw new Error(`Missing string argument: ${key}`);
  return v;
}

const SKIP_DIR = new Set([
  "node_modules",
  ".git",
  "target",
  "dist",
  ".next",
  "__pycache__",
  ".venv",
  "venv",
]);

function walk(root: string, cwd: string, visit: (file: string) => boolean): void {
  let st;
  try {
    st = statSync(root);
  } catch {
    return;
  }
  if (st.isFile()) {
    visit(root);
    return;
  }
  if (!st.isDirectory()) return;
  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    if (SKIP_DIR.has(name)) continue;
    const full = join(root, name);
    let child;
    try {
      child = statSync(full);
    } catch {
      continue;
    }
    if (child.isDirectory()) walk(full, cwd, visit);
    else if (child.isFile()) {
      if (!visit(full)) return;
    }
  }
}

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.|0\.0\.0\.0|\[::1\]|::1)/i;

export function assertPublicHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Only http(s) URLs are allowed (got ${url.protocol})`);
  }
  if (PRIVATE_HOST.test(url.hostname) || url.hostname === "0.0.0.0") {
    throw new Error(`Refusing private/loopback URL: ${url.hostname}`);
  }
  return url;
}

async function publicFetch(fetchImpl: FetchLike, raw: string, hops = 0): Promise<Response> {
  if (hops > 5) throw new Error("Too many redirects");
  const url = assertPublicHttpUrl(raw);
  const res = await fetchImpl(url.href, {
    method: "GET",
    redirect: "manual",
    headers: { "User-Agent": "ClankerSpanker-Bot/0.3 (public fetch; no cookies)" },
  });
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get("location");
    if (!loc) throw new Error(`Redirect ${res.status} without Location`);
    return publicFetch(fetchImpl, new URL(loc, url).href, hops + 1);
  }
  return res;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 24_000);
}

async function searchHackerNews(fetchImpl: FetchLike, query: string): Promise<string | null> {
  const url =
    `https://hn.algolia.com/api/v1/search?tags=story&hitsPerPage=8&query=${encodeURIComponent(query)}`;
  const res = await publicFetch(fetchImpl, url);
  const text = (await res.text()).slice(0, FETCH_CAP);
  let parsed: {
    hits?: Array<{
      title?: string;
      url?: string;
      author?: string;
      points?: number;
      objectID?: string;
      created_at?: string;
    }>;
  };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    return null;
  }
  const hits = (parsed.hits ?? []).filter((h) => h.title && (h.url || h.objectID));
  if (!hits.length) return null;
  const lines = hits.slice(0, 8).map((h, i) => {
    const href = h.url || `https://news.ycombinator.com/item?id=${h.objectID}`;
    const meta = [h.author && `by ${h.author}`, h.points != null && `${h.points} pts`, h.created_at?.slice(0, 10)]
      .filter(Boolean)
      .join(" · ");
    return `${i + 1}. ${h.title}\n   ${href}\n   ${meta}`;
  });
  return `Hacker News for ${JSON.stringify(query)}:\n${lines.join("\n")}`;
}

async function searchWikipedia(fetchImpl: FetchLike, query: string): Promise<string | null> {
  const url =
    `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=5&srsearch=${encodeURIComponent(query)}`;
  const res = await publicFetch(fetchImpl, url);
  const text = (await res.text()).slice(0, FETCH_CAP);
  let parsed: { query?: { search?: Array<{ title?: string; snippet?: string; pageid?: number }> } };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    return null;
  }
  const hits = parsed.query?.search ?? [];
  if (!hits.length) return null;
  const lines = hits.slice(0, 5).map((h, i) => {
    const title = h.title || "Wikipedia";
    const href = `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
    const snip = stripHtml(h.snippet ?? "");
    return `${i + 1}. ${title}\n   ${href}\n   ${snip}`;
  });
  return `Wikipedia for ${JSON.stringify(query)}:\n${lines.join("\n")}`;
}
