import { describe, expect, it } from "vitest";
import {
  drainPendingQuestionsByToolCall,
  shouldFlipToIdleAfterTurn,
} from "./session-manager.js";
import type { DispatchSession, PendingApproval, PendingQuestion } from "../types.js";

/**
 * Regression coverage for RFC-019. The end-of-turn block in
 * `handlePrompt` used to read from `live.pendingApprovals` and
 * `live.pendingQuestions` (in-memory maps) — those drifted out of
 * sync with the persisted session and stranded transcripts on
 * "Running" forever. The fix is to read from the persisted session
 * and to drain the map when the underlying tool call clears the
 * question.
 */

function baseSession(overrides: Partial<DispatchSession> = {}): DispatchSession {
  const ts = new Date().toISOString();
  return {
    id: "sess-1",
    backend: "grok",
    title: "Rfc-019 regression",
    prompt: "",
    cwd: "/tmp",
    model: "grok-2",
    profileId: "nightmoose",
    profileName: "NightMoose",
    planMode: false,
    subagents: false,
    worktree: false,
    status: "running",
    createdAt: ts,
    updatedAt: ts,
    transcript: [],
    toolCalls: [],
    events: [],
    ...overrides,
  };
}

function stubApproval(id = "app-1"): PendingApproval {
  return {
    id,
    sessionId: "sess-1",
    title: "Bash: rm -rf",
    kind: "execute",
    rawInput: {},
    options: [
      { optionId: "allow-once", name: "Allow", kind: "allow_once" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ],
    createdAt: new Date().toISOString(),
  };
}

function stubQuestion(overrides: Partial<PendingQuestion> = {}): PendingQuestion {
  return {
    id: "q-1",
    sessionId: "sess-1",
    title: "Answer 1 question",
    questions: [{ text: "Ok?", options: [{ value: "yes" }, { value: "no" }] }],
    createdAt: new Date().toISOString(),
    canRespondViaAcp: false,
    ...overrides,
  };
}

describe("shouldFlipToIdleAfterTurn (RFC-019)", () => {
  it("flips when no persisted pending, running status", () => {
    const s = baseSession({ status: "running", pendingApproval: null, pendingQuestion: null });
    expect(shouldFlipToIdleAfterTurn(s)).toBe(true);
  });

  it("does not flip when the session already carries a pendingApproval on disk", () => {
    const s = baseSession({ status: "running", pendingApproval: stubApproval() });
    expect(shouldFlipToIdleAfterTurn(s)).toBe(false);
  });

  it("does not flip when the session already carries a pendingQuestion on disk", () => {
    const s = baseSession({ status: "running", pendingQuestion: stubQuestion() });
    expect(shouldFlipToIdleAfterTurn(s)).toBe(false);
  });

  it("does not flip when status is already awaiting_approval / awaiting_question", () => {
    expect(shouldFlipToIdleAfterTurn(baseSession({ status: "awaiting_approval" }))).toBe(false);
    expect(shouldFlipToIdleAfterTurn(baseSession({ status: "awaiting_question" }))).toBe(false);
  });

  it("does not flip when status is terminal (cancelled / failed)", () => {
    expect(shouldFlipToIdleAfterTurn(baseSession({ status: "cancelled" }))).toBe(false);
    expect(shouldFlipToIdleAfterTurn(baseSession({ status: "failed" }))).toBe(false);
  });

  it("flips even if a stale in-memory live.pendingQuestions map still held entries — persisted state is authoritative", () => {
    // The regression: pre-RFC-019 code peeked at live.pendingQuestions.size
    // and refused to flip. This test asserts the helper ignores it entirely
    // and reads only from the persisted session.
    const s = baseSession({ status: "running", pendingApproval: null, pendingQuestion: null });
    expect(shouldFlipToIdleAfterTurn(s)).toBe(true);
  });
});

describe("drainPendingQuestionsByToolCall (RFC-019)", () => {
  it("removes only the entries whose toolCallId matches", () => {
    const map = new Map<string, PendingQuestion & { rpcId?: number | string }>();
    map.set("q-a", { ...stubQuestion({ id: "q-a", toolCallId: "tool-1" }) });
    map.set("q-b", { ...stubQuestion({ id: "q-b", toolCallId: "tool-2" }) });
    map.set("q-c", { ...stubQuestion({ id: "q-c", toolCallId: "tool-1" }) });

    const drained = drainPendingQuestionsByToolCall(map, "tool-1");

    expect(drained).toBe(2);
    expect(map.has("q-a")).toBe(false);
    expect(map.has("q-b")).toBe(true);
    expect(map.has("q-c")).toBe(false);
  });

  it("is a no-op when toolCallId is undefined (belt-and-suspenders)", () => {
    const map = new Map<string, PendingQuestion & { rpcId?: number | string }>();
    map.set("q-a", { ...stubQuestion({ id: "q-a", toolCallId: "tool-1" }) });
    expect(drainPendingQuestionsByToolCall(map, undefined)).toBe(0);
    expect(map.has("q-a")).toBe(true);
  });

  it("is a no-op when the map is empty", () => {
    const map = new Map<string, PendingQuestion & { rpcId?: number | string }>();
    expect(drainPendingQuestionsByToolCall(map, "tool-1")).toBe(0);
    expect(map.size).toBe(0);
  });
});
