import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeRunner, extractToolResults } from "./runner.js";

// RFC-056: Claude tool results arrive as stream-json `user` frames.
const saved = process.env.CLAUDE_BINARY;
afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDE_BINARY;
  else process.env.CLAUDE_BINARY = saved;
});

const frames = [
  {
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "calc.py" } },
        { type: "tool_use", id: "t2", name: "Bash", input: { command: "pytest" } },
      ],
    },
  },
  {
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "def add(a, b):" }] },
        { type: "tool_result", tool_use_id: "t2", content: "pytest: command not found", is_error: true },
      ],
    },
  },
  { type: "result", result: "done", session_id: "c1" },
];

describe("ClaudeRunner tool results (RFC-056)", () => {
  it("emits every tool_use and then each result with status + output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
    writeFileSync(join(dir, "frames.jsonl"), frames.map((f) => JSON.stringify(f)).join("\n") + "\n");
    const bin = join(dir, "claude");
    writeFileSync(bin, `#!/bin/sh\ncat "${join(dir, "frames.jsonl")}"\n`);
    chmodSync(bin, 0o755);
    process.env.CLAUDE_BINARY = bin;

    const r = new ClaudeRunner({
      cwd: dir,
      prompt: "hi",
      dispatchSessionId: "s1",
      hostBaseUrl: "http://127.0.0.1:1",
      hostToken: "t",
      dataDir: dir,
      requirePhoneApproval: false,
    });
    const tools: Array<Record<string, unknown>> = [];
    r.on("tool", (t) => tools.push(t));
    await r.run();
    expect(tools).toEqual([
      { name: "Read", id: "t1", input: { file_path: "calc.py" }, status: "pending" },
      { name: "Bash", id: "t2", input: { command: "pytest" }, status: "pending" },
      { id: "t1", status: "completed", output: "def add(a, b):" },
      { id: "t2", status: "failed", output: "pytest: command not found" },
    ]);
  });
});

describe("extractToolResults", () => {
  it("ignores plain user text and results without an id", () => {
    expect(
      extractToolResults({
        type: "user",
        message: { content: [{ type: "text", text: "hi" }, { type: "tool_result", content: "x" }] },
      }),
    ).toEqual([]);
  });

  it("omits output when the result is empty", () => {
    expect(
      extractToolResults({ message: { content: [{ type: "tool_result", tool_use_id: "a", content: [] }] } }),
    ).toEqual([{ id: "a", status: "completed" }]);
  });
});
