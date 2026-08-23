import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allTools, parseOutbound, renderOutboundMarkdown } from "./tools/index.js";
import { assertOutboxPath, resolveUnderCwd } from "./tools/paths.js";

function tmpCwd(): string {
  return mkdtempSync(join(tmpdir(), "cs-bot-"));
}

function tool(name: string) {
  const t = allTools().find((x) => x.spec.name === name);
  if (!t) throw new Error(name);
  return t;
}

describe("path confinement", () => {
  it("resolveUnderCwd rejects .. escape", () => {
    const cwd = tmpCwd();
    expect(() => resolveUnderCwd(cwd, "../secret")).toThrow(/escapes cwd/);
  });

  it("write_file outside cwd / outside .bot-outbox throws", async () => {
    const cwd = tmpCwd();
    const write = tool("write_file");
    await expect(
      write.execute({ path: "README.md", content: "nope" }, { cwd, sessionId: "s", fetchImpl: fetch }),
    ).rejects.toThrow(/confined/);
    await expect(
      write.execute(
        { path: "../outside.md", content: "nope" },
        { cwd, sessionId: "s", fetchImpl: fetch },
      ),
    ).rejects.toThrow();
    expect(() => assertOutboxPath(cwd, ".bot-outbox/ok.md")).not.toThrow();
  });

  it("write_file succeeds inside .bot-outbox", async () => {
    const cwd = tmpCwd();
    mkdirSync(join(cwd, ".bot-outbox"));
    const write = tool("write_file");
    const result = await write.execute(
      { path: ".bot-outbox/brief.md", content: "hello" },
      { cwd, sessionId: "s", fetchImpl: fetch },
    );
    expect(result).toMatch(/Wrote/);
    expect(readFileSync(join(cwd, ".bot-outbox/brief.md"), "utf8")).toBe("hello");
  });
});

describe("propose_outbound", () => {
  it("emits an outbox file and does not hit the network", async () => {
    const cwd = tmpCwd();
    mkdirSync(join(cwd, ".bot-outbox"));
    let fetches = 0;
    const fetchImpl: typeof fetch = async () => {
      fetches += 1;
      throw new Error("network should not be called");
    };
    const outbound = tool("propose_outbound");
    expect(outbound.auto).toBe(true);
    expect(outbound.alwaysApprove).toBe(false);
    expect(outbound.kind).toBe("outbound");
    const result = await outbound.execute(
      {
        channel: "email",
        to: "ada@example.com",
        subject: "contracts",
        body: "Hi Ada — saw your post on schema evolution.",
        reason: "Writes about producer-consumer contracts",
      },
      { cwd, sessionId: "sess-1", fetchImpl },
    );
    expect(fetches).toBe(0);
    expect(result).toMatch(/not sent/);
    // one markdown file in outbox besides maybe nothing
    const md = result.match(/\.bot-outbox\/[\w.-]+\.md/)?.[0];
    expect(md).toBeTruthy();
    const body = readFileSync(join(cwd, md!), "utf8");
    expect(body).toContain("sent: false");
    expect(body).toContain("status: draft");
    expect(body).toContain("ada@example.com");
  });
});

describe("read_file / list_dir", () => {
  it("reads a file under cwd", async () => {
    const cwd = tmpCwd();
    writeFileSync(join(cwd, "a.txt"), "alpha\nbeta\n");
    const out = await tool("read_file").execute(
      { path: "a.txt" },
      { cwd, sessionId: "s", fetchImpl: fetch },
    );
    expect(out).toMatch(/alpha/);
  });
});

describe("renderOutboundMarkdown", () => {
  it("never claims the message was sent", () => {
    const md = renderOutboundMarkdown(parseOutbound({
      channel: "x",
      to: "@someone",
      body: "hello",
      reason: "lead",
    }), { status: "approved", sessionId: "s", approvedAt: "t" });
    expect(md).toContain("sent: false");
  });
});

describe("web_search", () => {
  it("uses Hacker News JSON instead of DuckDuckGo HTML", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("hn.algolia.com")) {
        return new Response(
          JSON.stringify({
            hits: [
              {
                title: "Yes, Virginia, You Really Do Need a Schema Registry",
                url: "https://www.confluent.io/blog/schema-registry",
                author: "gwenshap",
                points: 42,
                created_at: "2015-01-01T00:00:00.000Z",
                objectID: "1",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("wikipedia.org")) {
        return new Response(JSON.stringify({ query: { search: [] } }), { status: 200 });
      }
      return new Response("nope", { status: 404 });
    };
    const out = await tool("web_search").execute(
      { query: "kafka schema registry" },
      { cwd: tmpCwd(), sessionId: "s", fetchImpl },
    );
    expect(out).toMatch(/Schema Registry/);
    expect(out).toMatch(/confluent\.io/);
    expect(out).not.toMatch(/duckduckgo/i);
  });
});
