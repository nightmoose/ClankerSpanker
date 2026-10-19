import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  claudeMcpConfigArgs,
  enabledMcpServers,
  normalizeMcpServers,
  projectSqlMcpServer,
  publicMcpServers,
  removeSessionMcpJson,
  SQL_MCP_PATH,
  toAcpMcpServers,
  toMcpJson,
  writeProfileMcpJson,
} from "./mcp.js";
import { writeOAuthTokens } from "./mcp-oauth.js";
import type { AgentProfile } from "./types.js";

describe("normalizeMcpServers", () => {
  it("keeps oauthClientId and drops runtime oauthConnected", () => {
    const out = normalizeMcpServers([
      {
        name: "gmail",
        url: "https://mcp.gmail.example/mcp",
        oauthClientId: "cid",
        oauthScope: "openid email",
        oauthConnected: true,
      } as { name: string; url: string; oauthClientId: string; oauthScope: string; oauthConnected: boolean },
    ]);
    expect(out![0]).toMatchObject({
      name: "gmail",
      url: "https://mcp.gmail.example/mcp",
      oauthClientId: "cid",
      oauthScope: "openid email",
      transport: "http",
    });
    expect(out![0]).not.toHaveProperty("oauthConnected");
  });

  it("keeps a named stdio server and drops nameless/invalid", () => {
    const out = normalizeMcpServers([
      { name: "github", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
      { name: "bad name", command: "npx" },
      { name: "empty" },
      { name: "github", command: "duplicate" },
    ]);
    expect(out).toHaveLength(1);
    expect(out![0]!.name).toBe("github");
    expect(out![0]!.command).toBe("npx");
  });
});

describe("toMcpJson", () => {
  it("omits disabled servers and expands ${VAR} from profile env", () => {
    const json = toMcpJson(
      [
        {
          name: "databricks",
          command: "npx",
          args: ["-y", "databricks-mcp"],
          env: { DATABRICKS_TOKEN: "${DB_TOKEN}" },
        },
        { name: "gmail", url: "https://mcp.gmail.example/mcp", enabled: false },
        {
          name: "linear",
          url: "https://mcp.linear.app/mcp",
          headers: { Authorization: "Bearer ${LIN_TOKEN}" },
          transport: "http",
        },
      ],
      { DB_TOKEN: "db-secret", LIN_TOKEN: "lin-secret" },
    );
    expect(json.mcpServers.gmail).toBeUndefined();
    expect(json.mcpServers.databricks).toEqual({
      command: "npx",
      args: ["-y", "databricks-mcp"],
      env: { DATABRICKS_TOKEN: "db-secret" },
    });
    expect(json.mcpServers.linear).toEqual({
      url: "https://mcp.linear.app/mcp",
      headers: { Authorization: "Bearer lin-secret" },
      type: "http",
    });
  });

  it("gives every URL server a Claude `type`, never `transport` (RFC-054)", () => {
    const auth = { Authorization: "Bearer t" };
    const json = toMcpJson(
      [
        { name: "a", url: "https://a.example/mcp", headers: auth, transport: "sse" },
        { name: "b", url: "https://b.example/mcp", headers: auth, transport: "http" },
        { name: "c", url: "https://c.example/mcp", headers: auth },
      ],
      {},
    );
    expect(json.mcpServers.a).toMatchObject({ type: "sse" });
    expect(json.mcpServers.b).toMatchObject({ type: "http" });
    expect(json.mcpServers.c).toMatchObject({ type: "http" });
    for (const e of Object.values(json.mcpServers)) expect(e).not.toHaveProperty("transport");
  });

  it("omits HTTP servers with no Authorization", () => {
    const json = toMcpJson(
      [
        { name: "fly", command: "flyctl", args: ["mcp", "server"] },
        { name: "vercel", url: "https://mcp.vercel.com", transport: "http" },
      ],
      {},
    );
    expect(Object.keys(json.mcpServers)).toEqual(["fly"]);
  });

  it("omits stdio servers whose env expands empty", () => {
    const json = toMcpJson(
      [
        {
          name: "databricks",
          command: "npx",
          args: ["-y", "databricks-mcp"],
          env: { DATABRICKS_TOKEN: "${DATABRICKS_TOKEN}" },
        },
        { name: "azure", command: "npx", args: ["-y", "@azure/mcp@latest", "server", "start"] },
      ],
      {},
    );
    expect(Object.keys(json.mcpServers)).toEqual(["azure"]);
  });
});

describe("toAcpMcpServers", () => {
  it("maps stdio and http into ACP shapes", () => {
    const acp = toAcpMcpServers(
      [
        { name: "fs", command: "npx", args: ["-y", "mcp-fs", "/tmp"], env: { FOO: "${X}" } },
        { name: "api", url: "https://mcp.example/mcp", headers: { Authorization: "Bearer ${X}" } },
      ],
      { X: "tok" },
    );
    expect(acp).toEqual([
      {
        name: "fs",
        command: "npx",
        args: ["-y", "mcp-fs", "/tmp"],
        env: [{ name: "FOO", value: "tok" }],
      },
      {
        type: "http",
        name: "api",
        url: "https://mcp.example/mcp",
        headers: [{ name: "Authorization", value: "Bearer tok" }],
      },
    ]);
  });

  it("omits HTTP servers with no Authorization (Grok AuthRequired is fatal)", () => {
    const acp = toAcpMcpServers(
      [
        { name: "fly", command: "flyctl", args: ["mcp", "server"] },
        { name: "vercel", url: "https://mcp.vercel.com", transport: "http" },
        { name: "github", url: "https://api.githubcopilot.com/mcp/", transport: "http" },
      ],
      {},
    );
    expect(acp.map((s) => s.name)).toEqual(["fly"]);
  });
});

describe("claudeMcpConfigArgs", () => {
  it("is present only when a config path exists", () => {
    expect(claudeMcpConfigArgs(undefined)).toEqual([]);
    expect(claudeMcpConfigArgs("/tmp/p.mcp.json")).toEqual(["--mcp-config", "/tmp/p.mcp.json"]);
  });
});

describe("writeProfileMcpJson", () => {
  it("writes owner-only json and skips empty lists", () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-mcp-"));
    const profile: AgentProfile = {
      id: "nightmoose",
      name: "NightMoose",
      backend: "grok",
      color: "#73B8FF",
      mcpServers: [{ name: "dbx", command: "npx", args: ["-y", "databricks-mcp"] }],
    };
    const path = writeProfileMcpJson(dir, profile, {});
    expect(path).toBe(join(dir, "mcp", "nightmoose.mcp.json"));
    const body = JSON.parse(readFileSync(path!, "utf8")) as { mcpServers: { dbx: { command: string } } };
    expect(body.mcpServers.dbx.command).toBe("npx");
    expect(
      writeProfileMcpJson(dir, { ...profile, mcpServers: [] }, {}),
    ).toBeUndefined();
    expect(enabledMcpServers([{ name: "x", command: "c", enabled: false }])).toEqual([]);
  });

  it("injects a stored OAuth bearer into the Claude mcp json", () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-mcp-"));
    writeOAuthTokens(dir, "nightmoose", "gmail", {
      accessToken: "atk",
      clientId: "cid",
      tokenEndpoint: "https://auth.example.com/token",
      resource: "https://mcp.example.com/mcp",
      obtainedAt: Date.now(),
    });
    const profile: AgentProfile = {
      id: "nightmoose",
      name: "NightMoose",
      backend: "grok",
      color: "#73B8FF",
      mcpServers: [{ name: "gmail", url: "https://mcp.example.com/mcp", transport: "http" }],
    };
    const path = writeProfileMcpJson(dir, profile, {});
    const body = JSON.parse(readFileSync(path!, "utf8")) as {
      mcpServers: { gmail: { headers: { Authorization: string } } };
    };
    expect(body.mcpServers.gmail.headers.Authorization).toBe("Bearer atk");
  });
});

describe("publicMcpServers", () => {
  it("lists names only — no env, headers, or oauth secrets", () => {
    expect(
      publicMcpServers([
        {
          name: "gmail",
          url: "https://mcp.example.com/mcp",
          headers: { Authorization: "Bearer secret" },
          oauthClientSecret: "shh",
          env: { TOKEN: "x" },
        },
      ]),
    ).toEqual([
      { name: "gmail", enabled: undefined, command: undefined, url: "https://mcp.example.com/mcp", transport: undefined },
    ]);
  });
});

describe("project sql server in the Claude mcp json (RFC-061)", () => {
  const DB = "postgresql://u:pa${HOME}ss@db.example.supabase.co:5432/postgres";
  const profile: AgentProfile = {
    id: "nightmoose",
    name: "NightMoose",
    backend: "claude",
    color: "#73B8FF",
    mcpServers: [{ name: "sql", command: "user-sql" }, { name: "dbx", command: "npx" }],
  };

  it("points at the built server next to mcp.js and is not a profile field", () => {
    const s = projectSqlMcpServer(DB);
    expect(s).toMatchObject({ name: "sql", command: process.execPath, args: [SQL_MCP_PATH], env: { DATABASE_URL: DB } });
    expect(SQL_MCP_PATH.endsWith(join("mcp", "sql-execute.js"))).toBe(true);
    expect(JSON.stringify(publicMcpServers(profile.mcpServers))).not.toContain("supabase");
  });

  it("writes a per-session 0600 file, literal value, shadowing a profile 'sql'", () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-mcp-"));
    const path = writeProfileMcpJson(dir, profile, { HOME: "/home/x" }, [projectSqlMcpServer(DB)], "sess-a")!;
    expect(path).toBe(join(dir, "mcp", "nightmoose.sess-a.mcp.json"));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const body = JSON.parse(readFileSync(path, "utf8")) as {
      mcpServers: Record<string, { command: string; env?: Record<string, string> }>;
    };
    // No ${VAR} expansion over the secret.
    expect(body.mcpServers.sql!.env!.DATABASE_URL).toBe(DB);
    expect(body.mcpServers.sql!.command).toBe(process.execPath);
    expect(body.mcpServers.dbx!.command).toBe("npx");
    // The shared per-profile file is never written with the secret.
    expect(existsSync(join(dir, "mcp", "nightmoose.mcp.json"))).toBe(false);
  });

  it("keeps two sessions in different projects apart", () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-mcp-"));
    const a = writeProfileMcpJson(dir, profile, {}, [projectSqlMcpServer("postgres://a:1@a/a")], "sess-a")!;
    const b = writeProfileMcpJson(dir, profile, {}, [projectSqlMcpServer("postgres://b:2@b/b")], "sess-b")!;
    expect(a).not.toBe(b);
    expect(readFileSync(a, "utf8")).toContain("postgres://a:1@a/a");
    expect(readFileSync(a, "utf8")).not.toContain("postgres://b:2@b/b");
  });

  it("removes a session's stale file once its project has no database, and on demand", () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-mcp-"));
    const a = writeProfileMcpJson(dir, profile, {}, [projectSqlMcpServer(DB)], "sess-a")!;
    const after = writeProfileMcpJson(dir, profile, {}, undefined, "sess-a");
    expect(existsSync(a)).toBe(false);
    expect(after).toBe(join(dir, "mcp", "nightmoose.mcp.json"));
    expect(readFileSync(after!, "utf8")).not.toContain("supabase");

    const b = writeProfileMcpJson(dir, profile, {}, [projectSqlMcpServer(DB)], "sess-b")!;
    removeSessionMcpJson(dir, profile.id, "sess-b");
    expect(existsSync(b)).toBe(false);
  });
});
