import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { URL } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type { HostConfigFile } from "./types.js";
import type {
  AnswerQuestionsRequest,
  ApproveRequest,
  AttachClaudeRequest,
  AttachRequest,
  DispatchRequest,
  PromptFollowUpRequest,
  RejectRequest,
  SessionEvent,
} from "./types.js";
import { isAuthorized, unauthorizedBody } from "./auth.js";
import { SessionManager } from "./acp/session-manager.js";
import { listClaudeSessions, listDiskSessions } from "./sessions/reader.js";
import { preferredClientHost } from "./platform.js";
import { publicProfiles } from "./profiles.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Static browser UI (same origin as API). Works from dist/ or src via tsx. */
const WEB_ROOT = (() => {
  const candidates = [
    join(__dirname, "web"),
    join(__dirname, "../web"),
    join(__dirname, "../../web"),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "index.html"))) return c;
  }
  return join(__dirname, "../web");
})();

type WsClient = WebSocket & { isAlive?: boolean };

export function startServer(config: HostConfigFile, manager: SessionManager) {
  const server = createServer(async (req, res) => {
    try {
      await handleHttp(req, res, config, manager);
    } catch (err) {
      console.error("[http]", err);
      if (!res.headersSent) {
        json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    }
  });

  const wss = new WebSocketServer({ server, path: "/ws" });
  const clients = new Set<WsClient>();

  wss.on("connection", (ws: WsClient, req) => {
    // Auth via query ?token= or header
    const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
    const qToken = url.searchParams.get("token");
    const headerOk = isAuthorized(req, config);
    if (!headerOk && qToken !== config.hostToken) {
      ws.close(4401, "Unauthorized");
      return;
    }

    ws.isAlive = true;
    clients.add(ws);
    ws.send(JSON.stringify({ type: "hello", at: new Date().toISOString(), version: "0.1.0" }));

    ws.on("pong", () => {
      ws.isAlive = true;
    });
    ws.on("close", () => clients.delete(ws));
    ws.on("message", (data) => {
      // Optional subscribe filter later; for now ignore client messages except ping
      try {
        const msg = JSON.parse(String(data)) as { type?: string };
        if (msg.type === "ping") {
          ws.send(JSON.stringify({ type: "pong", at: new Date().toISOString() }));
        }
      } catch {
        /* ignore */
      }
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of clients) {
      if (ws.isAlive === false) {
        clients.delete(ws);
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);

  manager.on("event", (event: SessionEvent) => {
    const payload = JSON.stringify({ kind: "event", event });
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  });

  server.listen(config.bindPort, config.bindHost, () => {
    const lan = preferredClientHost(config.bindPort);
    console.log(`[server] ClankerSpanker host listening on http://${config.bindHost}:${config.bindPort}`);
    console.log(`[server] Browser UI:  http://${lan}/app/`);
    console.log(`[server] Setup page:  http://${lan}/setup`);
    console.log(`[server] WebSocket:   ws://${config.bindHost}:${config.bindPort}/ws?token=<hostToken>`);
  });

  const shutdown = async () => {
    clearInterval(heartbeat);
    wss.close();
    server.close();
    await manager.shutdown();
  };

  return { server, wss, shutdown };
}

async function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
  config: HostConfigFile,
  manager: SessionManager,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = (req.method ?? "GET").toUpperCase();

  // CORS for local tooling
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Grok-Dispatch-Token");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (method === "GET" && path === "/health") {
    json(res, 200, {
      ok: true,
      service: "clankerspanker-host",
      version: "0.3.2",
      name: "ClankerSpanker",
      time: new Date().toISOString(),
    });
    return;
  }

  // Setup + landing (LAN / Tailscale only — do not expose publicly)
  if (method === "GET" && (path === "/setup" || path === "/")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(setupHtml(config, req));
    return;
  }

  // Browser control plane (same host as API)
  if (method === "GET" && (path === "/app" || path.startsWith("/app/"))) {
    if (serveWebStatic(req, res, path)) return;
  }

  if (method === "GET" && path === "/connect.json") {
    json(res, 200, connectPayload(config, req));
    return;
  }

  if (!isAuthorized(req, config)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(unauthorizedBody());
    return;
  }

  // GET /projects
  if (method === "GET" && path === "/projects") {
    json(res, 200, { projects: config.projects, allowCustomPaths: config.allowCustomPaths });
    return;
  }

  // GET /profiles — public agent accounts for nav segments (no secrets)
  if (method === "GET" && path === "/profiles") {
    json(res, 200, { profiles: publicProfiles(config) });
    return;
  }

  // GET /sessions
  // Default: only non-archived in `sessions`. Archived live in `archivedSessions`.
  // Pass ?includeArchived=1 to put everything in `sessions` (legacy / debugging).
  if (method === "GET" && path === "/sessions") {
    const includeArchived = url.searchParams.get("includeArchived") === "1";
    const all = manager.list().map((s) => {
      const summary = manager.store.toSummary(s, manager.isLive(s.id));
      // Backfill profile fields for older sessions — only when exactly one profile
      // matches the backend. With Personal + FullScore both Claude, do NOT invent
      // a profileId (that was dumping every Claude chat onto FullScore).
      if (!summary.profileId) {
        const backend = s.backend ?? "grok";
        const profiles = publicProfiles(config);
        const sameBackend = profiles.filter((p) => p.backend === backend);
        if (sameBackend.length === 1) {
          const fallback = sameBackend[0]!;
          summary.profileId = fallback.id;
          summary.profileName = fallback.name;
          summary.profileColor = fallback.color;
        }
        summary.backend = backend;
      }
      return {
        ...summary,
        isLive: manager.isLive(s.id),
        backend: summary.backend ?? s.backend ?? "grok",
        claudeSessionId: s.claudeSessionId,
      };
    });
    const active = all.filter((s) => !s.archived);
    const archived = all.filter((s) => s.archived);
    const disk = listDiskSessions(30);
    const claude = listClaudeSessions(30);
    json(res, 200, {
      sessions: includeArchived ? all : active,
      archivedSessions: archived,
      diskSessions: disk,
      claudeSessions: claude,
    });
    return;
  }

  // GET /sessions/:id
  const sessionMatch = /^\/sessions\/([^/]+)$/.exec(path);
  if (method === "GET" && sessionMatch) {
    const id = decodeURIComponent(sessionMatch[1]!);
    const s = manager.get(id);
    if (!s) {
      json(res, 404, { error: "Session not found" });
      return;
    }
    json(
      res,
      200,
      manager.store.toDetail(s, manager.getPendingApproval(id), manager.getPendingQuestion(id)),
    );
    return;
  }

  // GET /sessions/:id/diff
  const diffMatch = /^\/sessions\/([^/]+)\/diff$/.exec(path);
  if (method === "GET" && diffMatch) {
    const id = decodeURIComponent(diffMatch[1]!);
    try {
      const result = await manager.diff(id);
      json(res, 200, result);
    } catch (err) {
      json(res, 404, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // POST /dispatch
  if (method === "POST" && path === "/dispatch") {
    const body = (await readJson(req)) as DispatchRequest;
    try {
      const session = await manager.dispatch(body);
      json(res, 201, manager.store.toDetail(session, null));
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // POST /sessions/attach — resume a Grok Build session from disk/TUI
  if (method === "POST" && path === "/sessions/attach") {
    const body = (await readJson(req)) as AttachRequest;
    try {
      const session = await manager.attach(body);
      json(res, 201, {
        ...manager.store.toDetail(session, manager.getPendingApproval(session.id)),
        isLive: manager.isLive(session.id),
      });
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // POST /sessions/attach-claude — open Claude Code history
  if (method === "POST" && path === "/sessions/attach-claude") {
    const body = (await readJson(req)) as AttachClaudeRequest;
    try {
      const session = await manager.attachClaude(body);
      json(res, 201, {
        ...manager.store.toDetail(
          session,
          manager.getPendingApproval(session.id),
          manager.getPendingQuestion(session.id),
        ),
        isLive: manager.isLive(session.id),
        backend: session.backend ?? "grok",
        claudeSessionId: session.claudeSessionId,
      });
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // POST /internal/claude-approval — PreToolUse hook creates a phone approval
  if (method === "POST" && path === "/internal/claude-approval") {
    if (!isAuthorized(req, config)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(unauthorizedBody());
      return;
    }
    const body = (await readJson(req)) as {
      sessionId?: string;
      toolName?: string;
      title?: string;
      toolInput?: unknown;
    };
    try {
      if (!body.sessionId || !body.toolName) throw new Error("sessionId and toolName required");
      const approval = manager.createClaudeApproval({
        sessionId: body.sessionId,
        toolName: body.toolName,
        title: body.title ?? body.toolName,
        toolInput: body.toolInput,
      });
      json(res, 201, { approvalId: approval.id });
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // GET /internal/claude-approval/:id — hook polls until approved/rejected
  const claudeApprovalMatch = /^\/internal\/claude-approval\/([^/]+)$/.exec(path);
  if (method === "GET" && claudeApprovalMatch) {
    if (!isAuthorized(req, config)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(unauthorizedBody());
      return;
    }
    const id = decodeURIComponent(claudeApprovalMatch[1]!);
    const approval = manager.getClaudeApproval(id);
    if (!approval) {
      json(res, 404, { error: "Approval not found" });
      return;
    }
    json(res, 200, {
      approvalId: approval.id,
      status: approval.status,
      comment: approval.comment,
    });
    return;
  }

  // POST /sessions/:id/prompt
  const promptMatch = /^\/sessions\/([^/]+)\/prompt$/.exec(path);
  if (method === "POST" && promptMatch) {
    const id = decodeURIComponent(promptMatch[1]!);
    const body = (await readJson(req)) as PromptFollowUpRequest;
    try {
      const session = await manager.followUp(id, body.prompt, body.images);
      json(res, 200, {
        ...manager.store.toDetail(session, manager.getPendingApproval(id)),
        isLive: manager.isLive(id),
      });
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // POST /sessions/:id/answer-questions
  const answerMatch = /^\/sessions\/([^/]+)\/answer-questions$/.exec(path);
  if (method === "POST" && answerMatch) {
    const id = decodeURIComponent(answerMatch[1]!);
    const body = (await readJson(req)) as AnswerQuestionsRequest;
    try {
      const session = await manager.answerQuestions(id, body);
      json(res, 200, {
        ...manager.store.toDetail(
          session,
          manager.getPendingApproval(id),
          manager.getPendingQuestion(id),
        ),
        isLive: manager.isLive(id),
      });
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // POST /sessions/:id/approve
  const approveMatch = /^\/sessions\/([^/]+)\/approve$/.exec(path);
  if (method === "POST" && approveMatch) {
    const id = decodeURIComponent(approveMatch[1]!);
    const body = (await readJson(req)) as ApproveRequest;
    try {
      const session = await manager.resolveApproval(
        id,
        body.approvalId,
        "approve",
        body.optionId,
        body.comment,
      );
      json(res, 200, manager.store.toDetail(session, manager.getPendingApproval(id)));
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // POST /sessions/:id/reject
  const rejectMatch = /^\/sessions\/([^/]+)\/reject$/.exec(path);
  if (method === "POST" && rejectMatch) {
    const id = decodeURIComponent(rejectMatch[1]!);
    const body = (await readJson(req)) as RejectRequest;
    try {
      const session = await manager.resolveApproval(
        id,
        body.approvalId,
        "reject",
        body.optionId,
        body.comment,
      );
      json(res, 200, manager.store.toDetail(session, manager.getPendingApproval(id)));
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // POST /sessions/:id/cancel
  const cancelMatch = /^\/sessions\/([^/]+)\/cancel$/.exec(path);
  if (method === "POST" && cancelMatch) {
    const id = decodeURIComponent(cancelMatch[1]!);
    try {
      const session = await manager.cancel(id);
      json(res, 200, manager.store.toDetail(session, null));
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // POST /sessions/:id/title — rename session (phone-editable display name)
  const titleMatch = /^\/sessions\/([^/]+)\/title$/.exec(path);
  if (method === "POST" && titleMatch) {
    const id = decodeURIComponent(titleMatch[1]!);
    const body = (await readJson(req)) as { title?: string };
    try {
      if (!body.title || !String(body.title).trim()) throw new Error("title is required");
      const session = manager.rename(id, String(body.title));
      json(res, 200, {
        ...manager.store.toDetail(
          session,
          manager.getPendingApproval(id),
          manager.getPendingQuestion(id),
        ),
        isLive: manager.isLive(id),
      });
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // POST /sessions/:id/archive — soft-hide from Active tab
  const archiveMatch = /^\/sessions\/([^/]+)\/archive$/.exec(path);
  if (method === "POST" && archiveMatch) {
    const id = decodeURIComponent(archiveMatch[1]!);
    try {
      const session = manager.setArchived(id, true);
      json(res, 200, {
        ...manager.store.toDetail(
          session,
          manager.getPendingApproval(id),
          manager.getPendingQuestion(id),
        ),
        isLive: manager.isLive(id),
      });
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // POST /sessions/:id/unarchive — restore to Active tab
  const unarchiveMatch = /^\/sessions\/([^/]+)\/unarchive$/.exec(path);
  if (method === "POST" && unarchiveMatch) {
    const id = decodeURIComponent(unarchiveMatch[1]!);
    try {
      const session = manager.setArchived(id, false);
      json(res, 200, {
        ...manager.store.toDetail(
          session,
          manager.getPendingApproval(id),
          manager.getPendingQuestion(id),
        ),
        isLive: manager.isLive(id),
      });
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // POST /auth/validate
  if (method === "POST" && path === "/auth/validate") {
    json(res, 200, { ok: true, projects: config.projects.length });
    return;
  }

  json(res, 404, { error: "Not found", path });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

function requestHost(req: IncomingMessage, config: HostConfigFile): string {
  const h = req.headers.host;
  if (h) {
    const lower = h.toLowerCase();
    // Clients on another device can't use loopback — rewrite to a LAN/Tailscale address
    if (lower.startsWith("127.0.0.1") || lower.startsWith("localhost")) {
      return preferredClientHost(config.bindPort);
    }
    return h.includes(":") ? h : `${h}:${config.bindPort}`;
  }
  return preferredClientHost(config.bindPort);
}

function connectPayload(config: HostConfigFile, req: IncomingMessage) {
  const host = requestHost(req, config);
  const hostURL = `http://${host}`;
  return {
    hostURL,
    hostToken: config.hostToken,
    deepLink: `clankerspanker://configure?url=${encodeURIComponent(hostURL)}&token=${encodeURIComponent(config.hostToken)}`,
    webApp: `${hostURL}/app/`,
    projects: config.projects,
    note: "Use the browser UI at /app/, or paste hostURL + hostToken into the iOS app / deep link.",
  };
}

function serveWebStatic(req: IncomingMessage, res: ServerResponse, path: string): boolean {
  // /app → /app/index.html ; /app/foo.js → web/foo.js
  let rel = path.replace(/^\/app\/?/, "") || "index.html";
  // prevent path traversal
  rel = normalize(rel).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = resolve(WEB_ROOT, rel);
  if (!filePath.startsWith(resolve(WEB_ROOT))) {
    res.writeHead(403).end("Forbidden");
    return true;
  }
  let target = filePath;
  if (!existsSync(target) || statSync(target).isDirectory()) {
    target = join(WEB_ROOT, "index.html");
  }
  if (!existsSync(target)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Web UI not found. Expected host/web/index.html next to the host package.");
    return true;
  }
  const ext = extname(target).toLowerCase();
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".json": "application/json",
    ".ico": "image/x-icon",
  };
  const body = readFileSync(target);
  res.writeHead(200, { "Content-Type": types[ext] ?? "application/octet-stream" });
  res.end(body);
  return true;
}

function setupHtml(config: HostConfigFile, req: IncomingMessage): string {
  const payload = connectPayload(config, req);
  const token = payload.hostToken;
  const url = payload.hostURL;
  const deep = payload.deepLink;
  const webApp = payload.webApp;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ClankerSpanker Setup</title>
  <style>
    :root { color-scheme: dark; }
    body { font-family: system-ui, -apple-system, Segoe UI, sans-serif; background:#0b0b10; color:#f2f2f7;
      margin:0; padding:24px; line-height:1.45; }
    h1 { font-size:1.6rem; margin:0 0 8px; }
    p { color:#a1a1aa; margin:0 0 16px; }
    .card { background:#16161f; border:1px solid #2a2a36; border-radius:16px; padding:16px; margin:16px 0; }
    label { display:block; font-size:12px; color:#a1a1aa; margin-bottom:6px; text-transform:uppercase; letter-spacing:.04em; }
    code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; word-break:break-all; }
    .value { background:#0b0b10; border-radius:12px; padding:12px; margin-bottom:10px; border:1px solid #2a2a36; }
    button, a.btn { display:block; width:100%; box-sizing:border-box; text-align:center;
      background:#73b8ff; color:#000; font-weight:700; border:0; border-radius:14px;
      padding:14px 16px; margin:10px 0; text-decoration:none; font-size:16px; cursor:pointer; }
    a.btn.secondary { background:transparent; color:#fff; border:1px solid #3a3a4a; }
    .ok { color:#5fd68a; }
    .steps { padding-left:18px; color:#d4d4d8; }
    .steps li { margin:8px 0; }
  </style>
</head>
<body>
  <h1>ClankerSpanker</h1>
  <p>Local-first control plane for Grok Build and Claude Code on this machine. Use the browser UI, or connect the iOS app over LAN / Tailscale.</p>

  <a class="btn" href="${escapeHtml(webApp)}">Open browser UI</a>

  <div class="card">
    <label>1 · Host URL</label>
    <div class="value mono" id="url">${escapeHtml(url)}</div>
    <button type="button" onclick="copy('url')">Copy Host URL</button>

    <label style="margin-top:16px">2 · Host token</label>
    <div class="value mono" id="token">${escapeHtml(token)}</div>
    <button type="button" onclick="copy('token')">Copy Host token</button>
  </div>

  <a class="btn secondary" href="${escapeHtml(deep)}">Open iOS app (deep link)</a>
  <a class="btn secondary" href="#" onclick="copyBoth(); return false;">Copy both as text</a>

  <div class="card">
    <p class="ok">Host is online.</p>
    <ol class="steps">
      <li><strong>Browser:</strong> open the UI above — token is stored in this browser only.</li>
      <li><strong>iOS:</strong> paste Host URL + token (or deep link). Leave xAI key blank if the host machine already has Grok auth.</li>
      <li>Do not expose this port on the public internet.</li>
    </ol>
  </div>

  <script>
    function copy(id) {
      const t = document.getElementById(id).innerText.trim();
      navigator.clipboard.writeText(t).then(() => alert('Copied'));
    }
    function copyBoth() {
      const u = document.getElementById('url').innerText.trim();
      const t = document.getElementById('token').innerText.trim();
      navigator.clipboard.writeText('Host URL: ' + u + '\\nHost token: ' + t).then(() => alert('Copied both'));
    }
  </script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}
