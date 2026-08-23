import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_TOOL_BLOB_CHARS, SessionStore, capToolBlob, toolBlobToJson } from "./store.js";
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
