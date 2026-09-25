import { describe, expect, it, vi } from "vitest";

const calls: Array<Record<string, unknown>> = [];
vi.mock("../../bot/runner.js", () => ({
  runBotSession: async (opts: Record<string, unknown>) => {
    calls.push(opts);
  },
}));

const { botTurn } = await import("./bot-turn.js");
const { fakeContext, fakeSession } = await import("./fake-context.test.js");

describe("botTurn (RFC-052)", () => {
  it("runs the bot with the host's limits and clears its run slot", async () => {
    const session = fakeSession({ backend: "bot" });
    const { ctx } = fakeContext(session, { backend: "bot", toolAllowlist: ["read_file"] } as never);
    await botTurn(ctx, session, "hunt", false);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ prompt: "hunt", isFollowUp: false, maxTurns: 20, toolsAllowlist: ["read_file"] });
    expect(ctx.botRuns.has(session.id)).toBe(false);
  });
});
