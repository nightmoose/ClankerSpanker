import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "./acp/session-manager.js";
import { loadConfig, MCP_DEFAULT_MAX_CONCURRENT, MCP_DEFAULT_TASK_TIMEOUT_MS } from "./config.js";
import {
  attachMcpTaskGuards,
  createMcpOnlyServer,
  effectiveAllowedRoots,
  handleMcpHttp,
  pathIsInsideRoot,
  resolveTaskCwd,
} from "./mcp-gateway.js";
import { startServer } from "./server.js";
import type { DispatchSession, HostConfigFile, SessionEvent } from "./types.js";

const HOST = "h".repeat(32);
const MCP = "m".repeat(32);

function testConfig(dataDir: string, root: string, extra: Partial<HostConfigFile> = {}): HostConfigFile {
  return {
    hostId: "host-test",
    hostToken: HOST,
    bindHost: "127.0.0.1",
    bindPort: 0,
    grokBinary: "/bin/echo",
    projects: [{ id: "repo", name: "Repo", path: root, paths: [root] }],
    allowCustomPaths: false,
    profiles: [
      { id: "grok-main", name: "Grok", backend: "grok", color: "#73B8FF", model: "grok-build" },
      { id: "claude-main", name: "Claude", backend: "claude", color: "#A78BFA", model: "claude" },
    ],
    autoApproveKinds: ["read"],
    notifyDesktop: false,
    dataDir,
    mcpGateway: {
      token: MCP,
      allowedRoots: [root],
      taskTimeoutMs: 60_000,
      maxConcurrent: 2,
    },
    ...extra,
  };
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function call(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        method,
        path,
        headers: payload
          ? { "Content-Type": "application/json", ...headers, "Content-Length": Buffer.byteLength(payload) }
          : headers,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

function silenceRun(manager: SessionManager) {
  return vi
    .spyOn(manager as unknown as { runSession: () => Promise<void> }, "runSession")
    .mockResolvedValue(undefined);
}

const dirs: string[] = [];
const servers: Server[] = [];
const managers: SessionManager[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const manager of managers.splice(0)) manager.stopApprovalSweeper();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fresh(): { dir: string; root: string; config: HostConfigFile; manager: SessionManager } {
  const dir = mkdtempSync(join(tmpdir(), "cs-mcp-"));
  dirs.push(dir);
  const root = join(dir, "repo");
  mkdirSync(root);
  const config = testConfig(dir, root);
  const manager = new SessionManager(config);
  managers.push(manager);
  return { dir, root, config, manager };
}

async function mcpServer(config: HostConfigFile, manager: SessionManager): Promise<number> {
  const server = createServer((req, res) => {
    void handleMcpHttp(req, res, config, manager);
  });
  servers.push(server);
  return listen(server);
}

const mcpHeaders = {
  Authorization: `Bearer ${MCP}`,
  Accept: "application/json, text/event-stream",
};

function rpc(method: string, params?: unknown, id: number | string = 1) {
  return { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
}

function toolPayload(text: string): { content: Array<{ text: string }>; isError?: boolean } {
  const body = JSON.parse(text) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  return body.result;
}

describe("mcpGateway config", () => {
  it("fills defaults, drops a relative root, and refuses a port that matches the gateway", () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-mcp-cfg-"));
    dirs.push(dir);
    const path = join(dir, "config.json");
    writeFileSync(
      path,
      JSON.stringify({
        hostToken: HOST,
        bindPort: 8787,
        serveBindPort: 8788,
        dataDir: dir,
        mcpGateway: {
          allowedRoots: ["relative/nope", "~/unused"],
          publicBindPort: 8787,
          taskTimeoutMs: "nope",
          maxConcurrent: -1,
        },
      }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const loaded = loadConfig(path);
    warn.mockRestore();
    expect(loaded.mcpGateway?.taskTimeoutMs).toBe(MCP_DEFAULT_TASK_TIMEOUT_MS);
    expect(loaded.mcpGateway?.maxConcurrent).toBe(MCP_DEFAULT_MAX_CONCURRENT);
    expect(loaded.mcpGateway?.allowedRoots).toEqual([join(homedir(), "unused")]);
    expect(loaded.mcpGateway?.publicBindPort).toBeUndefined();
  });

  it("keeps an absolute root and a distinct public port", () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-mcp-cfg-"));
    dirs.push(dir);
    const root = join(dir, "work");
    const path = join(dir, "config.json");
    writeFileSync(
      path,
      JSON.stringify({
        hostToken: HOST,
        bindPort: 8787,
        dataDir: dir,
        mcpGateway: { token: "  secret-token  ", allowedRoots: [root], publicBindPort: "8790", taskTimeoutMs: 0, maxConcurrent: 0 },
      }),
    );
    const loaded = loadConfig(path);
    expect(loaded.mcpGateway).toMatchObject({
      token: "secret-token",
      allowedRoots: [root],
      publicBindPort: 8790,
      taskTimeoutMs: 0,
      maxConcurrent: 0,
    });
  });

  it("lets GROK_DISPATCH_MCP_TOKEN override the file token", () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-mcp-cfg-"));
    dirs.push(dir);
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ hostToken: HOST, dataDir: dir, mcpGateway: { token: "file-token" } }));
    const prev = process.env.GROK_DISPATCH_MCP_TOKEN;
    process.env.GROK_DISPATCH_MCP_TOKEN = "env-token";
    try {
      expect(loadConfig(path).mcpGateway?.token).toBe("env-token");
    } finally {
      if (prev === undefined) delete process.env.GROK_DISPATCH_MCP_TOKEN;
      else process.env.GROK_DISPATCH_MCP_TOKEN = prev;
    }
  });
});

describe("MCP working directory jail", () => {
  it("allows a subdirectory and refuses a sibling prefix and a symlink that leaves the root", () => {
    const { root, config } = fresh();
    const sub = join(root, "pkg");
    mkdirSync(sub);
    const evil = join(root, "..", "repo-evil");
    mkdirSync(evil);
    symlinkSync(evil, join(root, "escape"));
    expect(pathIsInsideRoot(sub, root)).toBe(true);
    expect(pathIsInsideRoot(evil, root)).toBe(false);
    expect(pathIsInsideRoot(join(root, "escape"), root)).toBe(false);
    expect(resolveTaskCwd(config, undefined, sub).path).toBe(sub);
    expect(() => resolveTaskCwd(config, undefined, evil)).toThrow(/allowlist/);
    expect(() => resolveTaskCwd(config, undefined, join(root, "escape"))).toThrow(/allowlist/);
  });

  it("uses project paths when allowedRoots is empty", () => {
    const { dir, root } = fresh();
    const config = testConfig(dir, root, { mcpGateway: { token: MCP } });
    expect(effectiveAllowedRoots(config)).toEqual([root]);
    expect(resolveTaskCwd(config, "repo").path).toBe(root);
  });
});

describe("MCP protocol", () => {
  it("answers legacy initialize and tools/list without modern headers", async () => {
    const { config, manager } = fresh();
    const port = await mcpServer(config, manager);
    const init = await call(port, "POST", "/mcp", mcpHeaders, rpc("initialize", { protocolVersion: "2025-06-18" }));
    expect(init.status).toBe(200);
    expect(JSON.parse(init.text).result.protocolVersion).toBe("2025-06-18");
    const list = await call(port, "POST", "/mcp", mcpHeaders, rpc("tools/list"));
    const names = JSON.parse(list.text).result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toEqual([
      "list_engines",
      "list_repos",
      "list_sessions",
      "start_task",
      "get_task",
      "get_output",
      "send_followup",
      "cancel_task",
      "get_result",
    ]);
  });

  it("requires Mcp-Method on protocol 2026-07-28 and lists tools when the headers match", async () => {
    const { config, manager } = fresh();
    const port = await mcpServer(config, manager);
    const missing = await call(
      port,
      "POST",
      "/mcp",
      { ...mcpHeaders, "MCP-Protocol-Version": "2026-07-28" },
      rpc("tools/list", {}),
    );
    expect(missing.status).toBe(400);
    expect(JSON.parse(missing.text).error.code).toBe(-32020);

    const ok = await call(
      port,
      "POST",
      "/mcp",
      { ...mcpHeaders, "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/list" },
      rpc("server/discover", {}),
    );
    // discover is a different method; a mismatched Mcp-Method is a header error.
    expect(ok.status).toBe(400);

    const discovered = await call(
      port,
      "POST",
      "/mcp",
      { ...mcpHeaders, "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "server/discover" },
      rpc("server/discover", {}),
    );
    expect(discovered.status).toBe(200);
    expect(JSON.parse(discovered.text).result.supportedVersions).toContain("2026-07-28");
  });

  it("rejects an unknown protocol version", async () => {
    const { config, manager } = fresh();
    const port = await mcpServer(config, manager);
    const res = await call(
      port,
      "POST",
      "/mcp",
      { ...mcpHeaders, "MCP-Protocol-Version": "1900-01-01", "Mcp-Method": "ping" },
      rpc("ping"),
    );
    expect(res.status).toBe(400);
    expect(JSON.parse(res.text).error).toMatchObject({ code: -32022, data: { requested: "1900-01-01" } });
  });

  it("accepts a notification with 202 and an empty body", async () => {
    const { config, manager } = fresh();
    const port = await mcpServer(config, manager);
    const res = await call(port, "POST", "/mcp", mcpHeaders, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.status).toBe(202);
    expect(res.text).toBe("");
  });

  it("returns 401 without a bearer token, 403 for a foreign origin, and 405 for GET", async () => {
    const { config, manager } = fresh();
    const port = await mcpServer(config, manager);
    expect((await call(port, "POST", "/mcp", { Accept: "application/json" }, rpc("ping"))).status).toBe(401);
    expect(
      (await call(port, "POST", "/mcp", { ...mcpHeaders, Origin: "https://evil.example" }, rpc("ping"))).status,
    ).toBe(403);
    expect((await call(port, "POST", "/mcp", { ...mcpHeaders, Origin: "http://localhost:6274" }, rpc("ping"))).status).toBe(200);
    const get = await call(port, "GET", "/mcp", mcpHeaders);
    expect(get.status).toBe(405);
    expect(get.headers.allow).toBe("POST");
  });

  it("speaks SSE when the client accepts only event-stream", async () => {
    const { config, manager } = fresh();
    const port = await mcpServer(config, manager);
    const res = await call(
      port,
      "POST",
      "/mcp",
      { Authorization: `Bearer ${MCP}`, Accept: "text/event-stream" },
      rpc("ping"),
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.text).toContain("event: message");
    expect(res.text).toContain('"result"');
  });
});

describe("MCP tools", () => {
  it("starts a Claude task inside the allowlist and records source mcp", async () => {
    const { root, config, manager } = fresh();
    silenceRun(manager);
    const port = await mcpServer(config, manager);
    const res = await call(
      port,
      "POST",
      "/mcp",
      mcpHeaders,
      rpc("tools/call", { name: "start_task", arguments: { engine: "claude", prompt: "Add a test", cwd: root } }),
    );
    expect(res.status).toBe(200);
    const payload = toolPayload(res.text);
    expect(payload.isError).toBe(false);
    const task = JSON.parse(payload.content[0]!.text) as { sessionId: string; status: string; engine: string };
    expect(task.engine).toBe("claude");
    expect(task.status).toBe("queued");
    expect(manager.get(task.sessionId)?.source).toBe("mcp");

    const stored = manager.get(task.sessionId)!;
    stored.events.push({
      type: "transcript",
      sessionId: stored.id,
      at: new Date().toISOString(),
      payload: { role: "assistant", text: "hello from claude" },
      seq: 3,
    });
    const output = await call(
      port,
      "POST",
      "/mcp",
      mcpHeaders,
      rpc("tools/call", { name: "get_output", arguments: { sessionId: task.sessionId, sinceSeq: 0 } }),
    );
    const lines = JSON.parse(toolPayload(output.text).content[0]!.text) as {
      lines: Array<{ text: string; seq?: number }>;
      nextSeq: number;
    };
    expect(lines.lines.map((line) => line.text)).toContain("assistant: hello from claude");
    expect(lines.nextSeq).toBe(3);
    const caughtUp = JSON.parse(toolPayload((await call(
      port,
      "POST",
      "/mcp",
      mcpHeaders,
      rpc("tools/call", { name: "get_output", arguments: { sessionId: task.sessionId, sinceSeq: 3 } }),
    )).text).content[0]!.text) as { lines: unknown[] };
    expect(caughtUp.lines).toEqual([]);
  });

  it("refuses a directory outside the allowlist and a second profile without profileId", async () => {
    const { dir, root, config, manager } = fresh();
    silenceRun(manager);
    const outside = join(dir, "other");
    mkdirSync(outside);
    config.profiles = [
      ...config.profiles,
      { id: "claude-other", name: "Other", backend: "claude", color: "#fff", model: "claude" },
    ];
    const port = await mcpServer(config, manager);
    const denied = await call(
      port,
      "POST",
      "/mcp",
      mcpHeaders,
      rpc("tools/call", { name: "start_task", arguments: { engine: "claude", prompt: "nope", cwd: outside, profileId: "claude-main" } }),
    );
    expect(toolPayload(denied.text).isError).toBe(true);
    expect(toolPayload(denied.text).content[0]!.text).toMatch(/allowlist/);

    const ambiguous = await call(
      port,
      "POST",
      "/mcp",
      mcpHeaders,
      rpc("tools/call", { name: "start_task", arguments: { engine: "claude", prompt: "hi", cwd: root } }),
    );
    expect(toolPayload(ambiguous.text).content[0]!.text).toMatch(/profileId/);
  });

  it("stops at the concurrency cap, then cancels and returns the diff", async () => {
    const { root, config, manager } = fresh();
    silenceRun(manager);
    vi.spyOn(manager, "diff").mockResolvedValue({ cwd: root, diff: "diff --git a/a b/a\n+hello\n" });
    const port = await mcpServer(config, manager);
    const start = (prompt: string) =>
      call(port, "POST", "/mcp", mcpHeaders, rpc("tools/call", {
        name: "start_task",
        arguments: { engine: "grok", prompt, cwd: root },
      }));
    const first = JSON.parse(toolPayload((await start("one")).text).content[0]!.text) as { sessionId: string };
    const second = JSON.parse(toolPayload((await start("two")).text).content[0]!.text) as { sessionId: string };
    const third = toolPayload((await start("three")).text);
    expect(third.isError).toBe(true);
    expect(third.content[0]!.text).toMatch(/concurrency cap/);

    const running = manager.get(first.sessionId)!;
    running.status = "awaiting_approval";
    running.pendingApproval = { id: "appr", sessionId: running.id, title: "Bash ls", createdAt: new Date().toISOString() } as DispatchSession["pendingApproval"];
    const status = toolPayload((await call(
      port,
      "POST",
      "/mcp",
      mcpHeaders,
      rpc("tools/call", { name: "get_task", arguments: { sessionId: first.sessionId } }),
    )).text);
    expect(JSON.parse(status.content[0]!.text).needsHuman).toMatch(/phone/);

    const cancelled = JSON.parse(toolPayload((await call(
      port,
      "POST",
      "/mcp",
      mcpHeaders,
      rpc("tools/call", { name: "cancel_task", arguments: { sessionId: second.sessionId } }),
    )).text).content[0]!.text) as { status: string };
    expect(cancelled.status).toBe("cancelled");

    const result = JSON.parse(toolPayload((await call(
      port,
      "POST",
      "/mcp",
      mcpHeaders,
      rpc("tools/call", { name: "get_result", arguments: { sessionId: first.sessionId } }),
    )).text).content[0]!.text) as { diff: string };
    expect(result.diff).toContain("+hello");

    const stranger = toolPayload((await call(
      port,
      "POST",
      "/mcp",
      mcpHeaders,
      rpc("tools/call", { name: "cancel_task", arguments: { sessionId: "not-mcp" } }),
    )).text);
    expect(stranger.isError).toBe(true);
  });

  it("does not list or follow a session the connector did not start", async () => {
    const { root, config, manager } = fresh();
    silenceRun(manager);
    const plain = await manager.dispatch({ prompt: "phone chat", cwd: root, profileId: "claude-main" });
    expect(plain.source).toBeUndefined();
    const port = await mcpServer(config, manager);
    const listed = JSON.parse(toolPayload((await call(
      port,
      "POST",
      "/mcp",
      mcpHeaders,
      rpc("tools/call", { name: "list_sessions", arguments: {} }),
    )).text).content[0]!.text) as { sessions: unknown[] };
    expect(listed.sessions).toEqual([]);
    const follow = toolPayload((await call(
      port,
      "POST",
      "/mcp",
      mcpHeaders,
      rpc("tools/call", { name: "send_followup", arguments: { sessionId: plain.id, prompt: "hijack" } }),
    )).text);
    expect(follow.isError).toBe(true);
  });
});

describe("MCP turn timeout", () => {
  it("cancels a still-running task and leaves an idle one alone", async () => {
    const { config, manager } = fresh();
    vi.useFakeTimers();
    const guard = attachMcpTaskGuards(
      { ...config, mcpGateway: { ...config.mcpGateway, taskTimeoutMs: 5_000 } },
      manager,
    );
    const running = { id: "s-run", source: "mcp", status: "running" } as DispatchSession;
    const idle = { id: "s-idle", source: "mcp", status: "running" } as DispatchSession;
    vi.spyOn(manager, "get").mockImplementation((id: string) => (id === "s-idle" ? idle : id === "s-run" ? running : null));
    const cancel = vi.spyOn(manager, "cancel").mockImplementation(async (id: string) => (id === "s-idle" ? idle : running));
    guard.arm("s-run");
    guard.arm("s-idle");
    manager.emit("event", {
      type: "session.updated",
      sessionId: "s-idle",
      at: new Date().toISOString(),
      payload: { status: "idle" },
    } as SessionEvent);
    idle.status = "idle";
    await vi.advanceTimersByTimeAsync(5_000);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith("s-run");
    expect(running.error).toBe("Stopped: MCP task timed out");
    guard.dispose();
  });
});

describe("MCP on the gateway", () => {
  it("accepts the MCP token only on /mcp, and the host token on both", async () => {
    const { config, manager } = fresh();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const started = startServer(config, manager);
    const main = started.listeners.get("127.0.0.1");
    if (!main) throw new Error("gateway did not listen");
    await new Promise<void>((resolve) => (main.listening ? resolve() : main.once("listening", () => resolve())));
    log.mockRestore();
    const port = (main.address() as AddressInfo).port;
    servers.push({ close: (cb?: () => void) => { void started.shutdown().finally(() => cb?.()); } } as Server);

    expect((await call(port, "GET", "/sessions", { Authorization: `Bearer ${MCP}` })).status).toBe(401);
    expect((await call(port, "GET", "/sessions", { Authorization: `Bearer ${HOST}` })).status).toBe(200);
    const ping = await call(port, "POST", "/mcp", { ...mcpHeaders, Authorization: `Bearer ${HOST}` }, rpc("ping"));
    expect(ping.status).toBe(200);
  });

  it("serves only /mcp and /health on the public listener", async () => {
    const { config, manager } = fresh();
    const server = createMcpOnlyServer(config, manager);
    servers.push(server);
    const port = await listen(server);
    expect((await call(port, "GET", "/health")).status).toBe(200);
    expect((await call(port, "GET", "/sessions", { Authorization: `Bearer ${HOST}` })).status).toBe(404);
    expect((await call(port, "POST", "/exec", { Authorization: `Bearer ${HOST}` }, { command: "id" })).status).toBe(404);
    const ping = await call(port, "POST", "/mcp", mcpHeaders, rpc("ping"));
    expect(ping.status).toBe(200);
  });
});
