import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { SessionManager } from "./acp/session-manager.js";
import { loadConfig } from "./config.js";
import { defaultProfiles } from "./profiles.js";
import { startServer, wsUpgradeAuthorized } from "./server.js";
import {
  SERVE_BIND_ADDRESS,
  hasTailscaleUserHeader,
  isLocalMachineRequest,
  normalizeServeBindPort,
  serveListenerGate,
  tailscaleUserLogin,
} from "./tailscale-serve.js";
import { HOSTED_PRODUCT_ORIGIN, isTrustedLocalPageRequest } from "./trusted-local.js";
import type { HostConfigFile } from "./types.js";
import { WsTicketStore } from "./ws-tickets.js";

const TOKEN = "t".repeat(32);
const USER = { "Tailscale-User-Login": "alice@example.com" };
const BEARER = { Authorization: `Bearer ${TOKEN}` };
const SECRET = "sk-ant-should-never-leave";

describe("tailscale-serve helpers", () => {
  it("reads the login, treating blank as absent", () => {
    expect(tailscaleUserLogin({ "tailscale-user-login": "alice@example.com" })).toBe("alice@example.com");
    expect(tailscaleUserLogin({ "tailscale-user-login": "  " })).toBeUndefined();
    expect(tailscaleUserLogin({ "tailscale-user-login": "" })).toBeUndefined();
    expect(tailscaleUserLogin({})).toBeUndefined();
  });

  it("counts an empty header as present for the local-machine check", () => {
    expect(hasTailscaleUserHeader({ "tailscale-user-login": "" })).toBe(true);
    expect(hasTailscaleUserHeader({})).toBe(false);
  });

  it("is never local when the identity header is present, even from loopback", () => {
    const loop = { socket: { remoteAddress: "127.0.0.1" } };
    expect(isLocalMachineRequest({ ...loop, headers: {} })).toBe(true);
    expect(isLocalMachineRequest({ ...loop, headers: { "tailscale-user-login": "alice@example.com" } })).toBe(false);
    expect(isLocalMachineRequest({ ...loop, headers: { "tailscale-user-login": "" } })).toBe(false);
    expect(isLocalMachineRequest({ socket: { remoteAddress: "203.0.113.9" }, headers: {} })).toBe(false);
  });

  it("gates every path without identity and hides the token pages with it", () => {
    for (const p of ["/health", "/sessions", "/setup", "/", "/app/"]) {
      expect(serveListenerGate({}, p)).toMatchObject({ ok: false, status: 403 });
      expect(serveListenerGate({ "tailscale-user-login": "" }, p)).toMatchObject({ ok: false, status: 403 });
    }
    const id = { "tailscale-user-login": "alice@example.com" };
    for (const p of ["/", "/setup", "/setup/", "/connect.json", "/mcp/oauth/callback"]) {
      expect(serveListenerGate(id, p)).toMatchObject({ ok: false, status: 404 });
    }
    for (const p of ["/health", "/sessions", "/profiles", "/ws/ticket", "/app/"]) {
      expect(serveListenerGate(id, p)).toEqual({ ok: true });
    }
  });

  it("validates serveBindPort", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(normalizeServeBindPort(undefined, 8787)).toBeUndefined();
      expect(normalizeServeBindPort(8788, 8787)).toBe(8788);
      expect(normalizeServeBindPort("8788", 8787)).toBe(8788);
      expect(normalizeServeBindPort(8787, 8787)).toBeUndefined();
      expect(normalizeServeBindPort(0, 8787)).toBeUndefined();
      expect(normalizeServeBindPort(70000, 8787)).toBeUndefined();
      expect(normalizeServeBindPort(87.5, 8787)).toBeUndefined();
      expect(normalizeServeBindPort("abc", 8787)).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  it("refuses the legacy ?token= websocket from a serve caller", () => {
    const r = {
      url: `/ws?token=${TOKEN}`,
      headers: { "tailscale-user-login": "alice@example.com" },
      socket: { remoteAddress: "127.0.0.1" },
    };
    expect(wsUpgradeAuthorized(r, { hostToken: TOKEN }, new WsTicketStore())).toBe(false);
  });

  it("does not treat a serve caller as a trusted local page", () => {
    const base = { socket: { remoteAddress: "127.0.0.1" } };
    const names = new Set(["127.0.0.1"]);
    expect(isTrustedLocalPageRequest({ ...base, headers: { host: "127.0.0.1:8787" } }, names)).toBe(true);
    expect(
      isTrustedLocalPageRequest(
        { ...base, headers: { host: "127.0.0.1:8787", "tailscale-user-login": "alice@example.com" } },
        names,
      ),
    ).toBe(false);
  });
});

describe("serveBindPort in config.json", () => {
  it("round-trips through loadConfig and stays off when unset", () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-serve-cfg-"));
    try {
      const path = join(dir, "config.json");
      const base = { hostToken: TOKEN, bindPort: 8787, dataDir: join(dir, "data"), grokBinary: "/bin/echo" };
      writeFileSync(path, JSON.stringify({ ...base, serveBindPort: 8788 }));
      expect(loadConfig(path).serveBindPort).toBe(8788);
      writeFileSync(path, JSON.stringify(base));
      expect(loadConfig(path).serveBindPort).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function testConfig(dataDir: string): HostConfigFile {
  const profiles = defaultProfiles();
  profiles[0] = { ...profiles[0]!, env: { ANTHROPIC_API_KEY: SECRET } };
  return {
    hostId: "host-test",
    hostToken: TOKEN,
    bindHost: "127.0.0.1",
    bindPort: 0,
    serveBindPort: 0,
    grokBinary: "/bin/echo",
    projects: [],
    allowCustomPaths: true,
    profiles,
    autoApproveKinds: ["read"],
    notifyDesktop: false,
    dataDir,
  };
}

function waitListening(srv: Server): Promise<void> {
  if (srv.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    srv.once("listening", () => resolve());
    srv.once("error", reject);
  });
}

async function listen() {
  const dataDir = mkdtempSync(join(tmpdir(), "cs-serve-"));
  const config = testConfig(dataDir);
  const manager = new SessionManager(config);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const started = startServer(config, manager);
  const main = started.listeners.get("127.0.0.1");
  const serve = started.serveListener;
  if (!main || !serve) throw new Error("gateway did not open both listeners");
  await Promise.all([waitListening(main), waitListening(serve)]);
  log.mockRestore();
  return {
    mainPort: (main.address() as AddressInfo).port,
    servePort: (serve.address() as AddressInfo).port,
    serveAddr: (serve.address() as AddressInfo).address,
    dataDir,
    shutdown: async () => {
      manager.stopApprovalSweeper();
      await started.shutdown();
    },
  };
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
    const r = request(
      {
        hostname: "127.0.0.1",
        port,
        method,
        path,
        headers: payload ? { ...headers, "Content-Type": "application/json" } : headers,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
      },
    );
    r.on("error", reject);
    r.end(payload);
  });
}

function wsOutcome(url: string, headers: Record<string, string>): Promise<{ open: true } | { status: number }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.on("open", () => {
      ws.close();
      resolve({ open: true });
    });
    ws.on("unexpected-response", (_req, res) => {
      resolve({ status: res.statusCode ?? 0 });
      res.resume();
    });
    ws.on("error", (err) => {
      if (!/Unexpected server response/.test(err.message)) reject(err);
    });
  });
}

describe("serve listener (RFC-058 phase 2)", () => {
  let opened: Awaited<ReturnType<typeof listen>> | undefined;

  afterEach(async () => {
    if (!opened) return;
    const current = opened;
    opened = undefined;
    await current.shutdown();
    rmSync(current.dataDir, { recursive: true, force: true });
  });

  it("binds loopback only", async () => {
    opened = await listen();
    expect(opened.serveAddr).toBe(SERVE_BIND_ADDRESS);
  });

  it("is 403 on every path without Tailscale-User-Login, /health included", async () => {
    opened = await listen();
    const { servePort } = opened;
    for (const p of ["/health", "/profiles?admin=1", "/setup", "/connect.json", "/sessions", "/app/"]) {
      const r = await call(servePort, "GET", p, BEARER);
      expect(r.status, p).toBe(403);
      expect(r.text).not.toContain(TOKEN);
    }
    expect((await call(servePort, "GET", "/health", { "Tailscale-User-Login": "" })).status).toBe(403);
    expect((await call(servePort, "OPTIONS", "/sessions", { Origin: HOSTED_PRODUCT_ORIGIN })).status).toBe(403);
  });

  it("does not mount the token pages or the OAuth callback, even with identity", async () => {
    opened = await listen();
    const { servePort } = opened;
    for (const p of ["/", "/setup", "/connect.json", "/mcp/oauth/callback?code=x&state=y"]) {
      const r = await call(servePort, "GET", p, { ...USER, ...BEARER });
      expect(r.status, p).toBe(404);
      expect(r.text).not.toContain(TOKEN);
    }
  });

  it("serves the API to a tailnet user with the token, with admin off", async () => {
    opened = await listen();
    const { servePort } = opened;
    expect((await call(servePort, "GET", "/health", USER)).status).toBe(200);
    expect((await call(servePort, "GET", "/sessions", USER)).status).toBe(401);

    const profiles = await call(servePort, "GET", "/profiles?admin=1", { ...USER, ...BEARER });
    expect(profiles.status).toBe(200);
    const body = JSON.parse(profiles.text) as { admin: boolean; adminProfiles?: unknown };
    expect(body.admin).toBe(false);
    expect(body.adminProfiles).toBeUndefined();
    expect(profiles.text).not.toContain(SECRET);

    const create = await call(servePort, "POST", "/profiles", { ...USER, ...BEARER }, { name: "x", backend: "claude" });
    expect(create.status).toBe(403);
  });

  it("reflects the product origin for CORS, preflight included", async () => {
    opened = await listen();
    const { servePort } = opened;
    const pre = await call(servePort, "OPTIONS", "/ws/ticket", {
      ...USER,
      Origin: HOSTED_PRODUCT_ORIGIN,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization",
    });
    expect(pre.status).toBe(204);
    expect(pre.headers["access-control-allow-origin"]).toBe(HOSTED_PRODUCT_ORIGIN);
    const health = await call(servePort, "GET", "/health", { ...USER, Origin: HOSTED_PRODUCT_ORIGIN });
    expect(health.headers["access-control-allow-origin"]).toBe(HOSTED_PRODUCT_ORIGIN);
    const other = await call(servePort, "GET", "/health", { ...USER, Origin: "https://evil.example" });
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("gates WebSocket upgrades on the identity header", async () => {
    opened = await listen();
    const { servePort } = opened;
    const ticket = async () => {
      const r = await call(servePort, "POST", "/ws/ticket", { ...USER, ...BEARER });
      expect(r.status).toBe(200);
      return (JSON.parse(r.text) as { ticket: string }).ticket;
    };
    const t1 = await ticket();
    expect(await wsOutcome(`ws://127.0.0.1:${servePort}/ws?ticket=${t1}`, {})).toEqual({ status: 403 });
    const t2 = await ticket();
    expect(await wsOutcome(`ws://127.0.0.1:${servePort}/ws?ticket=${t2}`, USER)).toEqual({ open: true });
  });

  it("leaves direct loopback on the main port local, unless the header is forged", async () => {
    opened = await listen();
    const { mainPort } = opened;
    const setup = await call(mainPort, "GET", "/setup");
    expect(setup.status).toBe(200);
    const admin = JSON.parse((await call(mainPort, "GET", "/profiles?admin=1", BEARER)).text) as {
      admin: boolean;
      adminProfiles?: Array<{ env?: Record<string, string> }>;
    };
    expect(admin.admin).toBe(true);
    expect(admin.adminProfiles?.[0]?.env?.ANTHROPIC_API_KEY).toBe(SECRET);

    const forged = await call(mainPort, "GET", "/profiles?admin=1", { ...USER, ...BEARER });
    expect(JSON.parse(forged.text)).toMatchObject({ admin: false });
    expect(forged.text).not.toContain(SECRET);
    expect((await call(mainPort, "GET", "/setup", USER)).status).toBe(403);
    expect((await call(mainPort, "GET", "/connect.json", USER)).status).toBe(403);
    expect((await call(mainPort, "GET", "/mcp/oauth/callback?code=x&state=y", USER)).status).toBe(403);
  });
});

describe("serve listener off by default", () => {
  it("opens no serve listener when serveBindPort is unset", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cs-serve-off-"));
    const config = { ...testConfig(dataDir), serveBindPort: undefined };
    const manager = new SessionManager(config);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const started = startServer(config, manager);
    log.mockRestore();
    try {
      expect(started.serveListener).toBeUndefined();
    } finally {
      manager.stopApprovalSweeper();
      await started.shutdown();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
