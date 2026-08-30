import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  claudeMcpConfigArgs,
  enabledMcpServers,
  normalizeMcpServers,
  publicMcpServers,
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
      transport: "http",
    });
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
