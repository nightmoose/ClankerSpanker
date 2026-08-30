import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  claudeMcpConfigArgs,
  enabledMcpServers,
  normalizeMcpServers,
  toAcpMcpServers,
  toMcpJson,
  writeProfileMcpJson,
} from "./mcp.js";
import type { AgentProfile } from "./types.js";

describe("normalizeMcpServers", () => {
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
});
