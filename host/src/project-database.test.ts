// RFC-061: the project database routes and the sql MCP injection, end to end
// through the real gateway. The connection string must never come back out.
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "./acp/session-manager.js";
import { defaultProfiles } from "./profiles.js";
import * as projectSecrets from "./project-secrets.js";
import { startServer } from "./server.js";
import { HOSTED_PRODUCT_ORIGIN } from "./trusted-local.js";
import type { DispatchSession, HostConfigFile } from "./types.js";

const TOKEN = "t".repeat(32);
const BEARER = { Authorization: `Bearer ${TOKEN}` };
const USER = { "Tailscale-User-Login": "alice@example.com" };
const PASSWORD = "pr9-Never-Echo-Me";
const DB = `postgresql://postgres.abc:${PASSWORD}@db.abc.supabase.co:5432/postgres`;

function testConfig(dataDir: string): HostConfigFile {
  return {
    hostId: "host-test",
    hostToken: TOKEN,
    bindHost: "127.0.0.1",
    bindPort: 0,
    serveBindPort: 0,
    grokBinary: "/bin/echo",
    projects: [
      { id: "alpha", name: "Alpha", path: "/tmp/alpha", paths: ["/tmp/alpha"] },
      { id: "beta", name: "Beta", path: "/tmp/beta", paths: ["/tmp/beta"] },
    ],
    allowCustomPaths: true,
    profiles: defaultProfiles(),
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
    const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    const r = request(
      { hostname: "127.0.0.1", port, method, path, headers: payload ? { ...headers, "Content-Type": "application/json" } : headers },
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

describe("project database routes", () => {
  let dir: string;
  let config: HostConfigFile;
  let manager: SessionManager;
  let shutdown: () => Promise<void>;
  let mainPort: number;
  let servePort: number;
  let logs: string[];
  const prevConfigPath = process.env.GROK_DISPATCH_CONFIG;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cs-projdb-"));
    // saveConfig writes here, not to the real ~/.grok-dispatch.
    process.env.GROK_DISPATCH_CONFIG = join(dir, "config.json");
    config = testConfig(join(dir, "data"));
    manager = new SessionManager(config);
    logs = [];
    const capture = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
    vi.spyOn(console, "log").mockImplementation(capture);
    vi.spyOn(console, "warn").mockImplementation(capture);
    vi.spyOn(console, "error").mockImplementation(capture);
    const started = startServer(config, manager);
    const main = started.listeners.get("127.0.0.1")!;
    const serve = started.serveListener!;
    await Promise.all([waitListening(main), waitListening(serve)]);
    mainPort = (main.address() as AddressInfo).port;
    servePort = (serve.address() as AddressInfo).port;
    shutdown = async () => {
      manager.stopApprovalSweeper();
      await started.shutdown();
    };
  });

  afterEach(async () => {
    await shutdown();
    vi.restoreAllMocks();
    if (prevConfigPath === undefined) delete process.env.GROK_DISPATCH_CONFIG;
    else process.env.GROK_DISPATCH_CONFIG = prevConfigPath;
    rmSync(dir, { recursive: true, force: true });
  });

  const bind = (port = mainPort, headers: Record<string, string> = BEARER, project = "alpha") =>
    call(port, "POST", `/projects/${project}/database`, headers, { connectionString: DB, hostHint: "db.abc.supabase.co" });

  it("stores the secret server-side and returns only metadata", async () => {
    const r = await bind();
    expect(r.status).toBe(200);
    expect(r.text).not.toContain(PASSWORD);
    const { project } = JSON.parse(r.text) as { project: { database: Record<string, unknown> } };
    expect(project.database).toMatchObject({
      provider: "supabase",
      connectionRef: projectSecrets.DATABASE_CONNECTION_SLOT,
      hostHint: "db.abc.supabase.co",
    });
    expect(projectSecrets.get(config, "alpha", projectSecrets.DATABASE_CONNECTION_SLOT)).toBe(DB);
    expect(projectSecrets.get(config, "beta", projectSecrets.DATABASE_CONNECTION_SLOT)).toBeUndefined();
    // Persisted owner-only.
    const cfgPath = process.env.GROK_DISPATCH_CONFIG!;
    expect(statSync(cfgPath).mode & 0o077).toBe(0);
    expect(readFileSync(cfgPath, "utf8")).toContain(PASSWORD);
  });

  it("never shows the secret on GET /projects, GET /projects/:id, /profiles, or in logs", async () => {
    await bind();
    for (const p of ["/projects", "/projects/alpha", "/profiles", "/profiles?admin=1", "/sessions"]) {
      const r = await call(mainPort, "GET", p, BEARER);
      expect(r.status, p).toBe(200);
      expect(r.text, p).not.toContain(PASSWORD);
      expect(r.text, p).not.toContain("postgresql://");
    }
    expect(logs.join("\n")).not.toContain(PASSWORD);
  });

  it("derives a credential-free hostHint when the client sends none", async () => {
    const r = await call(mainPort, "POST", "/projects/alpha/database", BEARER, { connectionString: DB });
    const { project } = JSON.parse(r.text) as { project: { database: { hostHint?: string } } };
    expect(project.database.hostHint).toBe("db.abc.supabase.co");
    expect(r.text).not.toContain(PASSWORD);
  });

  it("validates input without echoing it", async () => {
    const bad = "mysql://root:" + PASSWORD + "@h/db";
    const r1 = await call(mainPort, "POST", "/projects/alpha/database", BEARER, { connectionString: bad });
    expect(r1.status).toBe(400);
    expect(r1.text).not.toContain(PASSWORD);
    const r2 = await call(mainPort, "POST", "/projects/alpha/database", BEARER, { connectionString: "  " });
    expect(r2.status).toBe(400);
    const r3 = await call(mainPort, "POST", "/projects/alpha/database", BEARER, `{"connectionString":"${DB}"`);
    expect(r3.status).toBe(400);
    expect(r3.text).not.toContain(PASSWORD);
    const r4 = await call(mainPort, "POST", "/projects/nope/database", BEARER, { connectionString: DB });
    expect(r4.status).toBe(404);
    expect(projectSecrets.get(config, "nope", projectSecrets.DATABASE_CONNECTION_SLOT)).toBeUndefined();
  });

  it("requires the host token, on both listeners", async () => {
    expect((await bind(mainPort, {})).status).toBe(401);
    expect((await bind(servePort, USER)).status).toBe(401);
    expect((await call(servePort, "DELETE", "/projects/alpha/database", USER)).status).toBe(401);
    expect((await bind(servePort, BEARER)).status).toBe(403); // serve listener without identity
    expect(projectSecrets.get(config, "alpha", projectSecrets.DATABASE_CONNECTION_SLOT)).toBeUndefined();
  });

  it("lets a tailnet user with the token bind and clear it via tailscale serve", async () => {
    const set = await bind(servePort, { ...USER, ...BEARER });
    expect(set.status).toBe(200);
    expect(set.text).not.toContain(PASSWORD);
    const list = await call(servePort, "GET", "/projects", { ...USER, ...BEARER });
    expect(list.text).not.toContain(PASSWORD);
    const clear = await call(servePort, "DELETE", "/projects/alpha/database", { ...USER, ...BEARER });
    expect(clear.status).toBe(200);
    expect(projectSecrets.get(config, "alpha", projectSecrets.DATABASE_CONNECTION_SLOT)).toBeUndefined();
  });

  it("allows the hosted origin through CORS for POST and DELETE", async () => {
    for (const port of [mainPort, servePort]) {
      const pre = await call(port, "OPTIONS", "/projects/alpha/database", {
        ...USER,
        Origin: HOSTED_PRODUCT_ORIGIN,
        "Access-Control-Request-Method": "DELETE",
        "Access-Control-Request-Headers": "authorization, content-type",
      });
      expect(pre.status).toBe(204);
      expect(pre.headers["access-control-allow-origin"]).toBe(HOSTED_PRODUCT_ORIGIN);
      expect(String(pre.headers["access-control-allow-methods"])).toMatch(/POST.*DELETE|DELETE.*POST/);
    }
    const set = await bind(mainPort, { ...BEARER, Origin: HOSTED_PRODUCT_ORIGIN });
    expect(set.status).toBe(200);
    expect(set.headers["access-control-allow-origin"]).toBe(HOSTED_PRODUCT_ORIGIN);
    expect(set.text).not.toContain(PASSWORD);
    const other = await bind(mainPort, { ...BEARER, Origin: "https://evil.example" });
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("DELETE clears the slot and the metadata; hard project delete clears every slot", async () => {
    await bind();
    const clear = await call(mainPort, "DELETE", "/projects/alpha/database", BEARER);
    expect(clear.status).toBe(200);
    expect(projectSecrets.get(config, "alpha", projectSecrets.DATABASE_CONNECTION_SLOT)).toBeUndefined();
    const after = JSON.parse((await call(mainPort, "GET", "/projects/alpha", BEARER)).text) as { project: { database?: unknown } };
    expect(after.project.database).toBeUndefined();
    // Idempotent.
    expect((await call(mainPort, "DELETE", "/projects/alpha/database", BEARER)).status).toBe(200);

    await bind(mainPort, BEARER, "beta");
    expect((await call(mainPort, "DELETE", "/projects/beta?hard=1", BEARER)).status).toBe(200);
    expect(projectSecrets.get(config, "beta", projectSecrets.DATABASE_CONNECTION_SLOT)).toBeUndefined();
    expect(readFileSync(process.env.GROK_DISPATCH_CONFIG!, "utf8")).not.toContain(PASSWORD);
  });

  it("PATCH cannot fake, resurrect, or drop the binding", async () => {
    const fake = await call(mainPort, "PATCH", "/projects/beta", BEARER, {
      name: "Beta 2",
      database: { provider: "supabase", connectionRef: "x", addedAt: "", updatedAt: "" },
    });
    expect(fake.status).toBe(200);
    expect((JSON.parse(fake.text) as { project: { name: string; database?: unknown } }).project).toMatchObject({ name: "Beta 2" });
    expect((JSON.parse(fake.text) as { project: { database?: unknown } }).project.database).toBeUndefined();

    await bind();
    const keep = await call(mainPort, "PATCH", "/projects/alpha", BEARER, { name: "Alpha 2", database: null });
    expect((JSON.parse(keep.text) as { project: { database?: { hostHint?: string } } }).project.database?.hostHint).toBe(
      "db.abc.supabase.co",
    );
  });

  it("injects the sql server for that project's sessions only", async () => {
    await bind();
    const forSession = (projectId?: string) =>
      (manager as unknown as { acpMcpServersFor(s: Partial<DispatchSession>): Promise<Array<{ name: string; env?: Array<{ name: string; value: string }> }>> })
        .acpMcpServersFor({ id: "s1", backend: "grok", projectId } as Partial<DispatchSession>);
    const alpha = await forSession("alpha");
    const sql = alpha.filter((s) => s.name === "sql");
    expect(sql).toHaveLength(1);
    expect(sql[0]!.env).toEqual([{ name: "DATABASE_URL", value: DB }]);
    expect((await forSession("beta")).some((s) => s.name === "sql")).toBe(false);
    expect((await forSession(undefined)).some((s) => s.name === "sql")).toBe(false);

    await call(mainPort, "DELETE", "/projects/alpha/database", BEARER);
    expect((await forSession("alpha")).some((s) => s.name === "sql")).toBe(false);
  });
});
