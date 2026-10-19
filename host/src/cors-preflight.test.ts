import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "./acp/session-manager.js";
import { startServer } from "./server.js";
import { HOSTED_PRODUCT_ORIGIN } from "./trusted-local.js";
import type { HostConfigFile } from "./types.js";

const PRODUCT = HOSTED_PRODUCT_ORIGIN;

function testConfig(dataDir: string, bindPort: number): HostConfigFile {
  return {
    hostId: "host-test",
    hostToken: "t".repeat(32),
    bindHost: "127.0.0.1",
    bindPort,
    grokBinary: "/bin/echo",
    projects: [],
    allowCustomPaths: true,
    profiles: [],
    autoApproveKinds: ["read"],
    notifyDesktop: false,
    dataDir,
  };
}

async function listen(): Promise<{
  port: number;
  dataDir: string;
  manager: SessionManager;
  shutdown: () => Promise<void>;
}> {
  const dataDir = mkdtempSync(join(tmpdir(), "cs-cors-"));
  const config = testConfig(dataDir, 0);
  const manager = new SessionManager(config);
  const started = startServer(config, manager);
  const srv = started.listeners.get("127.0.0.1");
  if (!srv) throw new Error("gateway did not listen on 127.0.0.1");
  await waitListening(srv);
  const addr = srv.address() as AddressInfo;
  return {
    port: addr.port,
    dataDir,
    manager,
    shutdown: async () => {
      manager.stopApprovalSweeper();
      await started.shutdown();
    },
  };
}

function waitListening(srv: Server): Promise<void> {
  if (srv.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    srv.once("listening", () => resolve());
    srv.once("error", reject);
  });
}

function probe(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const r = request({ hostname: "127.0.0.1", port, method, path, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
    });
    r.on("error", reject);
    r.end();
  });
}

describe("hosted origin private-network preflight", () => {
  let opened: Awaited<ReturnType<typeof listen>> | undefined;

  afterEach(async () => {
    if (!opened) return;
    const current = opened;
    opened = undefined;
    await current.shutdown();
    rmSync(current.dataDir, { recursive: true, force: true });
  });

  it("opts in for the product origin and refuses every other website", async () => {
    opened = await listen();
    const { port } = opened;
    const preflight = {
      Origin: PRODUCT,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization,content-type",
      "Access-Control-Request-Private-Network": "true",
    };

    const allowed = await probe(port, "OPTIONS", "/sessions", preflight);
    expect(allowed.status).toBe(204);
    expect(allowed.headers["access-control-allow-origin"]).toBe(PRODUCT);
    expect(allowed.headers["access-control-allow-private-network"]).toBe("true");
    expect(String(allowed.headers["access-control-allow-headers"])).toContain("Authorization");
    expect(allowed.headers["vary"]).toBe("Origin");

    const ticket = await probe(port, "OPTIONS", "/ws/ticket", preflight);
    expect(ticket.status).toBe(204);
    expect(ticket.headers["access-control-allow-origin"]).toBe(PRODUCT);
    expect(ticket.headers["access-control-allow-private-network"]).toBe("true");

    const health = await probe(port, "GET", "/health", { Origin: PRODUCT });
    expect(health.status).toBe(200);
    expect(health.headers["access-control-allow-origin"]).toBe(PRODUCT);
    expect(health.headers["access-control-allow-private-network"]).toBe("true");

    const denied = await probe(port, "OPTIONS", "/sessions", {
      ...preflight,
      Origin: "https://preview.vercel.app",
    });
    expect(denied.status).toBe(204);
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
    expect(denied.headers["access-control-allow-private-network"]).toBeUndefined();

    const electron = await probe(port, "OPTIONS", "/sessions", {
      ...preflight,
      Origin: "null",
    });
    expect(electron.headers["access-control-allow-origin"]).toBe("*");
    expect(electron.headers["access-control-allow-private-network"]).toBeUndefined();

    const setup = await probe(port, "OPTIONS", "/setup", preflight);
    expect(setup.status).toBe(204);
    expect(setup.headers["access-control-allow-origin"]).toBeUndefined();
    expect(setup.headers["access-control-allow-private-network"]).toBeUndefined();

    const setupGet = await probe(port, "GET", "/setup", { Origin: PRODUCT });
    expect(setupGet.status).toBe(403);
    expect(setupGet.headers["access-control-allow-origin"]).toBeUndefined();

    const connect = await probe(port, "GET", "/connect.json", { Origin: PRODUCT });
    expect(connect.status).toBe(403);
    expect(connect.headers["access-control-allow-origin"]).toBeUndefined();

    const unauthorized = await probe(port, "GET", "/sessions", { Origin: PRODUCT });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers["access-control-allow-origin"]).toBe(PRODUCT);
  });
});
