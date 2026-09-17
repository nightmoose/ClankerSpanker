import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeMcpServers } from "./mcp.js";
import {
  MCP_CATALOG,
  MCP_CATALOG_ASSIGNMENTS,
  applyCatalogDefaults,
  catalogServerToProfile,
  defaultCatalogIdsFor,
  publicMcpCatalog,
} from "./mcp-catalog.js";

const catalogPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "MCP-CATALOG.md");

function jsonFences(markdown: string): unknown[] {
  const out: unknown[] = [];
  const re = /```json\s*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown))) {
    out.push(JSON.parse(m[1]!));
  }
  return out;
}

describe("docs/MCP-CATALOG.md", () => {
  const markdown = readFileSync(catalogPath, "utf8");
  const fences = jsonFences(markdown);
  const arrays = fences.filter(Array.isArray) as unknown[][];

  it("fenced JSON blocks parse", () => {
    expect(fences.length).toBeGreaterThanOrEqual(3);
    expect(arrays).toHaveLength(3);
  });

  it("profile arrays normalize to named servers with a command or url", () => {
    for (const block of arrays) {
      const servers = normalizeMcpServers(block as Parameters<typeof normalizeMcpServers>[0]);
      expect(servers?.length).toBeGreaterThan(0);
      for (const s of servers!) {
        expect(s.name).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(Boolean(s.command) || Boolean(s.url)).toBe(true);
      }
    }
  });

  it("keeps payer isolation: NightMoose vs FullScore vs Personal", () => {
    const [nightmoose, personal, fullscore] = arrays.map(
      (block) => normalizeMcpServers(block as Parameters<typeof normalizeMcpServers>[0])!.map((s) => s.name),
    );
    expect(nightmoose).toEqual(["github", "vercel", "supabase", "notion", "fly"]);
    expect(personal).toEqual(["github", "notion"]);
    expect(fullscore).toEqual(["databricks", "azure-devops", "azure"]);
    expect(nightmoose).not.toContain("gmail");
    expect(nightmoose).not.toContain("databricks");
    expect(fullscore).not.toContain("vercel");
  });

  it("fenced profile arrays match the TypeScript catalog assignments", () => {
    const [nightmoose, personal, fullscore] = arrays.map(
      (block) => normalizeMcpServers(block as Parameters<typeof normalizeMcpServers>[0])!.map((s) => s.name),
    );
    expect(nightmoose).toEqual([...MCP_CATALOG_ASSIGNMENTS.nightmoose!]);
    expect(personal).toEqual([...MCP_CATALOG_ASSIGNMENTS.personal!]);
    expect(fullscore).toEqual([...MCP_CATALOG_ASSIGNMENTS.fullscore!]);
  });
});

describe("applyCatalogDefaults", () => {
  it("assigns NightMoose / Personal / FullScore without leaking payers", () => {
    const nm = applyCatalogDefaults("nightmoose")!.map((s) => s.name);
    const personal = applyCatalogDefaults("personal")!.map((s) => s.name);
    const full = applyCatalogDefaults("fullscore")!.map((s) => s.name);
    expect(nm).toEqual(["github", "vercel", "supabase", "notion", "fly"]);
    expect(personal).toEqual(["github", "notion"]);
    expect(full).toEqual(["databricks", "azure-devops", "azure"]);
    expect(nm).not.toContain("databricks");
    expect(full).not.toContain("vercel");
    expect(applyCatalogDefaults("gemini")).toBeUndefined();
    expect(defaultCatalogIdsFor("unknown-chip")).toEqual([]);
  });

  it("merge keeps an existing same-name row; replace does not", () => {
    const existing = [
      { name: "github", url: "https://example.invalid/mcp", transport: "http" as const },
    ];
    const merged = applyCatalogDefaults("personal", existing)!;
    expect(merged.find((s) => s.name === "github")!.url).toBe("https://example.invalid/mcp");
    expect(merged.map((s) => s.name)).toEqual(["github", "notion"]);

    const replaced = applyCatalogDefaults("personal", existing, { replace: true })!;
    expect(replaced.find((s) => s.name === "github")!.url).toBe(
      "https://api.githubcopilot.com/mcp/",
    );
    expect(replaced.map((s) => s.name)).toEqual(["github", "notion"]);
  });

  it("catalogServerToProfile copies transport + command/url", () => {
    const fly = MCP_CATALOG.find((s) => s.id === "fly")!;
    expect(catalogServerToProfile(fly)).toMatchObject({
      name: "fly",
      command: "flyctl",
      args: ["mcp", "server"],
      transport: "stdio",
    });
  });

  it("public catalog has no secrets", () => {
    const pub = publicMcpCatalog();
    expect(pub.assignments.nightmoose).toContain("vercel");
    const github = pub.servers.find((s) => s.id === "github");
    expect(github?.headers?.Authorization).toBe("Bearer ${GITHUB_TOKEN}");
    for (const s of pub.servers) {
      expect(s).not.toHaveProperty("oauthClientSecret");
      for (const v of Object.values(s.headers ?? {})) {
        expect(v).toMatch(/\$\{[A-Z_][A-Z0-9_]*\}/);
      }
    }
  });
});
