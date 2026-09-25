import type { AgentProfile, DispatchSession, SessionEvent } from "../../types.js";
import type { TurnContext } from "./context.js";

/** Test double for TurnContext (RFC-052). Records persists and events. */
export function fakeContext(session: DispatchSession, profile: Partial<AgentProfile> = {}) {
  const events: Array<{ type: SessionEvent["type"]; payload: unknown }> = [];
  let persists = 0;
  const notifications: string[] = [];
  const ctx: TurnContext = {
    config: { dataDir: "/tmp/cs-fake-data", promptMaxMs: 1000, autoApproveKinds: [] } as never,
    cliRunners: new Map(),
    botRuns: new Map(),
    get: (id) => (id === session.id ? session : null),
    persist: () => {
      persists++;
    },
    emitEvent: (_s, type, payload) => {
      events.push({ type, payload });
    },
    maybeNotify: (title) => {
      notifications.push(title);
    },
    profileFor: () => ({ id: "p", name: "P", backend: "claude", color: "#fff", ...profile }) as AgentProfile,
    profileEnvFor: () => ({}),
    buildTransferHandoffPrompt: (_s, m) => m,
    botBrainProfile: (owner) => owner,
  };
  return { ctx, events, notifications, persistCount: () => persists };
}

export function fakeSession(over: Partial<DispatchSession> = {}): DispatchSession {
  const now = new Date().toISOString();
  return {
    id: "s1",
    backend: "claude",
    profileId: "p",
    title: "t",
    prompt: "p",
    cwd: "/tmp",
    model: "m",
    planMode: false,
    subagents: false,
    worktree: false,
    status: "idle",
    createdAt: now,
    updatedAt: now,
    transcript: [],
    toolCalls: [],
    events: [],
    ...over,
  } as DispatchSession;
}

import { describe, expect, it } from "vitest";

describe("fakeContext (test double)", () => {
  it("records events and resolves only its own session", () => {
    const s = fakeSession();
    const { ctx, events } = fakeContext(s);
    ctx.emitEvent(s, "session.updated", { status: "running" });
    expect(events).toHaveLength(1);
    expect(ctx.get("s1")).toBe(s);
    expect(ctx.get("other")).toBeNull();
  });
});
