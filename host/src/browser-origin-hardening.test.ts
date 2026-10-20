import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { SessionManager } from "./acp/session-manager.js";
import { startServer } from "./server.js";
import { HOSTED_PRODUCT_ORIGIN, isForeignBrowserOrigin } from "./trusted-local.js";
import type { HostConfigFile } from "./types.js";

// RFC-065: a page on another website that holds the host token (the hosted
// site at https://clankerspanker.tech included) gets neither a login shell
// nor profile secrets. Native clients, the Electron renderer and the
// gateway's own /app/ page keep working.

const TOKEN = "t".repeat(32);
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const SECRET = "sk-test-not-a-real-key";

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
    profiles: [{ id: "p1", name: "One", backend: "claude", color: "blue", env: { ANTHROPIC_API_KEY: SECRET } }],
    autoApproveKinds: ["read"],
    notifyDesktop: false,
    dataDir,
  } as HostConfigFile;
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
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }> {
  return new Promise((resolve, reject) => {
    const r = request({ hostname: "127.0.0.1", port, method, path, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    r.on("error", reject);
    r.end();
  });
}

/**
 * Try a terminal upgrade with no ticket. "refused" is the RFC-065 origin
 * gate (HTTP 403 before the upgrade). "unauthorized" means the gate let the
 * caller through to the token check (close 4401), so no shell is spawned.
 */
function terminalOutcome(port: number, headers: Record<string, string>): Promise<"refused" | "unauthorized" | string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal`, { headers });
    ws.on("unexpected-response", (_req, res) => {
      resolve(res.statusCode === 403 ? "refused" : `http ${res.statusCode}`);
      ws.terminate();
    });
    ws.on("close", (code) => resolve(code === 4401 ? "unauthorized" : `close ${code}`));
    ws.on("error", () => {});
  });
}

describe("isForeignBrowserOrigin", () => {
  const req = (headers: Record<string, string>) => ({ headers: { host: "127.0.0.1:8787", ...headers } });

  it("treats native, Electron and the gateway's own page as not foreign", () => {
    expect(isForeignBrowserOrigin(req({}))).toBe(false);
    expect(isForeignBrowserOrigin(req({ origin: "null" }))).toBe(false);
    expect(isForeignBrowserOrigin(req({ origin: "http://127.0.0.1:8787" }))).toBe(false);
    expect(isForeignBrowserOrigin(req({ origin: "HTTP://127.0.0.1:8787" }))).toBe(false);
  });

  it("treats the hosted site and any other website as foreign", () => {
    expect(isForeignBrowserOrigin(req({ origin: HOSTED_PRODUCT_ORIGIN }))).toBe(true);
    expect(isForeignBrowserOrigin(req({ origin: "https://evil.example" }))).toBe(true);
    expect(isForeignBrowserOrigin(req({ origin: "http://localhost:8787" }))).toBe(true);
  });
});

describe("RFC-065 on a running gateway", () => {
  let dataDir = "";
  let mainPort = 0;
  let servePort = 0;
  let shutdown: () => Promise<void> = async () => {};

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "cs-origin-hardening-"));
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

  describe("/ws/terminal", () => {
    it("lets native clients and the gateway's own page reach the token check", async () => {
      expect(await terminalOutcome(mainPort, {})).toBe("unauthorized");
      expect(await terminalOutcome(mainPort, { Origin: `http://127.0.0.1:${mainPort}` })).toBe("unauthorized");
    });

    it("refuses the hosted site and other websites before the upgrade", async () => {
      expect(await terminalOutcome(mainPort, { Origin: HOSTED_PRODUCT_ORIGIN })).toBe("refused");
      expect(await terminalOutcome(mainPort, { Origin: "https://evil.example" })).toBe("refused");
    });

    it("refuses a valid ticket from the hosted site", async () => {
      const t = await new Promise<string>((resolve, reject) => {
        const r = request(
          { hostname: "127.0.0.1", port: mainPort, method: "POST", path: "/ws/ticket", headers: { ...AUTH, Origin: HOSTED_PRODUCT_ORIGIN } },
          (res) => {
            let text = "";
            res.on("data", (c) => (text += c));
            res.on("end", () => resolve(JSON.parse(text).ticket as string));
          },
        );
        r.on("error", reject);
        r.end();
      });
      const outcome = await new Promise<string>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${mainPort}/ws/terminal?ticket=${encodeURIComponent(t)}`, {
          headers: { Origin: HOSTED_PRODUCT_ORIGIN },
        });
        ws.on("unexpected-response", (_req, res) => {
          resolve(`http ${res.statusCode}`);
          ws.terminate();
        });
        ws.on("open", () => {
          resolve("open");
          ws.terminate();
        });
        ws.on("error", () => {});
      });
      expect(outcome).toBe("http 403");
    });

    it("refuses tailscale serve callers on the serve listener", async () => {
      expect(await terminalOutcome(servePort, { "Tailscale-User-Login": "me@example.com" })).toBe("refused");
    });
  });

  describe("profile secrets", () => {
    it("returns admin records with secrets to a native client on this machine", async () => {
      const r = await call(mainPort, "GET", "/profiles?admin=1", AUTH);
      expect(r.status).toBe(200);
      expect(JSON.parse(r.text).admin).toBe(true);
      expect(r.text).toContain(SECRET);
    });

    it("returns admin records to the Electron renderer (Origin: null)", async () => {
      const r = await call(mainPort, "GET", "/profiles?admin=1", { ...AUTH, Origin: "null" });
      expect(JSON.parse(r.text).admin).toBe(true);
    });

    it("never returns secrets to the hosted site over loopback", async () => {
      const r = await call(mainPort, "GET", "/profiles?admin=1", { ...AUTH, Origin: HOSTED_PRODUCT_ORIGIN });
      expect(r.status).toBe(200);
      expect(JSON.parse(r.text).admin).not.toBe(true);
      expect(r.text).not.toContain(SECRET);
      expect(r.text).not.toContain("adminProfiles");
    });

    it("refuses profile edits from the hosted site", async () => {
      const del = await call(mainPort, "DELETE", "/profiles/p1", { ...AUTH, Origin: HOSTED_PRODUCT_ORIGIN });
      expect(del.status).toBe(403);
      const still = await call(mainPort, "GET", "/profiles?admin=1", AUTH);
      expect(still.text).toContain(SECRET);
    });
  });
});
