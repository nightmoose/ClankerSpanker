import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SessionManager } from "./acp/session-manager.js";
import { startServer } from "./server.js";
import type { HostConfigFile, SessionEvent } from "./types.js";

// GET /sessions/:id/events?since=N is the client's catch-up after a WebSocket
// reconnect. On 2026-10-20 the Swift client sent `/events%3Fsince=N` (the `?`
// encoded into the path) and every catch-up 404'd. Pin the route's contract.

const TOKEN = "t".repeat(32);
const AUTH = { Authorization: `Bearer ${TOKEN}` };

function testConfig(dataDir: string): HostConfigFile {
  return {
    hostId: "host-test",
    hostToken: TOKEN,
    bindHost: "127.0.0.1",
    bindPort: 0,
    serveBindPort: 0,
    grokBinary: "/bin/echo",
    projects: [],
    allowCustomPaths: true,
    profiles: [],
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

describe("GET /sessions/:id/events?since=N", () => {
  let dataDir = "";
  let port = 0;
  let manager: SessionManager;
  let shutdown: () => Promise<void> = async () => {};

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "cs-events-since-"));
    const config = testConfig(dataDir);
    manager = new SessionManager(config);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const started = startServer(config, manager);
    const main = started.listeners.get("127.0.0.1");
    if (!main) throw new Error("gateway did not open its listener");
    await waitListening(main);
    log.mockRestore();
    port = (main.address() as AddressInfo).port;
    shutdown = async () => {
      manager.stopApprovalSweeper();
      await started.shutdown();
    };
  });

  afterAll(async () => {
    await shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns { events } after the given seq", async () => {
    const events = [{ seq: 58 }, { seq: 59 }] as unknown as SessionEvent[];
    const spy = vi.spyOn(manager, "getEventsSince").mockReturnValue(events);
    const r = await call(port, "GET", "/sessions/s%201/events?since=57", AUTH);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toEqual({ events });
    expect(spy).toHaveBeenCalledWith("s 1", 57);
    spy.mockRestore();
  });

  it("defaults since to 0 and rejects a bad since", async () => {
    const spy = vi.spyOn(manager, "getEventsSince").mockReturnValue([]);
    expect((await call(port, "GET", "/sessions/s1/events", AUTH)).status).toBe(200);
    expect(spy).toHaveBeenCalledWith("s1", 0);
    expect((await call(port, "GET", "/sessions/s1/events?since=-1", AUTH)).status).toBe(400);
    expect((await call(port, "GET", "/sessions/s1/events?since=x", AUTH)).status).toBe(400);
    spy.mockRestore();
  });

  it("404s the old client's percent-encoded query", async () => {
    const r = await call(port, "GET", "/sessions/s1/events%3Fsince=57", AUTH);
    expect(r.status).toBe(404);
  });

  it("needs the host token", async () => {
    expect((await call(port, "GET", "/sessions/s1/events?since=0")).status).toBe(401);
  });
});
