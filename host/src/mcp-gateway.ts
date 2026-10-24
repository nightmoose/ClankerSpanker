import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import { realpathSync } from "node:fs";
import { sep, resolve } from "node:path";
import { extractBearer, tokensMatch } from "./auth.js";
import {
  MCP_DEFAULT_MAX_CONCURRENT,
  MCP_DEFAULT_TASK_TIMEOUT_MS,
  isUsableCwd,
  resolveProjectPath,
} from "./config.js";
import { profileHasCredentials } from "./profiles.js";
import { expandHome, inferProjectId } from "./project-resolve.js";
import type { SessionManager } from "./acp/session-manager.js";
import type {
  DispatchSession,
  HostConfigFile,
  SessionEvent,
  SessionStatus,
} from "./types.js";

/**
 * Remote MCP gateway (RFC-072).
 *
 * One Streamable HTTP endpoint, `POST /mcp`, on the existing host. It starts
 * Claude Code and Grok Build through SessionManager. A loopback-only
 * companion port can publish that endpoint alone.
 *
 * Protocol: 2026-07-28 (per-request metadata) and the legacy initialize
 * handshake used by 2025-03-26 through 2025-11-25. Replies are a single
 * JSON object. Clients that accept only `text/event-stream` get one SSE
 * event with the same object.
 */

const SERVER_NAME = "clankerspanker";
const SERVER_VERSION = "0.3.2";
export const MCP_PROTOCOL_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"] as const;
const MODERN_PROTOCOL = "2026-07-28";
const LEGACY_PROTOCOL = "2025-11-25";

const PROMPT_CAP = 100_000;
const TEXT_CAP = 8_000;
const LINE_CAP = 2_000;
const DIFF_CAP = 16_000;
const MAX_EVENT_LINES = 40;
const MAX_WAIT_MS = 25_000;
const BODY_LIMIT = 1_000_000;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

const ACTIVE: ReadonlySet<SessionStatus> = new Set([
  "queued",
  "running",
  "awaiting_approval",
  "awaiting_question",
]);

const INSTRUCTIONS = [
  "This gateway runs Claude Code and Grok Build on the machine it is installed on.",
  "Call list_engines and list_repos before start_task.",
  'engine is "claude" or "grok". cwd must be an allowed root, or a directory inside one.',
  "Poll get_output until status is idle, completed, failed, or cancelled. waitMs (max 25000) long-polls. Then call get_result for the reply and the git diff.",
  "Edits and shell commands still wait for a person on the phone. If needsHuman is set, stop and say so. This connector cannot approve or answer.",
  "send_followup continues a task this connector started. cancel_task stops it.",
].join(" ");

type RpcId = string | number | null;

interface RpcBody {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly?: boolean;
  destructive?: boolean;
}

const TOOLS: ToolSpec[] = [
  {
    name: "list_engines",
    description: "Claude and Grok profiles this host can start. Pass profileId to start_task when an engine has more than one.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    readOnly: true,
  },
  {
    name: "list_repos",
    description: "Working directories a remote task is allowed to use, and the host projects that sit inside them.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    readOnly: true,
  },
  {
    name: "list_sessions",
    description: "Tasks this connector started. Does not include phone or desktop chats.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Optional status filter." },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
    readOnly: true,
  },
  {
    name: "start_task",
    description: "Start a Claude Code or Grok Build task. Returns a sessionId to poll. Does not auto-approve edits or shell commands.",
    inputSchema: {
      type: "object",
      properties: {
        engine: { type: "string", enum: ["claude", "grok"] },
        prompt: { type: "string" },
        cwd: { type: "string", description: "Absolute path or ~/path inside an allowed root." },
        projectId: { type: "string", description: "A projectId from list_repos." },
        profileId: { type: "string" },
        title: { type: "string" },
      },
      required: ["engine", "prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "get_task",
    description: "Status of one MCP task, including needsHuman when the phone has to approve or answer.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"],
      additionalProperties: false,
    },
    readOnly: true,
  },
  {
    name: "get_output",
    description: "Recent output since sinceSeq. Pass the returned nextSeq back as sinceSeq. waitMs long-polls up to 25000 ms.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        sinceSeq: { type: "integer", minimum: 0 },
        waitMs: { type: "integer", minimum: 0, maximum: MAX_WAIT_MS },
      },
      required: ["sessionId"],
      additionalProperties: false,
    },
    readOnly: true,
  },
  {
    name: "send_followup",
    description: "Send another prompt to an MCP task this connector started.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        prompt: { type: "string" },
      },
      required: ["sessionId", "prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "cancel_task",
    description: "Stop an MCP task this connector started.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"],
      additionalProperties: false,
    },
    destructive: true,
  },
  {
    name: "get_result",
    description: "Latest assistant reply and the git diff for an MCP task.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"],
      additionalProperties: false,
    },
    readOnly: true,
  },
];

export interface McpGuard {
  arm(sessionId: string): void;
  dispose(): void;
}

const guards = new WeakMap<SessionManager, McpGuard>();

/** Per-turn timer for MCP tasks. Cleared when the turn goes idle or ends. */
export function attachMcpTaskGuards(config: HostConfigFile, manager: SessionManager): McpGuard {
  guards.get(manager)?.dispose();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const timeoutMs = () => config.mcpGateway?.taskTimeoutMs ?? MCP_DEFAULT_TASK_TIMEOUT_MS;

  const clear = (id: string) => {
    const timer = timers.get(id);
    if (timer) clearTimeout(timer);
    timers.delete(id);
  };

  const arm = (sessionId: string) => {
    clear(sessionId);
    const ms = timeoutMs();
    if (ms <= 0) return;
    const timer = setTimeout(() => {
      timers.delete(sessionId);
      const session = manager.get(sessionId);
      if (!session || session.source !== "mcp" || !ACTIVE.has(session.status)) return;
      if (!session.error) session.error = "Stopped: MCP task timed out";
      void manager.cancel(sessionId).catch((err) => {
        console.warn("[mcp] timeout cancel failed:", err instanceof Error ? err.message : err);
      });
    }, ms);
    timer.unref?.();
    timers.set(sessionId, timer);
  };

  const onEvent = (ev: SessionEvent) => {
    if (ev.type === "session.completed" || ev.type === "session.failed") {
      clear(ev.sessionId);
      return;
    }
    if (ev.type !== "session.updated") return;
    const status = payloadRecord(ev.payload).status;
    if (status === "idle" || status === "completed" || status === "failed" || status === "cancelled") {
      clear(ev.sessionId);
    }
  };
  manager.on("event", onEvent);

  for (const session of manager.list()) {
    if (session.source === "mcp" && ACTIVE.has(session.status)) arm(session.id);
  }

  const guard: McpGuard = {
    arm,
    dispose() {
      manager.off("event", onEvent);
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      if (guards.get(manager) === guard) guards.delete(manager);
    },
  };
  guards.set(manager, guard);
  return guard;
}

/** Directories a remote task may run in. Explicit roots win; otherwise project paths. */
export function effectiveAllowedRoots(config: HostConfigFile): string[] {
  const configured = config.mcpGateway?.allowedRoots ?? [];
  if (configured.length > 0) return configured.map((root) => resolve(expandHome(root)));
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const project of config.projects ?? []) {
    const paths = (project.paths?.length ? project.paths : [project.path]).filter(Boolean);
    for (const path of paths) {
      const resolved = resolve(expandHome(path));
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      roots.push(resolved);
    }
  }
  return roots;
}

/**
 * True when `candidate` is `root` or a directory inside it, after resolving
 * symlinks. `/repo` does not allow `/repo-evil`.
 */
export function pathIsInsideRoot(candidate: string, root: string): boolean {
  let realCandidate: string;
  let realRoot: string;
  try {
    realCandidate = realpathSync(candidate);
    realRoot = realpathSync(root);
  } catch {
    return false;
  }
  if (realCandidate === realRoot) return true;
  const prefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  return realCandidate.startsWith(prefix);
}

export function resolveTaskCwd(
  config: HostConfigFile,
  projectId?: string,
  cwd?: string,
): { path: string; projectId?: string } {
  const roots = effectiveAllowedRoots(config);
  if (roots.length === 0) {
    throw new Error("No MCP working directory is allowed. Set mcpGateway.allowedRoots or add a project.");
  }
  let resolved: { path: string; projectId?: string };
  if (projectId?.trim()) {
    resolved = resolveProjectPath(config, projectId.trim(), cwd);
  } else if (cwd?.trim()) {
    const path = resolve(expandHome(cwd.trim()));
    if (!isUsableCwd(path)) throw new Error(`Not a usable directory: ${path}`);
    resolved = { path, projectId: inferProjectId(config.projects, path) };
  } else if (roots.length === 1) {
    const path = roots[0]!;
    if (!isUsableCwd(path)) throw new Error(`Not a usable directory: ${path}`);
    resolved = { path, projectId: inferProjectId(config.projects, path) };
  } else {
    throw new Error("Pass projectId or cwd. More than one directory is allowed.");
  }
  if (!roots.some((root) => pathIsInsideRoot(resolved.path, root))) {
    throw new Error(`Directory is outside the MCP allowlist: ${resolved.path}`);
  }
  return resolved;
}

/** Bearer host token or `mcpGateway.token`. The MCP token is not checked on other routes. */
export function mcpAuthorized(headers: IncomingHttpHeaders, config: HostConfigFile): boolean {
  const bearer = bearerFrom(headers);
  const hostOk = tokensMatch(bearer, config.hostToken);
  const mcpOk = tokensMatch(bearer, config.mcpGateway?.token);
  return hostOk || mcpOk;
}

export async function handleMcpHttp(
  req: IncomingMessage,
  res: ServerResponse,
  config: HostConfigFile,
  manager: SessionManager,
): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  if (method === "OPTIONS") {
    if (!originAllowed(headerValue(req.headers, "origin"), config)) {
      sendJson(res, 403, { error: "Forbidden", message: "Origin is not allowed" });
      return;
    }
    res.writeHead(204, {
      "Access-Control-Allow-Origin": res.getHeader("Access-Control-Allow-Origin") ?? "*",
      "Access-Control-Allow-Headers":
        "Authorization, Content-Type, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Max-Age": "600",
    });
    res.end();
    return;
  }
  if (!originAllowed(headerValue(req.headers, "origin"), config)) {
    sendJson(res, 403, rpcError(null, -32600, "Origin is not allowed"));
    return;
  }
  if (!mcpAuthorized(req.headers, config)) {
    sendJson(res, 401, { error: "Unauthorized", message: "Valid Bearer token required" }, {
      "WWW-Authenticate": 'Bearer realm="clankerspanker"',
    });
    return;
  }
  if (method === "GET" || method === "DELETE") {
    sendJson(res, 405, { error: "Method Not Allowed", message: "MCP messages are POST only" }, { Allow: "POST" });
    return;
  }
  if (method !== "POST") {
    sendJson(res, 405, { error: "Method Not Allowed" }, { Allow: "POST" });
    return;
  }
  const accept = headerValue(req.headers, "accept");
  if (accept && !accept.includes("application/json") && !accept.includes("text/event-stream")) {
    sendJson(res, 406, { error: "Not Acceptable", message: "Accept application/json or text/event-stream" });
    return;
  }
  let raw = "";
  try {
    raw = await readBody(req, BODY_LIMIT);
  } catch (err) {
    const tooBig = err instanceof Error && err.message === "Body too large";
    sendJson(res, tooBig ? 413 : 400, rpcError(null, -32700, tooBig ? "Body too large" : "Could not read body"));
    return;
  }
  const outcome = await handleMcpMessage(req.headers, raw, config, manager);
  if (outcome.empty) {
    res.writeHead(outcome.status);
    res.end();
    return;
  }
  const sse = Boolean(accept?.includes("text/event-stream") && !accept.includes("application/json"));
  if (sse) sendSse(res, outcome.status, outcome.json);
  else sendJson(res, outcome.status, outcome.json);
}

/** Loopback listener that answers `/mcp` and `/health` and nothing else. */
export function createMcpOnlyServer(config: HostConfigFile, manager: SessionManager): Server {
  return createServer((req, res) => {
    let path = "/";
    try {
      path = new URL(req.url ?? "/", "http://127.0.0.1").pathname.replace(/\/+$/, "") || "/";
    } catch {
      path = "/";
    }
    const method = (req.method ?? "GET").toUpperCase();
    if (method === "GET" && path === "/health") {
      sendJson(res, 200, { ok: true, service: "clankerspanker-mcp" });
      return;
    }
    if (path !== "/mcp") {
      sendJson(res, 404, { error: "Not Found", message: "This port only serves POST /mcp" });
      return;
    }
    void handleMcpHttp(req, res, config, manager).catch((err) => {
      if (res.headersSent) return;
      sendJson(res, 500, rpcError(null, -32603, err instanceof Error ? err.message : String(err)));
    });
  });
}

export function listenMcpOnly(config: HostConfigFile, manager: SessionManager): Server | undefined {
  const port = config.mcpGateway?.publicBindPort;
  if (!port) return undefined;
  const server = createMcpOnlyServer(config, manager);
  server.on("error", (err: NodeJS.ErrnoException) => {
    console.warn(`[mcp] could not listen on 127.0.0.1:${port} — ${err.code ?? err.message}`);
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(
      `[mcp] public listener on http://127.0.0.1:${port} (only /mcp; point Funnel or a tunnel here, not at ${config.bindPort})`,
    );
    if (!config.mcpGateway?.token) {
      console.warn(
        "[mcp] public listener has no mcpGateway.token. It accepts the host token. Set a separate token before exposing this port.",
      );
    }
  });
  return server;
}

export async function handleMcpMessage(
  headers: IncomingHttpHeaders,
  raw: string,
  config: HostConfigFile,
  manager: SessionManager,
): Promise<{ status: number; json?: unknown; empty?: boolean }> {
  let parsed: unknown;
  try {
    parsed = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return { status: 400, json: rpcError(null, -32700, "Parse error") };
  }
  if (Array.isArray(parsed)) {
    return { status: 400, json: rpcError(null, -32600, "JSON-RPC batches are not supported") };
  }
  if (!parsed || typeof parsed !== "object") {
    return { status: 400, json: rpcError(null, -32600, "Invalid Request") };
  }
  const body = parsed as RpcBody;
  if (body.jsonrpc !== undefined && body.jsonrpc !== "2.0") {
    return { status: 400, json: rpcError(rpcId(body.id), -32600, "Invalid Request") };
  }
  if (typeof body.method !== "string" || !body.method) {
    return { status: 400, json: rpcError(rpcId(body.id), -32600, "Invalid Request") };
  }
  const id = rpcId(body.id);
  const notification = !Object.prototype.hasOwnProperty.call(body, "id");
  if (notification || body.method.startsWith("notifications/")) {
    return { status: 202, empty: true };
  }

  const version = requestedVersion(headers, body);
  if (version.mismatch) {
    return {
      status: 400,
      json: rpcError(id, -32020, "MCP-Protocol-Version header does not match _meta protocolVersion"),
    };
  }
  if (!version.value || !MCP_PROTOCOL_VERSIONS.includes(version.value as (typeof MCP_PROTOCOL_VERSIONS)[number])) {
    return {
      status: 400,
      json: rpcError(id, -32022, "Unsupported protocol version", {
        supported: [...MCP_PROTOCOL_VERSIONS],
        requested: version.value ?? "",
      }),
    };
  }
  const modern = version.value === MODERN_PROTOCOL;
  if (modern) {
    const headerError = validateModernHeaders(headers, body, id);
    if (headerError) return headerError;
  } else {
    const methodHeader = headerValue(headers, "mcp-method");
    if (methodHeader && methodHeader !== body.method) {
      return {
        status: 400,
        json: rpcError(id, -32020, `Mcp-Method header value '${methodHeader}' does not match body method '${body.method}'`),
      };
    }
  }

  try {
    const result = await dispatchMethod(body.method, body.params, config, manager, version.value);
    if (result === undefined) {
      const status = modern ? 404 : 200;
      return { status, json: rpcError(id, -32601, `Method not found: ${body.method}`) };
    }
    return { status: 200, json: { jsonrpc: "2.0", id, result } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 200, json: rpcError(id, -32603, message) };
  }
}

async function dispatchMethod(
  method: string,
  params: unknown,
  config: HostConfigFile,
  manager: SessionManager,
  version: string,
): Promise<unknown | undefined> {
  const modern = version === MODERN_PROTOCOL;
  if (method === "server/discover") return discoverResult();
  if (method === "initialize") return initializeResult(params);
  if (method === "ping") return modern ? { resultType: "complete" } : {};
  if (method === "tools/list") return toolsList(modern);
  if (method === "resources/list") return modern ? { resultType: "complete", resources: [] } : { resources: [] };
  if (method === "prompts/list") return modern ? { resultType: "complete", prompts: [] } : { prompts: [] };
  if (method === "logging/setLevel") return modern ? { resultType: "complete" } : {};
  if (method === "tools/call") return callTool(params, config, manager, modern);
  return undefined;
}

function discoverResult(): unknown {
  return {
    resultType: "complete",
    supportedVersions: [...MCP_PROTOCOL_VERSIONS],
    capabilities: { tools: { listChanged: false } },
    _meta: {
      "io.modelcontextprotocol/serverInfo": { name: SERVER_NAME, version: SERVER_VERSION },
    },
    instructions: INSTRUCTIONS,
    ttlMs: 3_600_000,
    cacheScope: "public",
  };
}

function initializeResult(params: unknown): unknown {
  const requested = typeof record(params).protocolVersion === "string" ? String(record(params).protocolVersion) : "";
  const protocolVersion = MCP_PROTOCOL_VERSIONS.includes(requested as (typeof MCP_PROTOCOL_VERSIONS)[number]) &&
    requested !== MODERN_PROTOCOL
    ? requested
    : LEGACY_PROTOCOL;
  return {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    instructions: INSTRUCTIONS,
  };
}

function toolsList(modern: boolean): unknown {
  const tools = TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: {
      readOnlyHint: Boolean(tool.readOnly),
      destructiveHint: Boolean(tool.destructive),
      openWorldHint: false,
    },
  }));
  return modern ? { resultType: "complete", tools } : { tools };
}

async function callTool(
  params: unknown,
  config: HostConfigFile,
  manager: SessionManager,
  modern: boolean,
): Promise<unknown> {
  const name = typeof record(params).name === "string" ? String(record(params).name) : "";
  const args = record(record(params).arguments);
  let text: string;
  let isError = false;
  try {
    text = JSON.stringify(await runTool(name, args, config, manager), null, 2);
  } catch (err) {
    isError = true;
    text = err instanceof Error ? err.message : String(err);
  }
  const content = [{ type: "text", text }];
  return modern ? { resultType: "complete", content, isError } : { content, isError };
}

async function runTool(
  name: string,
  args: Record<string, unknown>,
  config: HostConfigFile,
  manager: SessionManager,
): Promise<unknown> {
  switch (name) {
    case "list_engines":
      return {
        engines: (config.profiles ?? [])
          .filter((profile) => profile.backend === "claude" || profile.backend === "grok")
          .map((profile) => ({
            profileId: profile.id,
            name: profile.name,
            engine: profile.backend,
            model: profile.model,
            hasCredentials: profileHasCredentials(profile),
          })),
      };
    case "list_repos":
      return listRepos(config);
    case "list_sessions":
      return listSessions(manager, args);
    case "start_task":
      return startTask(config, manager, args);
    case "get_task":
      return taskView(requireMcpSession(manager, stringArg(args, "sessionId")));
    case "get_output":
      return getOutput(manager, args);
    case "send_followup":
      return sendFollowup(config, manager, args);
    case "cancel_task":
      return cancelTask(manager, stringArg(args, "sessionId"));
    case "get_result":
      return getResult(manager, stringArg(args, "sessionId"));
    default:
      throw new Error(`Unknown tool: ${name || "(missing name)"}`);
  }
}

function listRepos(config: HostConfigFile): unknown {
  const allowedRoots = effectiveAllowedRoots(config);
  const projects: Array<{ projectId: string; name: string; path: string }> = [];
  for (const project of config.projects ?? []) {
    const paths = (project.paths?.length ? project.paths : [project.path]).filter(Boolean);
    for (const path of paths) {
      const resolved = resolve(expandHome(path));
      if (!allowedRoots.some((root) => stringInside(resolved, root))) continue;
      projects.push({ projectId: project.id, name: project.name, path: resolved });
    }
  }
  return { allowedRoots, projects };
}

function listSessions(manager: SessionManager, args: Record<string, unknown>): unknown {
  const status = typeof args.status === "string" ? args.status : undefined;
  const limit = clampInt(args.limit, 1, 50, 20);
  const sessions = manager
    .list()
    .filter((session) => session.source === "mcp" && (!status || session.status === status))
    .slice(0, limit)
    .map((session) => taskView(session));
  return { sessions };
}

async function startTask(
  config: HostConfigFile,
  manager: SessionManager,
  args: Record<string, unknown>,
): Promise<unknown> {
  const engine = stringArg(args, "engine");
  const prompt = stringArg(args, "prompt");
  if (prompt.length > PROMPT_CAP) throw new Error(`prompt is longer than ${PROMPT_CAP} characters`);
  const profile = resolveEngine(config, engine, optionalString(args, "profileId"));
  const cwd = resolveTaskCwd(config, optionalString(args, "projectId"), optionalString(args, "cwd"));
  assertCapacity(config, manager);
  const title = optionalString(args, "title");
  const session = await manager.dispatch({
    prompt,
    profileId: profile.id,
    projectId: cwd.projectId,
    cwd: cwd.path,
    ...(title ? { title: title.slice(0, 200) } : {}),
    source: "mcp",
  });
  guards.get(manager)?.arm(session.id);
  return taskView(session);
}

async function getOutput(manager: SessionManager, args: Record<string, unknown>): Promise<unknown> {
  const session = requireMcpSession(manager, stringArg(args, "sessionId"));
  const sinceSeq = clampInt(args.sinceSeq, 0, Number.MAX_SAFE_INTEGER, 0);
  const waitMs = clampInt(args.waitMs, 0, MAX_WAIT_MS, 0);
  if (waitMs > 0 && manager.getEventsSince(session.id, sinceSeq).length === 0 && ACTIVE.has(session.status)) {
    await waitForEvent(manager, session.id, sinceSeq, waitMs);
  }
  const fresh = manager.get(session.id) ?? session;
  const events = manager.getEventsSince(fresh.id, sinceSeq).slice(-MAX_EVENT_LINES);
  let nextSeq = sinceSeq;
  const lines = events.map((event) => {
    if (typeof event.seq === "number" && event.seq > nextSeq) nextSeq = event.seq;
    return { seq: event.seq, at: event.at, type: event.type, text: eventLine(event) };
  });
  return { ...taskView(fresh), sinceSeq, nextSeq, lines };
}

async function sendFollowup(
  config: HostConfigFile,
  manager: SessionManager,
  args: Record<string, unknown>,
): Promise<unknown> {
  const session = requireMcpSession(manager, stringArg(args, "sessionId"));
  const prompt = stringArg(args, "prompt");
  if (prompt.length > PROMPT_CAP) throw new Error(`prompt is longer than ${PROMPT_CAP} characters`);
  if (!ACTIVE.has(session.status)) assertCapacity(config, manager);
  const updated = await manager.followUp(session.id, prompt);
  guards.get(manager)?.arm(updated.id);
  return taskView(manager.get(updated.id) ?? updated);
}

async function cancelTask(manager: SessionManager, sessionId: string): Promise<unknown> {
  const session = requireMcpSession(manager, sessionId);
  if (!ACTIVE.has(session.status)) return taskView(session);
  const updated = await manager.cancel(session.id);
  return taskView(manager.get(updated.id) ?? updated);
}

async function getResult(manager: SessionManager, sessionId: string): Promise<unknown> {
  const session = requireMcpSession(manager, sessionId);
  let diff = "";
  let diffError: string | undefined;
  try {
    const got = await manager.diff(session.id);
    diff = clip(got.diff, DIFF_CAP);
  } catch (err) {
    diffError = err instanceof Error ? err.message : String(err);
  }
  return {
    ...taskView(session),
    assistant: lastAssistant(session),
    diff,
    ...(diffError ? { diffError } : {}),
  };
}

function resolveEngine(config: HostConfigFile, engine: string, profileId?: string) {
  if (engine !== "claude" && engine !== "grok") throw new Error('engine must be "claude" or "grok"');
  const profiles = (config.profiles ?? []).filter((profile) => profile.backend === engine);
  if (profileId) {
    const hit = profiles.find((profile) => profile.id === profileId);
    if (!hit) throw new Error(`No ${engine} profile with id ${profileId}`);
    return hit;
  }
  if (profiles.length === 0) throw new Error(`No ${engine} profile is configured on this host`);
  if (profiles.length > 1) {
    throw new Error(
      `Several ${engine} profiles exist (${profiles.map((profile) => profile.id).join(", ")}). Pass profileId.`,
    );
  }
  return profiles[0]!;
}

function assertCapacity(config: HostConfigFile, manager: SessionManager): void {
  const cap = config.mcpGateway?.maxConcurrent ?? MCP_DEFAULT_MAX_CONCURRENT;
  const running = manager.list().filter((session) => session.source === "mcp" && ACTIVE.has(session.status)).length;
  if (running >= cap) {
    throw new Error(
      cap === 0
        ? "MCP is not accepting new tasks (maxConcurrent is 0)."
        : `MCP concurrency cap is ${cap} and ${running} task${running === 1 ? " is" : "s are"} still running.`,
    );
  }
}

function requireMcpSession(manager: SessionManager, sessionId: string): DispatchSession {
  if (!SESSION_ID_RE.test(sessionId)) throw new Error("Invalid session id");
  const session = manager.get(sessionId);
  if (!session || session.source !== "mcp") throw new Error("No MCP task with that id");
  return session;
}

function taskView(session: DispatchSession): Record<string, unknown> {
  const needsHuman = humanGate(session);
  const preview = lastAssistant(session, 2_000);
  return {
    sessionId: session.id,
    title: session.title,
    status: session.status,
    engine: session.backend,
    profileId: session.profileId,
    profileName: session.profileName,
    cwd: session.cwd,
    projectId: session.projectId,
    updatedAt: session.updatedAt,
    ...(session.error ? { error: clip(session.error, TEXT_CAP) } : {}),
    ...(needsHuman ? { needsHuman } : {}),
    ...(preview ? { preview } : {}),
  };
}

function humanGate(session: DispatchSession): string | undefined {
  if (session.status === "awaiting_approval") {
    const title = session.pendingApproval?.title;
    return `A person has to approve this on the phone${title ? ` (${title})` : ""}. This connector cannot approve it.`;
  }
  if (session.status === "awaiting_question") {
    const title = session.pendingQuestion?.title;
    return `The agent asked a question${title ? ` (${title})` : ""}. Answer it on the phone. This connector cannot answer it.`;
  }
  return undefined;
}

function lastAssistant(session: DispatchSession, cap = TEXT_CAP): string | undefined {
  for (let i = session.transcript.length - 1; i >= 0; i--) {
    const entry = session.transcript[i];
    if (entry?.role === "assistant" && entry.text) return clip(entry.text, cap);
  }
  return undefined;
}

function eventLine(event: SessionEvent): string {
  const payload = payloadRecord(event.payload);
  if (event.type === "transcript") {
    const role = typeof payload.role === "string" ? payload.role : "message";
    const text = typeof payload.text === "string" ? payload.text : "";
    return `${role}: ${clip(text, LINE_CAP)}`;
  }
  if (event.type === "tool_call" || event.type === "tool_call_update") {
    const title = typeof payload.title === "string" ? payload.title : "tool";
    const status = typeof payload.status === "string" ? payload.status : event.type;
    return `tool ${title} (${status})`;
  }
  if (event.type === "approval.needed") {
    return `approval needed: ${typeof payload.title === "string" ? payload.title : "tool"}`;
  }
  if (event.type === "question.needed") {
    return `question: ${typeof payload.title === "string" ? payload.title : "the agent asked something"}`;
  }
  if (event.type === "error" || event.type === "session.failed") {
    const message = typeof payload.error === "string" ? payload.error : "";
    return `error: ${clip(message, LINE_CAP)}`;
  }
  if (event.type === "session.updated") {
    return typeof payload.status === "string" ? `status: ${payload.status}` : "status updated";
  }
  if (event.type === "session.completed") {
    return `finished: ${typeof payload.status === "string" ? payload.status : "completed"}`;
  }
  if (event.type === "session.created") return "task started";
  return event.type;
}

function waitForEvent(manager: SessionManager, sessionId: string, sinceSeq: number, waitMs: number): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      manager.off("event", onEvent);
      resolve();
    };
    const onEvent = (event: SessionEvent) => {
      if (event.sessionId !== sessionId) return;
      if (typeof event.seq === "number" && event.seq > sinceSeq) finish();
    };
    manager.on("event", onEvent);
    const timer = setTimeout(finish, waitMs);
  });
}

function requestedVersion(
  headers: IncomingHttpHeaders,
  body: RpcBody,
): { value?: string; mismatch?: boolean } {
  const headerVersion = headerValue(headers, "mcp-protocol-version");
  const meta = metaVersion(body.params);
  if (headerVersion && meta && headerVersion !== meta) return { mismatch: true };
  if (headerVersion || meta) return { value: headerVersion || meta };
  if (body.method === "initialize") {
    const asked = record(body.params).protocolVersion;
    return { value: typeof asked === "string" && asked ? asked : LEGACY_PROTOCOL };
  }
  return { value: "2025-03-26" };
}

function validateModernHeaders(
  headers: IncomingHttpHeaders,
  body: RpcBody,
  id: RpcId,
): { status: number; json: unknown } | undefined {
  if (!headerValue(headers, "mcp-protocol-version")) {
    return { status: 400, json: rpcError(id, -32020, "MCP-Protocol-Version header is required") };
  }
  const methodHeader = headerValue(headers, "mcp-method");
  if (!methodHeader) return { status: 400, json: rpcError(id, -32020, "Mcp-Method header is required") };
  if (methodHeader !== body.method) {
    return {
      status: 400,
      json: rpcError(id, -32020, `Mcp-Method header value '${methodHeader}' does not match body method '${body.method}'`),
    };
  }
  if (body.method === "tools/call") {
    const name = typeof record(body.params).name === "string" ? String(record(body.params).name) : "";
    const nameHeader = headerValue(headers, "mcp-name");
    if (!nameHeader) return { status: 400, json: rpcError(id, -32020, "Mcp-Name header is required for tools/call") };
    if (decodeMcpHeader(nameHeader) !== name) {
      return {
        status: 400,
        json: rpcError(id, -32020, `Mcp-Name header does not match body tool name '${name}'`),
      };
    }
  }
  return undefined;
}

function metaVersion(params: unknown): string | undefined {
  const meta = record(record(params)._meta);
  const value = meta["io.modelcontextprotocol/protocolVersion"];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function decodeMcpHeader(value: string): string {
  const match = /^=\?base64\?([A-Za-z0-9+/=]+)\?=$/.exec(value.trim());
  if (!match?.[1]) return value;
  return Buffer.from(match[1], "base64").toString("utf8");
}

function originAllowed(origin: string | undefined, config: HostConfigFile): boolean {
  if (!origin) return true;
  let host = "";
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  const allowed = config.mcpGateway?.allowedOrigins ?? [];
  return allowed.some((entry) => entry.toLowerCase() === origin.toLowerCase());
}

function stringInside(candidate: string, root: string): boolean {
  const left = resolve(candidate);
  const right = resolve(root);
  if (left === right) return true;
  const prefix = right.endsWith(sep) ? right : right + sep;
  return left.startsWith(prefix);
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
  return value.trim();
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function payloadRecord(value: unknown): Record<string, unknown> {
  return record(value);
}

function rpcId(value: unknown): RpcId {
  if (typeof value === "string" || typeof value === "number" || value === null) return value;
  return null;
}

function rpcError(id: RpcId, code: number, message: string, data?: unknown): unknown {
  return {
    jsonrpc: "2.0",
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

function bearerFrom(headers: IncomingHttpHeaders): string | null {
  return extractBearer({ headers } as IncomingMessage);
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  const first = Array.isArray(value) ? value[0] : value;
  const trimmed = first?.trim();
  return trimmed || undefined;
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        fail(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolveBody(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (err) => fail(err instanceof Error ? err : new Error(String(err))));
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const data = JSON.stringify(body);
  if (res.headersSent) return;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(data),
    ...extra,
  });
  res.end(data);
}

function sendSse(res: ServerResponse, status: number, body: unknown): void {
  const data = `event: message\ndata: ${JSON.stringify(body)}\n\n`;
  if (res.headersSent) return;
  res.writeHead(status, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}
