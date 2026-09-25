import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const seen: { opts?: Record<string, unknown> } = {};
vi.mock("../../antigravity/runner.js", () => ({
  AntigravityRunner: class extends EventEmitter {
    constructor(opts: Record<string, unknown>) {
      super();
      seen.opts = opts;
    }
    async run() {
      this.emit("text", "done");
      return { text: "All done", conversationId: "agy-9" };
    }
    stop() {}
  },
}));

const { antigravityTurn } = await import("./antigravity-turn.js");
const { fakeContext, fakeSession } = await import("./fake-context.test.js");

describe("antigravityTurn (RFC-052)", () => {
  it("stores the conversation id, ends idle and releases the runner", async () => {
    const session = fakeSession({ backend: "antigravity" });
    const { ctx } = fakeContext(session, { backend: "antigravity" });
    const out = await antigravityTurn(ctx, "s1", "hi");
    expect(out.status).toBe("idle");
    expect(out.antigravityConversationId).toBe("agy-9");
    expect(ctx.cliRunners.size).toBe(0);
  });

  it("skips permissions by default and honours ANTIGRAVITY_REQUIRE_PERMISSIONS (RFC-030)", async () => {
    const s1 = fakeSession({ backend: "antigravity" });
    await antigravityTurn(fakeContext(s1, { backend: "antigravity" }).ctx, "s1", "hi");
    expect(seen.opts?.skipPermissions).toBe(true);

    const s2 = fakeSession({ backend: "antigravity" });
    const { ctx } = fakeContext(s2, { backend: "antigravity" });
    ctx.profileEnvFor = () => ({ ANTIGRAVITY_REQUIRE_PERMISSIONS: "1" });
    await antigravityTurn(ctx, "s1", "hi");
    expect(seen.opts?.skipPermissions).toBe(false);
  });
});
