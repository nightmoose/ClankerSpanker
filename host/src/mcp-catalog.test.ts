import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeMcpServers } from "./mcp.js";

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
});
