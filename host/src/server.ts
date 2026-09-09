import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { URL } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync as fsReadFileSync, unlinkSync, writeFileSync } from "node:fs";
import type { AgentProfile, HostConfigFile, ProfileMcpServer, SessionBackend } from "./types.js";
import type {
  AnswerQuestionsRequest,
  ApproveRequest,
  AttachAgyRequest,
  AttachClaudeRequest,
  AttachRequest,
  Bot,
  DispatchRequest,
  DispatchSession,
  ProjectAttachment,
  ProjectInfo,
  ProjectResource,
  PromptFollowUpRequest,
  RejectRequest,
  SessionEvent,
  ReviewWorkRequest,
  TransferProfileRequest,
} from "./types.js";
import { isAuthorized, tokensMatch, unauthorizedBody } from "./auth.js";
import { TerminalHub } from "./terminal/session.js";
import { SessionManager } from "./acp/session-manager.js";
import type { BotRuntime } from "./bot/index.js";
import { isGrokHelperCwd, listAgySessions, listClaudeSessions, listDiskSessions } from "./sessions/reader.js";
import { preferredClientHost } from "./platform.js";
import { normalizeBackend, publicProfiles, resolveProfile, splitProfileToolFields } from "./profiles.js";
import { mcpEnvFor, normalizeMcpServers } from "./mcp.js";
import {
  completeMcpOAuth,
  logoutMcpOAuth,
  mcpOAuthRedirectUri,
  mcpOAuthStatusMap,
  startMcpOAuth,
} from "./mcp-oauth.js";
import { profilesWithUsage } from "./usage.js";
import { startProfileLogin } from "./login.js";
import {
  discoverKnownProjects,
  normalizeProject,
  projectAttachmentsDir,
  resolveProjectPath,
  saveConfig,
} from "./config.js";
import { listOutbox } from "./bot/outbox.js";
import { seedHunter } from "./bot/seed.js";
import { isLocalMachineAddr } from "./local-machine.js";

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

/**
 * True when the request originates from this machine (loopback or any of our
 * own NIC / Tailscale addresses). Gates profile admin so API keys never leave
 * this host — a phone on the LAN/Tailscale is still refused.
 */
function isLocalMachineReq(req: IncomingMessage): boolean {
  return isLocalMachineAddr(req.socket.remoteAddress);
}

export function startServer(config: HostConfigFile, manager: SessionManager, bots?: BotRuntime) {
  const server = createServer(async (req, res) => {
    try {
      await handleHttp(req, res, config, manager, bots);
    } catch (err) {
      console.error("[http]", err);
      if (!res.headersSent) {
        json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    }
  });

  // Two paths on one HTTP server. `ws` abortHandshake()s path mismatches, so a
  // second WebSocketServer({ server, path }) would kill /ws clients (status pill
  // flashing Live ↔ Offline). Route upgrades ourselves.
  const wss = new WebSocketServer({ noServer: true });
  const termWss = new WebSocketServer({ noServer: true });
  const terminals = new TerminalHub();
  const clients = new Set<WsClient>();
  const localClients = new Set<WsClient>();

  server.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).pathname;
    if (pathname === "/ws/terminal") {
      termWss.handleUpgrade(req, socket, head, (ws) => {
        termWss.emit("connection", ws, req);
      });
      return;
    }
    if (pathname === "/ws") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
      return;
    }
    socket.destroy();
  });

  function terminalAuthorized(req: IncomingMessage): boolean {
    if (isAuthorized(req, config)) return true;
    const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
    return tokensMatch(url.searchParams.get("token"), config.hostToken);
  }

  termWss.on("connection", (ws, req) => {
    if (!terminalAuthorized(req)) {
      ws.close(4401, "Unauthorized");
      return;
    }
    const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
    const cols = Number(url.searchParams.get("cols") || "80");
    const rows = Number(url.searchParams.get("rows") || "24");
    terminals.attach(ws, { cols, rows });
  });

  // Let SessionManager suppress its shell-based desktop notifications when
  // a loopback client (the Mac app) is present to post its own richer local
  // notification instead. Prevents duplicate banners.
  manager.setLocalClientChecker(() => localClients.size > 0);

  wss.on("connection", (ws: WsClient, req) => {
    // Auth via query ?token= or header
    const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
    const qToken = url.searchParams.get("token");
    const headerOk = isAuthorized(req, config);
    if (!headerOk && !tokensMatch(qToken, config.hostToken)) {
      ws.close(4401, "Unauthorized");
      return;
    }

    ws.isAlive = true;
    clients.add(ws);
    if (isLocalMachineAddr(req.socket.remoteAddress)) {
      localClients.add(ws);
    }
    ws.send(JSON.stringify({ type: "hello", at: new Date().toISOString(), version: "0.1.0" }));

    ws.on("pong", () => {
      ws.isAlive = true;
    });
    ws.on("close", () => {
      clients.delete(ws);
      localClients.delete(ws);
    });
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
        localClients.delete(ws);
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
    terminals.shutdown();
    termWss.close();
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
  bots?: BotRuntime,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = (req.method ?? "GET").toUpperCase();

  // CORS for local tooling
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Grok-Dispatch-Token");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
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

  // OAuth browser redirect — loopback only, no host token (the AS cannot send one).
  if (method === "GET" && path === "/mcp/oauth/callback") {
    if (!isLocalMachineReq(req)) {
      htmlPage(res, 403, "MCP OAuth callback is only accepted from this machine.");
      return;
    }
    const err = url.searchParams.get("error");
    const errDesc = url.searchParams.get("error_description");
    if (err) {
      htmlPage(
        res,
        400,
        `Sign-in was not completed (${escapeHtml(err)}${errDesc ? `: ${escapeHtml(errDesc)}` : ""}). Close this tab and try Sign in again.`,
      );
      return;
    }
    const code = url.searchParams.get("code") ?? "";
    const state = url.searchParams.get("state") ?? "";
    if (!code || !state) {
      htmlPage(res, 400, "Missing code or state. Close this tab and try Sign in again.");
      return;
    }
    try {
      const done = await completeMcpOAuth({ dataDir: config.dataDir, state, code });
      htmlPage(
        res,
        200,
        `Signed in to <strong>${escapeHtml(done.serverName)}</strong> for profile <strong>${escapeHtml(done.profileId)}</strong>. You can close this tab.`,
      );
    } catch (e) {
      htmlPage(
        res,
        400,
        `Could not finish MCP sign-in: ${escapeHtml(e instanceof Error ? e.message : String(e))}`,
      );
    }
    return;
  }

  if (!isAuthorized(req, config)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(unauthorizedBody());
    return;
  }

  // GET /projects
  if (method === "GET" && path === "/projects") {
    const projects = (config.projects ?? []).map(normalizeProject);
    json(res, 200, { projects, allowCustomPaths: config.allowCustomPaths });
    return;
  }

  // POST /projects — create a new project.
  // Body: { name, paths?: string[] | undefined, path?: string | undefined,
  //         color?, defaultProfileId? }
  if (method === "POST" && path === "/projects") {
    try {
      const body = (await readJson(req)) as Partial<ProjectInfo> & { path?: string };
      if (!body?.name || typeof body.name !== "string" || !body.name.trim()) {
        json(res, 400, { error: "name is required" });
        return;
      }
      const nowIso = new Date().toISOString();
      const created = normalizeProject({
        id: (body.id?.trim()) || slugForId(body.name) || randomUUID(),
        name: body.name.trim(),
        paths: Array.isArray(body.paths) ? body.paths : (body.path ? [body.path] : []),
        color: body.color,
        defaultProfileId: body.defaultProfileId,
        resources: body.resources ?? [],
        attachments: body.attachments ?? [],
        createdAt: nowIso,
        updatedAt: nowIso,
      });
      const existing = config.projects ?? [];
      if (existing.some((p) => p.id === created.id)) {
        json(res, 409, { error: `Project id "${created.id}" already exists` });
        return;
      }
      config.projects = [...existing, created];
      saveConfig(config);
      json(res, 201, { project: created });
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // GET /projects/:id
  const projectDetailMatch = /^\/projects\/([^/]+)$/.exec(path);
  if (method === "GET" && projectDetailMatch) {
    const id = decodeURIComponent(projectDetailMatch[1]!);
    const p = (config.projects ?? []).find((x) => x.id === id);
    if (!p) {
      json(res, 404, { error: "Project not found" });
      return;
    }
    json(res, 200, { project: normalizeProject(p) });
    return;
  }

  // PATCH /projects/:id — partial update.
  if (method === "PATCH" && projectDetailMatch) {
    const id = decodeURIComponent(projectDetailMatch[1]!);
    try {
      const body = (await readJson(req)) as Partial<ProjectInfo> & { path?: string };
      const projects = config.projects ?? [];
      const idx = projects.findIndex((x) => x.id === id);
      if (idx < 0) {
        json(res, 404, { error: "Project not found" });
        return;
      }
      const current = projects[idx]!;
      const merged = normalizeProject({
        ...current,
        ...body,
        id: current.id, // never let id be renamed here
        paths: Array.isArray(body.paths)
          ? body.paths
          : (typeof body.path === "string" ? [body.path] : (current.paths ?? [])),
        updatedAt: new Date().toISOString(),
      });
      projects[idx] = merged;
      config.projects = projects;
      saveConfig(config);
      json(res, 200, { project: merged });
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // DELETE /projects/:id — soft-archive by default; ?hard=1 removes entirely
  // (including on-disk attachments dir).
  if (method === "DELETE" && projectDetailMatch) {
    const id = decodeURIComponent(projectDetailMatch[1]!);
    const hard = url.searchParams.get("hard") === "1";
    const projects = config.projects ?? [];
    const idx = projects.findIndex((x) => x.id === id);
    if (idx < 0) {
      json(res, 404, { error: "Project not found" });
      return;
    }
    if (hard) {
      // Best-effort wipe of the on-disk project dir.
      try {
        const attachDir = projectAttachmentsDir(config.dataDir, id);
        for (const att of projects[idx]?.attachments ?? []) {
          try { unlinkSync(join(attachDir, att.filename)); } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
      config.projects = projects.filter((x) => x.id !== id);
    } else {
      projects[idx] = normalizeProject({
        ...projects[idx]!,
        archived: true,
        updatedAt: new Date().toISOString(),
      });
      config.projects = projects;
    }
    saveConfig(config);
    json(res, 200, { ok: true, hard });
    return;
  }

  // POST /projects/discover — return filesystem-inferred candidates without
  // adding them. Client decides which to import via POST /projects.
  if (method === "POST" && path === "/projects/discover") {
    const candidates = discoverKnownProjects();
    const existingIds = new Set((config.projects ?? []).map((p) => p.id));
    const existingPaths = new Set(
      (config.projects ?? []).flatMap((p) => (p.paths ?? []).map((x) => x)),
    );
    const filtered = candidates.filter(
      (c) => !existingIds.has(c.id) && !c.paths.some((p) => existingPaths.has(p)),
    );
    json(res, 200, { projects: filtered });
    return;
  }

  // POST /projects/:id/attachments — upload a file (base64 in JSON body).
  // Body: { data (base64), mimeType, filename?, originalName?, note?, fromSessionId? }
  // Response: { attachment: ProjectAttachment }
  const projectAttachUploadMatch = /^\/projects\/([^/]+)\/attachments$/.exec(path);
  if (method === "POST" && projectAttachUploadMatch) {
    const id = decodeURIComponent(projectAttachUploadMatch[1]!);
    const projects = config.projects ?? [];
    const idx = projects.findIndex((x) => x.id === id);
    if (idx < 0) {
      json(res, 404, { error: "Project not found" });
      return;
    }
    try {
      const body = (await readJson(req)) as {
        data: string;
        mimeType: string;
        filename?: string;
        originalName?: string;
        note?: string;
        fromSessionId?: string;
      };
      if (!body?.data || !body.mimeType) {
        json(res, 400, { error: "data (base64) and mimeType required" });
        return;
      }
      const attachment = writeProjectAttachment(config, id, body);
      const current = projects[idx]!;
      const updated = normalizeProject({
        ...current,
        attachments: [...(current.attachments ?? []), attachment],
        updatedAt: new Date().toISOString(),
      });
      projects[idx] = updated;
      config.projects = projects;
      saveConfig(config);
      json(res, 201, { attachment });
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // GET /projects/:id/attachments/:aid — serve raw bytes.
  const projectAttachGetMatch = /^\/projects\/([^/]+)\/attachments\/([^/]+)$/.exec(path);
  if (method === "GET" && projectAttachGetMatch) {
    const pid = decodeURIComponent(projectAttachGetMatch[1]!);
    const aid = decodeURIComponent(projectAttachGetMatch[2]!);
    const project = (config.projects ?? []).find((x) => x.id === pid);
    const att = project?.attachments?.find((a) => a.id === aid);
    if (!project || !att) {
      json(res, 404, { error: "Attachment not found" });
      return;
    }
    const full = join(projectAttachmentsDir(config.dataDir, pid), att.filename);
    try {
      const bytes = fsReadFileSync(full);
      res.writeHead(200, {
        "Content-Type": att.mimeType || "application/octet-stream",
        "Content-Length": String(bytes.length),
        "Cache-Control": "private, max-age=300",
      });
      res.end(bytes);
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // DELETE /projects/:id/attachments/:aid
  if (method === "DELETE" && projectAttachGetMatch) {
    const pid = decodeURIComponent(projectAttachGetMatch[1]!);
    const aid = decodeURIComponent(projectAttachGetMatch[2]!);
    const projects = config.projects ?? [];
    const pIdx = projects.findIndex((x) => x.id === pid);
    if (pIdx < 0) {
      json(res, 404, { error: "Project not found" });
      return;
    }
    const project = projects[pIdx]!;
    const att = project.attachments?.find((a) => a.id === aid);
    if (!att) {
      json(res, 404, { error: "Attachment not found" });
      return;
    }
    try { unlinkSync(join(projectAttachmentsDir(config.dataDir, pid), att.filename)); } catch { /* ignore */ }
    projects[pIdx] = normalizeProject({
      ...project,
      attachments: (project.attachments ?? []).filter((a) => a.id !== aid),
      updatedAt: new Date().toISOString(),
    });
    config.projects = projects;
    saveConfig(config);
    json(res, 200, { ok: true });
    return;
  }

  // GET /profiles — public agent accounts for nav segments (no secrets)
  // ?usage=1 attaches Claude OAuth 5h/weekly utilization (cached ~45s).
  // ?admin=1 (this machine only) additionally returns full profile records
  // (env / configDir) for the local Profiles manager UI.
  if (method === "GET" && path === "/profiles") {
    const wantUsage = url.searchParams.get("usage") === "1";
    const wantAdmin = url.searchParams.get("admin") === "1";
    const localAdmin = isLocalMachineReq(req);
    const adminPayload = wantAdmin && localAdmin
      ? {
          admin: true as const,
          adminProfiles: (config.profiles ?? []).map((p) => ({
            ...p,
            mcpOAuth: Object.fromEntries(
              Object.entries(mcpOAuthStatusMap(config.dataDir, p.id, p.mcpServers)).map(
                ([name, st]) => [
                  name,
                  {
                    connected: st.connected,
                    expired: st.expired,
                    expiresAt: st.expiresAt ? new Date(st.expiresAt).toISOString() : undefined,
                  },
                ],
              ),
            ),
          })),
        }
      : { admin: false as const };
    if (!wantUsage) {
      json(res, 200, { profiles: publicProfiles(config), ...adminPayload });
      return;
    }
    try {
      const base = publicProfiles(config);
      // Sessions feed Grok local activity (today/tools) — not fake TPM %
      let sessions: DispatchSession[] = [];
      try {
        sessions = manager.list();
      } catch {
        sessions = [];
      }
      const profiles = await profilesWithUsage(base, config.profiles ?? [], { sessions });
      json(res, 200, { profiles, usage: true, ...adminPayload });
    } catch (err) {
      json(res, 200, {
        profiles: publicProfiles(config),
        usage: false,
        usageError: err instanceof Error ? err.message : String(err),
        ...adminPayload,
      });
    }
    return;
  }

  // POST /profiles — this machine only. Creates a new profile (all fields,
  // including env / API keys / configDir). API keys must never leave this
  // host, so the gate is peer address, not just the host token.
  if (method === "POST" && path === "/profiles") {
    if (!isLocalMachineReq(req)) {
      json(res, 403, {
        error: "Profile creation is only allowed from the host machine",
      });
      return;
    }
    try {
      const body = (await readJson(req)) as Partial<AgentProfile>;
      const nameRaw = typeof body?.name === "string" ? body.name.trim() : "";
      if (!nameRaw) {
        json(res, 400, { error: "name is required" });
        return;
      }
      const backend: SessionBackend = normalizeBackend(
        typeof body.backend === "string" ? body.backend : undefined,
      );
      const idRaw = typeof body.id === "string" && body.id.trim().length > 0
        ? body.id.trim()
        : slugForId(nameRaw) || randomUUID();
      const existing = config.profiles ?? [];
      if (existing.some((p) => p.id === idRaw)) {
        json(res, 409, { error: `Profile id "${idRaw}" already exists` });
        return;
      }
      const created: AgentProfile = {
        id: idRaw,
        name: nameRaw,
        backend,
        color: (typeof body.color === "string" && body.color.trim()) || "#73B8FF",
        env: sanitizeEnv(body.env),
        claudeConfigDir: trimOrUndef(body.claudeConfigDir),
        antigravityConfigDir: trimOrUndef(body.antigravityConfigDir),
        grokHome: trimOrUndef(body.grokHome),
        model: trimOrUndef(body.model),
        systemPrompt: trimOrUndef(body.systemPrompt),
        ...splitProfileToolFields({
          toolAllowlist: Array.isArray(body.toolAllowlist) ? body.toolAllowlist : undefined,
          autoApprovalSignatures: Array.isArray(body.autoApprovalSignatures)
            ? body.autoApprovalSignatures
            : undefined,
        }),
        mcpServers: normalizeMcpServers(body.mcpServers),
      };
      config.profiles = [...existing, created];
      saveConfig(config);
      json(res, 201, {
        profile: publicProfiles(config).find((p) => p.id === created.id),
        adminProfile: created,
      });
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // PATCH /profiles/:id — safe partial update over any origin: color, model,
  // systemPrompt, toolAllowlist. On this machine also accepts name/backend/env/
  // claudeConfigDir/antigravityConfigDir/grokHome (Profiles manager on the host).
  const profilePatchMatch = path.match(/^\/profiles\/([^/]+)$/);
  if (method === "PATCH" && profilePatchMatch) {
    const profileId = decodeURIComponent(profilePatchMatch[1] ?? "");
    try {
      const body = (await readJson(req)) as {
        color?: string;
        model?: string | null;
        systemPrompt?: string | null;
        toolAllowlist?: string[] | null;
        autoApprovalSignatures?: string[] | null;
        // this-machine-only
        name?: string;
        backend?: string;
        env?: Record<string, string> | null;
        claudeConfigDir?: string | null;
        antigravityConfigDir?: string | null;
        grokHome?: string | null;
        mcpServers?: ProfileMcpServer[] | null;
      };
      const profiles = config.profiles ?? [];
      const idx = profiles.findIndex((p) => p.id === profileId);
      if (idx < 0) {
        json(res, 404, { error: "Profile not found" });
        return;
      }
      const current = profiles[idx]!;
      const next: AgentProfile = { ...current };
      if (typeof body.color === "string" && body.color.trim()) {
        next.color = body.color.trim();
      }
      if (body.model === null) {
        next.model = undefined;
      } else if (typeof body.model === "string") {
        const trimmed = body.model.trim();
        next.model = trimmed.length > 0 ? trimmed : undefined;
      }
      if (body.systemPrompt === null) {
        next.systemPrompt = undefined;
      } else if (typeof body.systemPrompt === "string") {
        const trimmed = body.systemPrompt.trim();
        next.systemPrompt = trimmed.length > 0 ? trimmed : undefined;
      }
      if (body.toolAllowlist === null) {
        next.toolAllowlist = undefined;
      } else if (Array.isArray(body.toolAllowlist)) {
        next.toolAllowlist = body.toolAllowlist;
      }
      if (body.autoApprovalSignatures === null) {
        next.autoApprovalSignatures = undefined;
      } else if (Array.isArray(body.autoApprovalSignatures)) {
        next.autoApprovalSignatures = body.autoApprovalSignatures;
      }
      if (
        body.toolAllowlist !== undefined ||
        body.autoApprovalSignatures !== undefined
      ) {
        const split = splitProfileToolFields(next);
        next.toolAllowlist = split.toolAllowlist;
        next.autoApprovalSignatures = split.autoApprovalSignatures;
      }
      // This-machine-only fields: secrets + identity. Silently ignored from other devices.
      if (isLocalMachineReq(req)) {
        if (typeof body.name === "string" && body.name.trim()) {
          next.name = body.name.trim();
        }
        if (typeof body.backend === "string" && body.backend.trim()) {
          next.backend = normalizeBackend(body.backend);
        }
        if (body.env === null) {
          next.env = {};
        } else if (body.env && typeof body.env === "object") {
          next.env = sanitizeEnv(body.env);
        }
        if (body.claudeConfigDir === null) {
          next.claudeConfigDir = undefined;
        } else if (typeof body.claudeConfigDir === "string") {
          next.claudeConfigDir = trimOrUndef(body.claudeConfigDir);
        }
        if (body.antigravityConfigDir === null) {
          next.antigravityConfigDir = undefined;
        } else if (typeof body.antigravityConfigDir === "string") {
          next.antigravityConfigDir = trimOrUndef(body.antigravityConfigDir);
        }
        if (body.grokHome === null) {
          next.grokHome = undefined;
        } else if (typeof body.grokHome === "string") {
          next.grokHome = trimOrUndef(body.grokHome);
        }
        if (body.mcpServers === null) {
          next.mcpServers = undefined;
        } else if (Array.isArray(body.mcpServers)) {
          next.mcpServers = normalizeMcpServers(body.mcpServers);
        }
      }
      profiles[idx] = next;
      config.profiles = profiles;
      saveConfig(config);
      const adminReply = isLocalMachineReq(req) ? { adminProfile: next } : {};
      json(res, 200, {
        profile: publicProfiles(config).find((p) => p.id === profileId),
        ...adminReply,
      });
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // DELETE /profiles/:id — this machine only. Refuses if a live session is
  // currently using the profile so we don't orphan an in-flight agent.
  if (method === "DELETE" && profilePatchMatch) {
    if (!isLocalMachineReq(req)) {
      json(res, 403, {
        error: "Profile deletion is only allowed from the host machine",
      });
      return;
    }
    const profileId = decodeURIComponent(profilePatchMatch[1] ?? "");
    const profiles = config.profiles ?? [];
    const idx = profiles.findIndex((p) => p.id === profileId);
    if (idx < 0) {
      json(res, 404, { error: "Profile not found" });
      return;
    }
    try {
      const live = manager.list().filter((s) => {
        if (s.profileId !== profileId) return false;
        const status = s.status;
        return status !== "completed" && status !== "cancelled" && status !== "failed";
      });
      if (live.length > 0) {
        json(res, 409, {
          error: `Profile "${profileId}" is in use by ${live.length} live session(s). Cancel or complete them first.`,
        });
        return;
      }
    } catch {
      /* manager unavailable — proceed */
    }
    config.profiles = profiles.filter((_, i) => i !== idx);
    saveConfig(config);
    json(res, 200, { ok: true, deleted: profileId });
    return;
  }

  // POST /profiles/:id/mcp/:name/oauth/start — this machine only.
  const mcpOAuthStartMatch = path.match(/^\/profiles\/([^/]+)\/mcp\/([^/]+)\/oauth\/start$/);
  if (method === "POST" && mcpOAuthStartMatch) {
    if (!isLocalMachineReq(req)) {
      json(res, 403, { error: "MCP OAuth is only allowed from the host machine" });
      return;
    }
    const profileId = decodeURIComponent(mcpOAuthStartMatch[1] ?? "");
    const serverName = decodeURIComponent(mcpOAuthStartMatch[2] ?? "");
    try {
      const profile = resolveProfile(config, profileId);
      const server = (profile.mcpServers ?? []).find((s) => s.name === serverName);
      if (!server?.url) {
        json(res, 404, { error: `HTTP MCP server "${serverName}" not found on this profile` });
        return;
      }
      const env = mcpEnvFor(profile);
      const mcpUrl = server.url.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key: string) => env[key] ?? "");
      const result = await startMcpOAuth({
        dataDir: config.dataDir,
        profileId: profile.id,
        serverName: server.name,
        mcpUrl,
        redirectUri: mcpOAuthRedirectUri(config.bindPort),
        clientId: server.oauthClientId,
        clientSecret: server.oauthClientSecret,
        scope: server.oauthScope,
      });
      json(res, 200, result);
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // POST /profiles/:id/mcp/:name/oauth/logout — this machine only.
  const mcpOAuthLogoutMatch = path.match(/^\/profiles\/([^/]+)\/mcp\/([^/]+)\/oauth\/logout$/);
  if (method === "POST" && mcpOAuthLogoutMatch) {
    if (!isLocalMachineReq(req)) {
      json(res, 403, { error: "MCP OAuth is only allowed from the host machine" });
      return;
    }
    const profileId = decodeURIComponent(mcpOAuthLogoutMatch[1] ?? "");
    const serverName = decodeURIComponent(mcpOAuthLogoutMatch[2] ?? "");
    try {
      resolveProfile(config, profileId);
      logoutMcpOAuth(config.dataDir, profileId, serverName);
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // POST /profiles/:id/login — open host browser login for this agent account
  const loginMatch = path.match(/^\/profiles\/([^/]+)\/login$/);
  if (method === "POST" && loginMatch) {
    const profileId = decodeURIComponent(loginMatch[1] ?? "");
    try {
      const profile = resolveProfile(config, profileId);
      let email: string | undefined;
      try {
        const body = await readJson(req);
        if (body && typeof (body as { email?: string }).email === "string") {
          email = (body as { email?: string }).email;
        }
      } catch {
        /* empty body ok */
      }
      // Prefer known account email from usage file if not provided
      if (!email && profile.backend === "claude") {
        try {
          const { readFileSync, existsSync } = await import("node:fs");
          const { join } = await import("node:path");
          const { homedir } = await import("node:os");
          const candidates = profile.claudeConfigDir
            ? [join(profile.claudeConfigDir, ".claude.json")]
            : [join(homedir(), ".claude.json")];
          for (const fp of candidates) {
            if (!existsSync(fp)) continue;
            const raw = JSON.parse(readFileSync(fp, "utf8")) as {
              oauthAccount?: { emailAddress?: string };
            };
            email = raw.oauthAccount?.emailAddress;
            if (email) break;
          }
        } catch {
          /* ignore */
        }
      }
      const result = startProfileLogin(profile, { email });
      if (!result.ok) {
        json(res, 400, result);
        return;
      }
      json(res, 200, result);
    } catch (err) {
      json(res, 400, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  // GET /bots
  if (method === "GET" && path === "/bots") {
    if (!bots) {
      json(res, 503, { error: "Bot runtime not started — restart the ClankerSpanker host" });
      return;
    }
    try {
      seedHunter(config, bots.store);
    } catch (err) {
      console.warn("[bot] seed on GET /bots failed:", err instanceof Error ? err.message : err);
    }
    json(res, 200, { bots: bots.store.list() });
    return;
  }

  // POST /bots
  if (method === "POST" && path === "/bots") {
    if (!bots) {
      json(res, 503, { error: "Bot runtime not started" });
      return;
    }
    try {
      const body = (await readJson(req)) as Partial<Bot> & {
        name: string;
        profileId: string;
        projectId: string;
        job: string;
      };
      const profile = config.profiles.find((p) => p.id === body.profileId);
      if (!profile) throw new Error("Unknown profileId");
      const created = bots.store.create(body);
      json(res, 201, { bot: created });
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  const botItemMatch = /^\/bots\/([^/]+)$/.exec(path);
  const botRunMatch = /^\/bots\/([^/]+)\/run$/.exec(path);
  const botOutboxMatch = /^\/bots\/([^/]+)\/outbox$/.exec(path);

  // GET /bots/:id
  if (method === "GET" && botItemMatch && !botRunMatch && !botOutboxMatch) {
    if (!bots) {
      json(res, 503, { error: "Bot runtime not started" });
      return;
    }
    const id = decodeURIComponent(botItemMatch[1] ?? "");
    const bot = bots.store.get(id);
    if (!bot) {
      json(res, 404, { error: "Bot not found" });
      return;
    }
    let lastSession = null;
    if (bot.lastSessionId) {
      const s = manager.get(bot.lastSessionId);
      if (s) lastSession = manager.store.toSummary(s, manager.isLive(bot.lastSessionId));
    }
    json(res, 200, { bot, lastSession });
    return;
  }

  // GET /bots/:id/outbox — drafts written under the bot project's .bot-outbox/
  if (method === "GET" && botOutboxMatch) {
    if (!bots) {
      json(res, 503, { error: "Bot runtime not started" });
      return;
    }
    try {
      const id = decodeURIComponent(botOutboxMatch[1] ?? "");
      const bot = bots.store.get(id);
      if (!bot) {
        json(res, 404, { error: "Bot not found" });
        return;
      }
      const { path: cwd } = resolveProjectPath(config, bot.projectId);
      json(res, 200, { botId: bot.id, cwd, items: listOutbox(cwd) });
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // PATCH /bots/:id
  if (method === "PATCH" && botItemMatch) {
    if (!bots) {
      json(res, 503, { error: "Bot runtime not started" });
      return;
    }
    try {
      const id = decodeURIComponent(botItemMatch[1] ?? "");
      const raw = (await readJson(req)) as Record<string, unknown>;
      const body: Partial<Bot> = {};
      for (const [k, v] of Object.entries(raw)) {
        if (v !== null && v !== undefined) (body as Record<string, unknown>)[k] = v;
      }
      if (body.profileId) {
        const profile = config.profiles.find((p) => p.id === body.profileId);
        if (!profile) throw new Error("Unknown profileId");
      }
      const updated = bots.store.update(id, body);
      json(res, 200, { bot: updated });
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // POST /bots/:id/run — manual fire (allowed even when disabled, for testing)
  if (method === "POST" && botRunMatch) {
    if (!bots) {
      json(res, 503, { error: "Bot runtime not started" });
      return;
    }
    try {
      const id = decodeURIComponent(botRunMatch[1] ?? "");
      const bot = bots.store.get(id);
      if (!bot) {
        json(res, 404, { error: "Bot not found" });
        return;
      }
      if (manager.hasActiveRun(bot.id)) {
        json(res, 409, { error: "Bot already has a running or awaiting_approval session" });
        return;
      }
      const body = (await readJson(req).catch(() => ({}))) as { note?: string };
      const session = await manager.fireBot(bot, body.note);
      bots.store.update(bot.id, {
        lastRunAt: new Date().toISOString(),
        lastSessionId: session.id,
      });
      json(res, 202, { session: manager.store.toSummary(session, true), bot: bots.store.get(bot.id) });
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // GET /sessions
  // Default: only non-archived in `sessions`. Archived live in `archivedSessions`.
  // Pass ?includeArchived=1 to put everything in `sessions` (legacy / debugging).
  if (method === "GET" && path === "/sessions") {
    const includeArchived = url.searchParams.get("includeArchived") === "1";
    const contentQuery = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    // Mirror Grok Build TUI: pull any on-disk sessions not yet in the Dispatch store
    // (cheap metadata import — agent process only starts on first attach/follow-up).
    if (url.searchParams.get("noImport") !== "1") {
      try {
        manager.syncGrokDiskSessions(200);
      } catch (err) {
        console.warn("[sessions] disk import failed:", err);
      }
    }
    const rawSessions = manager.list().filter((s) => {
      // Grok subagent worktrees are not operator sessions.
      if (isGrokHelperCwd(s.cwd)) return false;
      if (!contentQuery) return true;
      return sessionMatchesContentQuery(s, contentQuery);
    });
    const all = rawSessions.map((s) => {
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
        antigravityConversationId: s.antigravityConversationId,
      };
    });
    const active = all.filter((s) => !s.archived);
    const archived = all.filter((s) => s.archived);
    const linkedGrok = new Set(
      all.map((s) => s.grokSessionId).filter((id): id is string => Boolean(id)),
    );
    const linkedClaude = new Set(
      all.map((s) => s.claudeSessionId).filter((id): id is string => Boolean(id)),
    );
    // Only return disk hints that still need a one-tap attach (unlinked / no cwd skipped).
    // When q is set, also filter disk titles/cwd.
    let disk = listDiskSessions(200).filter(
      (d) => !linkedGrok.has(d.id) && !manager.isForgottenGrokSession(d.id),
    );
    let claude = listClaudeSessions(100).filter(
      (d) => !linkedClaude.has(d.id) && !manager.isForgottenClaudeSession(d.id),
    );
    const linkedAgy = new Set(
      all.map((s) => s.antigravityConversationId).filter((id): id is string => Boolean(id)),
    );
    let agy = listAgySessions(100).filter(
      (d) => !linkedAgy.has(d.id) && !manager.isForgottenAgySession(d.id),
    );
    if (contentQuery) {
      disk = disk.filter(
        (d) =>
          (d.title ?? "").toLowerCase().includes(contentQuery) ||
          (d.cwd ?? "").toLowerCase().includes(contentQuery) ||
          d.id.toLowerCase().includes(contentQuery),
      );
      claude = claude.filter(
        (d) =>
          (d.title ?? "").toLowerCase().includes(contentQuery) ||
          (d.cwd ?? "").toLowerCase().includes(contentQuery) ||
          d.id.toLowerCase().includes(contentQuery),
      );
      agy = agy.filter(
        (d) =>
          (d.title ?? "").toLowerCase().includes(contentQuery) ||
          (d.cwd ?? "").toLowerCase().includes(contentQuery) ||
          d.id.toLowerCase().includes(contentQuery),
      );
    }
    json(res, 200, {
      sessions: includeArchived ? all : active,
      archivedSessions: archived,
      diskSessions: disk,
      claudeSessions: claude,
      agySessions: agy,
      query: contentQuery || undefined,
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

  // GET /sessions/:id/events?since=N — replay events emitted after N.
  // iOS calls this on WebSocket reconnect to fill the gap.
  const eventsMatch = /^\/sessions\/([^/]+)\/events$/.exec(path);
  if (method === "GET" && eventsMatch) {
    const id = decodeURIComponent(eventsMatch[1]!);
    const sinceRaw = url.searchParams.get("since");
    const sinceSeq = sinceRaw !== null ? Number.parseInt(sinceRaw, 10) : 0;
    if (Number.isNaN(sinceSeq) || sinceSeq < 0) {
      json(res, 400, { error: "invalid ?since= (want non-negative integer)" });
      return;
    }
    const events = manager.getEventsSince(id, sinceSeq);
    json(res, 200, { events });
    return;
  }

  // GET /sessions/:id/tool-calls/:toolCallId — full rawInput/content for the ellipsis sheet
  const toolCallMatch = /^\/sessions\/([^/]+)\/tool-calls\/([^/]+)$/.exec(path);
  if (method === "GET" && toolCallMatch) {
    const id = decodeURIComponent(toolCallMatch[1]!);
    const toolCallId = decodeURIComponent(toolCallMatch[2]!);
    const detail = manager.getToolCall(id, toolCallId);
    if (!detail) {
      json(res, 404, { error: "Tool call not found" });
      return;
    }
    json(res, 200, detail);
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

  // GET /sessions/:id/files — cwd, extra dirs, tool locations, attachments
  const filesMatch = /^\/sessions\/([^/]+)\/files$/.exec(path);
  if (method === "GET" && filesMatch) {
    const id = decodeURIComponent(filesMatch[1]!);
    try {
      json(res, 200, { files: manager.listFiles(id) });
    } catch (err) {
      json(res, 404, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // GET /sessions/:id/file?path= — read a workspace file (allowlisted roots only)
  const fileMatch = /^\/sessions\/([^/]+)\/file$/.exec(path);
  if (method === "GET" && fileMatch) {
    const id = decodeURIComponent(fileMatch[1]!);
    const filePath = url.searchParams.get("path") ?? "";
    try {
      json(res, 200, manager.readFile(id, filePath));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = /not found/i.test(msg) ? 404 : /outside/i.test(msg) ? 403 : 400;
      json(res, code, { error: msg });
    }
    return;
  }

  // PATCH /sessions/:id/extra-dirs — add extra workspace folders mid-session
  const extraDirsMatch = /^\/sessions\/([^/]+)\/extra-dirs$/.exec(path);
  if (method === "PATCH" && extraDirsMatch) {
    const id = decodeURIComponent(extraDirsMatch[1]!);
    try {
      const body = (await readJson(req)) as { extraDirs?: string[] };
      const session = manager.addExtraDirs(id, body.extraDirs ?? []);
      json(
        res,
        200,
        manager.store.toDetail(session, manager.getPendingApproval(id), manager.getPendingQuestion(id)),
      );
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // POST /dispatch
  if (method === "POST" && path === "/dispatch") {
    const body = (await readJson(req)) as DispatchRequest;
    try {
      if (!body.botId && bots) {
        const profileId = body.profileId;
        const match = bots.store.list().find((b) => !profileId || b.profileId === profileId);
        const profile = profileId ? config.profiles.find((p) => p.id === profileId) : undefined;
        if (profile?.backend === "bot" && match) body.botId = match.id;
      }
      const session = await manager.dispatch(body);
      if (session.botId && bots?.store.get(session.botId)) {
        try {
          bots.store.update(session.botId, {
            lastRunAt: new Date().toISOString(),
            lastSessionId: session.id,
          });
        } catch {
          /* non-fatal */
        }
      }
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

  // POST /sessions/attach-agy — resume an Antigravity / Gemini CLI conversation
  if (method === "POST" && path === "/sessions/attach-agy") {
    const body = (await readJson(req)) as AttachAgyRequest;
    try {
      const session = await manager.attachAgy(body);
      json(res, 201, {
        ...manager.store.toDetail(
          session,
          manager.getPendingApproval(session.id),
          manager.getPendingQuestion(session.id),
        ),
        isLive: manager.isLive(session.id),
        backend: session.backend ?? "antigravity",
        antigravityConversationId: session.antigravityConversationId,
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
        body.scope ?? "once",
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

  // POST /sessions/:id/close — shut down the agent and mark completed+archived.
  // "I've reached a natural stopping point" — distinct from cancel (interrupted)
  // and archive (soft-hide without stopping the process).
  const closeMatch = /^\/sessions\/([^/]+)\/close$/.exec(path);
  if (method === "POST" && closeMatch) {
    const id = decodeURIComponent(closeMatch[1]!);
    try {
      const session = await manager.closeAsDone(id);
      json(res, 200, manager.store.toDetail(session, null));
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // DELETE /sessions/:id — permanent delete. Cancels first if running,
  // then wipes the session JSON and attachments dir. Tasks/notes on the
  // session record go with it; project attachments promoted from this
  // session are left alone (they're independent project resources).
  const sessionDeleteMatch = /^\/sessions\/([^/]+)$/.exec(path);
  if (method === "DELETE" && sessionDeleteMatch) {
    const id = decodeURIComponent(sessionDeleteMatch[1]!);
    try {
      await manager.deleteSession(id);
      json(res, 200, { ok: true });
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

  // ── Tasks + Notes ────────────────────────────────────────────────

  // GET /tasks?status=open — global list across every session on this host.
  if (method === "GET" && path === "/tasks") {
    const rawStatus = url.searchParams.get("status");
    const status =
      rawStatus === "open" || rawStatus === "done" ? rawStatus : undefined;
    json(res, 200, { tasks: manager.listTasks({ status }) });
    return;
  }

  // POST /sessions/:id/tasks — create a task on this session.
  // Body: { text, sourceMessageId? }
  const sessionTasksMatch = /^\/sessions\/([^/]+)\/tasks$/.exec(path);
  if (method === "POST" && sessionTasksMatch) {
    const id = decodeURIComponent(sessionTasksMatch[1]!);
    try {
      const body = (await readJson(req)) as { text?: string; sourceMessageId?: string };
      const task = manager.createTask(id, {
        text: body.text ?? "",
        sourceMessageId: body.sourceMessageId,
      });
      json(res, 201, { task });
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // PATCH /sessions/:id/tasks/:tid — update text and/or status.
  // DELETE /sessions/:id/tasks/:tid — remove.
  const taskItemMatch = /^\/sessions\/([^/]+)\/tasks\/([^/]+)$/.exec(path);
  if (taskItemMatch && (method === "PATCH" || method === "DELETE")) {
    const sid = decodeURIComponent(taskItemMatch[1]!);
    const tid = decodeURIComponent(taskItemMatch[2]!);
    try {
      if (method === "PATCH") {
        const body = (await readJson(req)) as {
          text?: string;
          status?: "open" | "done";
        };
        const task = manager.updateTask(sid, tid, body);
        json(res, 200, { task });
      } else {
        manager.deleteTask(sid, tid);
        json(res, 200, { ok: true });
      }
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // POST /sessions/:id/notes — create a note on this session.
  const sessionNotesMatch = /^\/sessions\/([^/]+)\/notes$/.exec(path);
  if (method === "POST" && sessionNotesMatch) {
    const id = decodeURIComponent(sessionNotesMatch[1]!);
    try {
      const body = (await readJson(req)) as { text?: string; sourceMessageId?: string };
      const note = manager.createNote(id, {
        text: body.text ?? "",
        sourceMessageId: body.sourceMessageId,
      });
      json(res, 201, { note });
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // PATCH /sessions/:id/notes/:nid — update text.
  // DELETE /sessions/:id/notes/:nid — remove.
  const noteItemMatch = /^\/sessions\/([^/]+)\/notes\/([^/]+)$/.exec(path);
  if (noteItemMatch && (method === "PATCH" || method === "DELETE")) {
    const sid = decodeURIComponent(noteItemMatch[1]!);
    const nid = decodeURIComponent(noteItemMatch[2]!);
    try {
      if (method === "PATCH") {
        const body = (await readJson(req)) as { text?: string };
        const note = manager.updateNote(sid, nid, body);
        json(res, 200, { note });
      } else {
        manager.deleteNote(sid, nid);
        json(res, 200, { ok: true });
      }
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // POST /sessions/:id/project — assign or detach a project.
  // Body: { projectId: string | null }
  const projectMoveMatch = /^\/sessions\/([^/]+)\/project$/.exec(path);
  if (method === "POST" && projectMoveMatch) {
    const id = decodeURIComponent(projectMoveMatch[1]!);
    try {
      const body = (await readJson(req)) as { projectId?: string | null };
      const session = manager.setSessionProject(id, body?.projectId ?? null);
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

  // POST /sessions/:id/transfer — move chat to another profile (FullScore → Personal, …)
  const transferMatch = /^\/sessions\/([^/]+)\/transfer$/.exec(path);
  if (method === "POST" && transferMatch) {
    const id = decodeURIComponent(transferMatch[1]!);
    const body = (await readJson(req)) as TransferProfileRequest;
    try {
      const session = await manager.transferProfile(id, body);
      json(res, 200, {
        ...manager.store.toDetail(
          session,
          manager.getPendingApproval(id),
          manager.getPendingQuestion(id),
        ),
        isLive: manager.isLive(id),
        backend: session.backend ?? "grok",
        claudeSessionId: session.claudeSessionId,
      });
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // POST /sessions/:id/reincarnate — archive old chat, fresh session with summary
  const reincarnateMatch = /^\/sessions\/([^/]+)\/reincarnate$/.exec(path);
  if (method === "POST" && reincarnateMatch) {
    const id = decodeURIComponent(reincarnateMatch[1]!);
    const body = (await readJson(req).catch(() => ({}))) as {
      profileId?: string;
      title?: string;
      note?: string;
    };
    try {
      const session = await manager.reincarnate(id, body ?? {});
      json(res, 201, {
        ...manager.store.toDetail(
          session,
          manager.getPendingApproval(session.id),
          manager.getPendingQuestion(session.id),
        ),
        isLive: manager.isLive(session.id),
        backend: session.backend ?? "grok",
        reincarnatedFrom: id,
      });
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // POST /sessions/:id/review — non-destructive critique of recent work (sibling session)
  const reviewMatch = /^\/sessions\/([^/]+)\/review$/.exec(path);
  if (method === "POST" && reviewMatch) {
    const id = decodeURIComponent(reviewMatch[1]!);
    const body = (await readJson(req).catch(() => ({}))) as ReviewWorkRequest;
    try {
      const session = await manager.reviewWork(id, body ?? {});
      json(res, 201, {
        ...manager.store.toDetail(
          session,
          manager.getPendingApproval(session.id),
          manager.getPendingQuestion(session.id),
        ),
        isLive: manager.isLive(session.id),
        backend: session.backend ?? "grok",
        reviewedFrom: id,
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

function htmlPage(res: ServerResponse, status: number, message: string): void {
  const body = `<!doctype html>
<html><head><meta charset="utf-8"><title>ClankerSpanker MCP</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0b0b10; color: #f2f2f7;
    max-width: 32rem; margin: 12vh auto; padding: 0 16px; line-height: 1.45; }
  a { color: #73b8ff; }
</style></head>
<body>
  <p>${message}</p>
</body></html>`;
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}

/**
 * Derive a URL-safe id from a display name for user-created projects.
 * Returns "" if the name has no ascii/word characters; caller then falls
 * back to a UUID.
 */
function slugForId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function trimOrUndef(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

/**
 * Coerce a raw env body into a clean string→string map. Skips non-string
 * values and empty keys. Used when creating/editing profiles via the local
 * Profiles manager so bad shapes don't blow up saveConfig.
 */
function sanitizeEnv(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = k?.trim();
    if (!key) continue;
    if (typeof v !== "string") continue;
    out[key] = v;
  }
  return out;
}

/**
 * Write an uploaded attachment to the project's on-disk attachments dir
 * and return the metadata record. Extension is derived from mimeType.
 */
function writeProjectAttachment(
  config: HostConfigFile,
  projectId: string,
  body: {
    data: string;
    mimeType: string;
    filename?: string;
    originalName?: string;
    note?: string;
    fromSessionId?: string;
  },
): ProjectAttachment {
  const id = randomUUID();
  const ext = extForMime(body.mimeType);
  const filename = body.filename?.trim() || `${id}${ext ? "." + ext : ""}`;
  const bytes = Buffer.from(body.data, "base64");
  const dir = projectAttachmentsDir(config.dataDir, projectId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), bytes);
  return {
    id,
    filename,
    originalName: body.originalName,
    mimeType: body.mimeType,
    sizeBytes: bytes.length,
    addedAt: new Date().toISOString(),
    fromSessionId: body.fromSessionId,
    note: body.note,
  };
}

function extForMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes("png")) return "png";
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  if (m.includes("webp")) return "webp";
  if (m.includes("gif")) return "gif";
  if (m.includes("pdf")) return "pdf";
  if (m.includes("json")) return "json";
  if (m.includes("plain") || m.includes("text/")) return "txt";
  return "";
}

/** Full-text match across title, path, and transcript/tool content (for `?q=`). */
function sessionMatchesContentQuery(s: DispatchSession, q: string): boolean {
  const parts: string[] = [
    s.title,
    s.prompt,
    s.cwd,
    s.model,
    s.status,
    s.error ?? "",
    s.profileName ?? "",
    s.profileId ?? "",
    s.backend ?? "",
    s.projectId ?? "",
    s.grokSessionId ?? "",
    s.claudeSessionId ?? "",
    s.antigravityConversationId ?? "",
  ];
  for (const t of s.transcript ?? []) {
    parts.push(t.role, t.text);
  }
  for (const t of s.toolCalls ?? []) {
    parts.push(t.title, t.kind ?? "", t.status);
  }
  if (s.plan) {
    for (const p of s.plan) parts.push(p.content, p.status ?? "");
  }
  const hay = parts.join("\n").toLowerCase();
  // Multi-word: every token must appear (AND). Single phrase still works as one token.
  const tokens = q
    .split(/[^a-z0-9._-]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return hay.includes(q);
  return tokens.every((t) => hay.includes(t));
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
