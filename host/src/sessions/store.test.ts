import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_TOOL_BLOB_CHARS, SessionStore, capToolBlob, computeSessionListETag, pageItems, toolBlobToJson } from "./store.js";
import type { DispatchSession, ToolCallRecord } from "../types.js";

function session(tool: ToolCallRecord): DispatchSession {
  const ts = new Date().toISOString();
  return {
    id: "sess-tools",
    backend: "claude",
    title: "t",
    prompt: "p",
    cwd: "/tmp",
    model: "claude",
    planMode: false,
    subagents: false,
    worktree: false,
    status: "idle",
    createdAt: ts,
    updatedAt: ts,
    transcript: [],
    toolCalls: [tool],
    events: [],
  };
}

describe("capToolBlob", () => {
  it("passes small objects through", () => {
    expect(capToolBlob({ command: "ls" })).toEqual({ command: "ls" });
  });

  it("truncates giant dumps so session JSON cannot blow up", () => {
    const huge = { dump: "x".repeat(MAX_TOOL_BLOB_CHARS + 50) };
    const capped = capToolBlob(huge) as { _truncated: boolean; preview: string };
    expect(capped._truncated).toBe(true);
    expect(capped.preview.length).toBe(MAX_TOOL_BLOB_CHARS);
  });
});

describe("SessionStore tool rawInput", () => {
  it("round-trips capped rawInput through disk (ellipsis sheet needs this)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-store-"));
    const store = new SessionStore(dir);
    store.save(
      session({
        toolCallId: "t1",
        title: "Bash",
        kind: "execute",
        status: "completed",
        updatedAt: new Date().toISOString(),
        rawInput: { command: "npx tsc --noEmit" },
      }),
    );
    const loaded = store.load("sess-tools");
    expect(loaded?.toolCalls[0]?.rawInput).toEqual({ command: "npx tsc --noEmit" });
    expect(toolBlobToJson(loaded?.toolCalls[0]?.rawInput)).toContain("npx tsc");
  });
});

// ── RFC-069: toListItem ────────────────────────────────────────────────────

function makeSession(overrides: Partial<DispatchSession> = {}): DispatchSession {
  const ts = "2026-01-01T00:00:00.000Z";
  return {
    id: "s1",
    backend: "claude",
    title: "Hello",
    prompt: "Do the thing",
    cwd: "/home/user/project",
    model: "claude-3-5-sonnet",
    planMode: false,
    subagents: false,
    worktree: false,
    status: "idle",
    createdAt: ts,
    updatedAt: ts,
    transcript: [],
    toolCalls: [],
    events: [],
    ...overrides,
  };
}

describe("SessionStore.toListItem", () => {
  const dir = mkdtempSync(join(tmpdir(), "cs-store-list-"));
  const store = new SessionStore(dir);

  it("returns the slim shape with required fields", () => {
    const item = store.toListItem(makeSession());
    expect(item.id).toBe("s1");
    expect(item.title).toBe("Hello");
    expect(item.status).toBe("idle");
    expect(item.model).toBe("claude-3-5-sonnet");
    expect(item.cwd).toBe("/home/user/project");
    expect(item.planMode).toBe(false);
    expect(item.toolCallCount).toBe(0);
    expect(typeof item.createdAt).toBe("string");
    expect(typeof item.updatedAt).toBe("string");
  });

  it("does not include fields dropped from the slim shape", () => {
    const item = store.toListItem(makeSession({ error: "boom", botId: "b1" })) as Record<string, unknown>;
    expect(item).not.toHaveProperty("error");
    expect(item).not.toHaveProperty("botId");
    expect(item).not.toHaveProperty("claudeSessionId");
    expect(item).not.toHaveProperty("antigravityConversationId");
    expect(item).not.toHaveProperty("pendingApprovalId");
    expect(item).not.toHaveProperty("completedAt");
    expect(item).not.toHaveProperty("grokSessionId");
  });

  it("truncates prompt to 160 chars", () => {
    const longPrompt = "x".repeat(300);
    const item = store.toListItem(makeSession({ prompt: longPrompt }));
    expect(item.prompt.length).toBe(160);
  });

  it("picks the last assistant message as transcriptPreview (max 240 chars)", () => {
    const s = makeSession({
      transcript: [
        { id: "m1", role: "user", text: "hi", at: "t" },
        { id: "m2", role: "assistant", text: "a".repeat(300), at: "t" },
        { id: "m3", role: "assistant", text: "last", at: "t" },
      ],
    });
    const item = store.toListItem(s);
    expect(item.transcriptPreview).toBe("last");
  });

  it("caps transcriptPreview at 240 chars", () => {
    const s = makeSession({
      transcript: [{ id: "m1", role: "assistant", text: "z".repeat(500), at: "t" }],
    });
    expect(store.toListItem(s).transcriptPreview?.length).toBe(240);
  });

  it("returns undefined transcriptPreview when transcript is empty", () => {
    expect(store.toListItem(makeSession()).transcriptPreview).toBeUndefined();
  });

  it("backward compat: toSummary still returns the full shape with dropped fields", () => {
    const s = makeSession({ error: "oops", completedAt: "2026-01-02T00:00:00.000Z", pendingApprovalId: "p1" });
    const full = store.toSummary(s) as Record<string, unknown>;
    expect(full).toHaveProperty("error", "oops");
    expect(full).toHaveProperty("completedAt", "2026-01-02T00:00:00.000Z");
    expect(full).toHaveProperty("pendingApprovalId", "p1");
  });
});

// ── RFC-069: pageItems ────────────────────────────────────────────────────

describe("pageItems", () => {
  const items = [
    { id: "a", updatedAt: "2026-01-04" },
    { id: "b", updatedAt: "2026-01-03" },
    { id: "c", updatedAt: "2026-01-02" },
    { id: "d", updatedAt: "2026-01-01" },
  ];

  it("returns first page when no cursor", () => {
    const { page, nextCursor } = pageItems(items, 2, null);
    expect(page.map((x) => x.id)).toEqual(["a", "b"]);
    expect(nextCursor).toBeDefined();
  });

  it("returns second page from cursor", () => {
    const { page: p1, nextCursor: c1 } = pageItems(items, 2, null);
    const { page: p2, nextCursor: c2 } = pageItems(items, 2, c1 ?? null);
    expect(p1.map((x) => x.id)).toEqual(["a", "b"]);
    expect(p2.map((x) => x.id)).toEqual(["c", "d"]);
    expect(c2).toBeUndefined();
  });

  it("returns no nextCursor when all items fit on one page", () => {
    const { nextCursor } = pageItems(items, 10, null);
    expect(nextCursor).toBeUndefined();
  });

  it("ignores malformed cursor and starts from beginning", () => {
    const { page } = pageItems(items, 2, "not-base64url-json");
    expect(page[0]?.id).toBe("a");
  });
});

// ── RFC-069: computeSessionListETag ─────────────────────────────────────

describe("computeSessionListETag", () => {
  it("returns a quoted string", () => {
    const tag = computeSessionListETag('{"sessions":[]}');
    expect(tag).toMatch(/^"[0-9a-f]+"$/);
  });

  it("is stable — same body produces the same ETag", () => {
    const body = '{"sessions":[{"id":"x"}]}';
    expect(computeSessionListETag(body)).toBe(computeSessionListETag(body));
  });

  it("changes when the body changes", () => {
    expect(computeSessionListETag('{"a":1}')).not.toBe(computeSessionListETag('{"a":2}'));
  });
});
