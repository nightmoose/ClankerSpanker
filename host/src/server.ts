import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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
    console.log(`[server] Grok Dispatch Host listening on http://${config.bindHost}:${config.bindPort}`);
    console.log(`[server] WebSocket: ws://${config.bindHost}:${config.bindPort}/ws?token=<hostToken>`);
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
      version: "0.2.0",
      name: "ClankerSpanker",
      time: new Date().toISOString(),
    });
    return;
  }

  // Phone-friendly setup page (local network / Tailscale only — do not expose publicly)
  if (method === "GET" && (path === "/setup" || path === "/")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(setupHtml(config, req));
    return;
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

  // GET /sessions
  // Default: only non-archived in `sessions`. Archived live in `archivedSessions`.
  // Pass ?includeArchived=1 to put everything in `sessions` (legacy / debugging).
  if (method === "GET" && path === "/sessions") {
    const includeArchived = url.searchParams.get("includeArchived") === "1";
    const all = manager.list().map((s) => ({
      ...manager.store.toSummary(s, manager.isLive(s.id)),
      isLive: manager.isLive(s.id),
      backend: s.backend ?? "grok",
      claudeSessionId: s.claudeSessionId,
    }));
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
      const session = await manager.followUp(id, body.prompt);
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
    // Phone can't use 127.0.0.1 — rewrite to LAN IP if we know it
    if (lower.startsWith("127.0.0.1") || lower.startsWith("localhost")) {
      const lan = process.env.GROK_DISPATCH_LAN_URL?.replace(/^https?:\/\//, "");
      if (lan) return lan.includes(":") ? lan : `${lan}:${config.bindPort}`;
      // Common home LAN for this Mac Mini (updated by install script / env)
      return `192.168.50.9:${config.bindPort}`;
    }
    return h.includes(":") ? h : `${h}:${config.bindPort}`;
  }
  return `192.168.50.9:${config.bindPort}`;
}

function connectPayload(config: HostConfigFile, req: IncomingMessage) {
  const host = requestHost(req, config);
  const hostURL = `http://${host}`;
  return {
    hostURL,
    hostToken: config.hostToken,
    deepLink: `clankerspanker://configure?url=${encodeURIComponent(hostURL)}&token=${encodeURIComponent(config.hostToken)}`,
    projects: config.projects,
    note: "Paste hostURL + hostToken into the Grok Dispatch app, or open the deepLink on your iPhone.",
  };
}

function setupHtml(config: HostConfigFile, req: IncomingMessage): string {
  const payload = connectPayload(config, req);
  const token = payload.hostToken;
  const url = payload.hostURL;
  const deep = payload.deepLink;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ClankerSpanker Setup</title>
  <style>
    :root { color-scheme: dark; }
    body { font-family: -apple-system, system-ui, sans-serif; background:#0b0b10; color:#f2f2f7;
      margin:0; padding:24px; line-height:1.45; }
    h1 { font-size:1.6rem; margin:0 0 8px; }
    p { color:#a1a1aa; margin:0 0 16px; }
    .card { background:#16161f; border:1px solid #2a2a36; border-radius:16px; padding:16px; margin:16px 0; }
    label { display:block; font-size:12px; color:#a1a1aa; margin-bottom:6px; text-transform:uppercase; letter-spacing:.04em; }
    code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break:break-all; }
    .value { background:#0b0b10; border-radius:12px; padding:12px; margin-bottom:10px; border:1px solid #2a2a36; }
    button, a.btn { display:block; width:100%; box-sizing:border-box; text-align:center;
      background:#73b8ff; color:#000; font-weight:700; border:0; border-radius:14px;
      padding:14px 16px; margin:10px 0; text-decoration:none; font-size:16px; }
    a.btn.secondary { background:transparent; color:#fff; border:1px solid #3a3a4a; }
    .ok { color:#5fd68a; }
    .steps { padding-left:18px; color:#d4d4d8; }
    .steps li { margin:8px 0; }
  </style>
</head>
<body>
  <h1>ClankerSpanker</h1>
  <p>Use these exact values in the iPhone app. Phone and Mac must be on the same Wi‑Fi or both on Tailscale. Controls Grok Build + Claude Code on this Mac.</p>

  <div class="card">
    <label>1 · Host URL</label>
    <div class="value mono" id="url">${escapeHtml(url)}</div>
    <button type="button" onclick="copy('url')">Copy Host URL</button>

    <label style="margin-top:16px">2 · Host token</label>
    <div class="value mono" id="token">${escapeHtml(token)}</div>
    <button type="button" onclick="copy('token')">Copy Host token</button>
  </div>

  <a class="btn" href="${escapeHtml(deep)}">Open &amp; auto-fill ClankerSpanker</a>
  <a class="btn secondary" href="#" onclick="copyBoth(); return false;">Copy both as text</a>

  <div class="card">
    <p class="ok">Host is online.</p>
    <ol class="steps">
      <li>Copy Host URL and Host token (or tap auto-fill).</li>
      <li>Leave <strong>xAI API key</strong> blank — the Mac already has Grok auth.</li>
      <li>Tap <strong>Save &amp; connect</strong>.</li>
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
