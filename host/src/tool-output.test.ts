import { describe, expect, it } from "vitest";
import { OUTPUT_PREVIEW_CHARS, toolOutputSummary } from "./tool-output.js";

describe("toolOutputSummary (RFC-040)", () => {
  it("reads ACP content text blocks", () => {
    expect(toolOutputSummary([{ type: "content", content: { type: "text", text: "5\n" } }], null)).toEqual({ outputPreview: "5" });
  });

  it("falls back to rawOutput and keeps the exit code", () => {
    const r = toolOutputSummary([{ type: "content", content: { type: "text", text: "" } }], {
      output_for_prompt: "/usr/bin/python: No module named pytest\n",
      exit_code: 1,
    });
    expect(r).toEqual({ outputPreview: "/usr/bin/python: No module named pytest", exitCode: 1 });
  });

  it("keeps only the tail", () => {
    const text = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    expect(toolOutputSummary([{ type: "text", text }], null).outputPreview).toBe("line 14\nline 15\nline 16\nline 17\nline 18\nline 19");
    const long = "x".repeat(2000);
    expect(toolOutputSummary([{ type: "text", text: long }], null).outputPreview!.length).toBe(OUTPUT_PREVIEW_CHARS + 1);
  });

  it("returns nothing when there is no output", () => {
    expect(toolOutputSummary(undefined, undefined)).toEqual({});
  });
});

import { SessionStore } from "./sessions/store.js";

describe("tool output survives slimming and the wire (RFC-040)", () => {
  it("keeps outputPreview and exitCode in session detail", () => {
    const store = Object.create(SessionStore.prototype) as SessionStore;
    const now = new Date().toISOString();
    const session = {
      id: "s", backend: "grok", title: "t", prompt: "p", cwd: "/tmp", model: "m", planMode: false,
      subagents: false, worktree: false, status: "idle", createdAt: now, updatedAt: now,
      transcript: [], events: [],
      toolCalls: [{ toolCallId: "c1", title: "Execute `pytest`", kind: "execute", status: "completed", updatedAt: now,
        content: [{ type: "content", content: { type: "text", text: "No module named pytest\n" } }],
        outputPreview: "No module named pytest", exitCode: 1 }],
    };
    const detail = store.toDetail(session as never) as unknown as { toolCalls: Array<Record<string, unknown>> };
    expect(detail.toolCalls[0]).toMatchObject({ outputPreview: "No module named pytest", exitCode: 1 });
    expect(detail.toolCalls[0]).not.toHaveProperty("content");
  });
});
