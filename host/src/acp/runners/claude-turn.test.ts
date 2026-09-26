import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

// RFC-052: the runner takes a TurnContext, so it can be tested without a manager.
const behaviour: { fail?: boolean; tools?: Array<Record<string, unknown>> } = {};
vi.mock("../../claude/runner.js", () => ({
  ClaudeRunner: class extends EventEmitter {
    constructor(public opts: unknown) {
      super();
    }
    async run() {
      for (const t of behaviour.tools ?? [{ name: "Bash", id: "t1", input: { command: "ls" }, status: "completed" }]) {
        this.emit("tool", t);
      }
      this.emit("text", "Hello ");
      if (behaviour.fail) throw new Error("boom");
      return { text: "Hello world", sessionId: "claude-123" };
    }
    stop() {}
  },
}));
vi.mock("../../mcp-oauth.js", () => ({ refreshAllMcpOAuth: async () => undefined }));

const { claudeTurn } = await import("./claude-turn.js");
const { fakeContext, fakeSession } = await import("./fake-context.test.js");

describe("claudeTurn (RFC-052)", () => {
  it("records the tool call and reply, stores the Claude session id, ends idle", async () => {
    behaviour.fail = false;
    const session = fakeSession();
    const { ctx, events } = fakeContext(session);
    const out = await claudeTurn(ctx, "s1", "list files");
    expect(out.status).toBe("idle");
    expect(out.claudeSessionId).toBe("claude-123");
    expect(out.toolCalls.map((t) => t.toolCallId)).toContain("t1");
    expect(out.transcript.at(-1)).toMatchObject({ role: "assistant" });
    expect(ctx.cliRunners.size).toBe(0);
    expect(events.map((e) => e.type)).toContain("tool_call");
    expect(events.at(-1)?.type).toBe("session.updated");
  });

  it("marks the session failed and releases the runner when the CLI errors", async () => {
    behaviour.fail = true;
    const session = fakeSession({ id: "s1" });
    const { ctx, events } = fakeContext(session);
    await expect(claudeTurn(ctx, "s1", "x")).rejects.toThrow();
    expect(session.status).toBe("failed");
    expect(ctx.cliRunners.size).toBe(0);
    expect(events.map((e) => e.type)).toContain("session.failed");
  });

  it("merges a result into the pending call without losing title or input (RFC-056)", async () => {
    behaviour.fail = false;
    behaviour.tools = [
      { name: "Bash", id: "t9", input: { command: "pytest" }, status: "pending" },
      { id: "t9", status: "failed", output: "a\nb\npytest: command not found\n" },
      { name: "Bash", id: "t9", input: { command: "pytest" }, status: "pending" },
    ];
    const session = fakeSession();
    const { ctx } = fakeContext(session);
    await claudeTurn(ctx, "s1", "run tests");
    behaviour.tools = undefined;
    expect(session.toolCalls).toHaveLength(1);
    expect(session.toolCalls[0]).toMatchObject({
      title: "Bash",
      kind: "execute",
      status: "failed",
      rawInput: { command: "pytest" },
      outputPreview: "a\nb\npytest: command not found",
    });
  });

  it("refuses an unknown session", async () => {
    const { ctx } = fakeContext(fakeSession());
    await expect(claudeTurn(ctx, "nope", "x")).rejects.toThrow(/Session not found/);
  });
});
