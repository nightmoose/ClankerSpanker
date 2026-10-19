import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SessionManager } from "./acp/session-manager.js";
import { startServer } from "./server.js";
import { HOSTED_PRODUCT_ORIGIN } from "./trusted-local.js";
import type { HostConfigFile } from "./types.js";

// RFC-059 / RFC-060: `/exec` and `/host/update` take the host token only from
// native clients and the gateway's own page. Never POST `/host/update` with an
// allowed caller here: it would fast-forward and restart this checkout.

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

describe("native-only routes: /exec and /host/update", () => {
  let dataDir = "";
  let mainPort = 0;
  let servePort = 0;
  let shutdown: () => Promise<void> = async () => {};

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "cs-native-only-"));
    const config = testConfig(dataDir);
    const manager = new SessionManager(config);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const started = startServer(config, manager);
    const main = started.listeners.get("127.0.0.1");
    const serve = started.serveListener;
    if (!main || !serve) throw new Error("gateway did not open both listeners");
    await Promise.all([waitListening(main), waitListening(serve)]);
    log.mockRestore();
    mainPort = (main.address() as AddressInfo).port;
    servePort = (serve.address() as AddressInfo).port;
    shutdown = async () => {
      manager.stopApprovalSweeper();
      await started.shutdown();
    };
  });

  afterAll(async () => {
    await shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const echo = { command: "echo native-only-ok" };

  it("runs /exec for a native client (no Origin)", async () => {
    const r = await call(mainPort, "POST", "/exec", AUTH, echo);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text).stdout).toContain("native-only-ok");
  });

  it("answers GET /host/update for a native client", async () => {
    const r = await call(mainPort, "GET", "/host/update", AUTH);
    expect(r.status).not.toBe(403);
    expect(r.status).not.toBe(401);
  });

  it("runs /exec from the gateway's own /app/ page", async () => {
    const own = `http://127.0.0.1:${mainPort}`;
    const r = await call(mainPort, "POST", "/exec", { ...AUTH, Origin: own, "Sec-Fetch-Site": "same-origin" }, echo);
    expect(r.status).toBe(200);
  });

  it("refuses the hosted product origin on both routes", async () => {
    const hosted = { ...AUTH, Origin: HOSTED_PRODUCT_ORIGIN, "Sec-Fetch-Site": "cross-site" };
    const exec = await call(mainPort, "POST", "/exec", hosted, echo);
    expect(exec.status).toBe(403);
    expect(exec.text).not.toContain("native-only-ok");
    expect((await call(mainPort, "GET", "/host/update", hosted)).status).toBe(403);
    expect((await call(mainPort, "POST", "/host/update", hosted, {})).status).toBe(403);
  });

  it("refuses a foreign origin and a null origin", async () => {
    for (const origin of ["https://evil.example", "null"]) {
      expect((await call(mainPort, "POST", "/exec", { ...AUTH, Origin: origin }, echo)).status).toBe(403);
      expect((await call(mainPort, "POST", "/host/update", { ...AUTH, Origin: origin }, {})).status).toBe(403);
    }
  });

  it("refuses the tailscale serve listener, even with no Origin", async () => {
    const tailnet = { ...AUTH, "Tailscale-User-Login": "me@example.com" };
    expect((await call(servePort, "POST", "/exec", tailnet, echo)).status).toBe(403);
    expect((await call(servePort, "GET", "/host/update", tailnet)).status).toBe(403);
    expect((await call(servePort, "POST", "/host/update", tailnet, {})).status).toBe(403);
    // A forged header on the direct listener only loses privileges.
    expect((await call(mainPort, "POST", "/exec", tailnet, echo)).status).toBe(403);
  });

  it("still needs the token first", async () => {
    expect((await call(mainPort, "POST", "/exec", {}, echo)).status).toBe(401);
  });

  it("leaves other token routes open to the hosted origin", async () => {
    const r = await call(mainPort, "GET", "/projects", { ...AUTH, Origin: HOSTED_PRODUCT_ORIGIN });
    expect(r.status).toBe(200);
  });
});
