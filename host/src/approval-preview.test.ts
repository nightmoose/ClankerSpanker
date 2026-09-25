import { describe, expect, it } from "vitest";
import { approvalPreview, PREVIEW_MAX_CHARS } from "./approval-preview.js";

describe("approvalPreview (RFC-033)", () => {
  it("uses ACP diff content blocks (Grok edit)", () => {
    const p = approvalPreview(
      { variant: "SearchReplace", file_path: "/r/calc.py", old_string: "a - b", new_string: "a + b" },
      [{ type: "diff", path: "/r/calc.py", oldText: "return a - b\n", newText: "return a + b\n" }],
    );
    expect(p).toEqual({ type: "diff", path: "/r/calc.py", oldText: "return a - b\n", newText: "return a + b\n", truncated: false });
  });

  it("falls back to old_string / new_string (Claude Edit)", () => {
    expect(approvalPreview({ file_path: "/r/a.ts", old_string: "x", new_string: "y" })).toMatchObject({
      type: "diff",
      path: "/r/a.ts",
      oldText: "x",
      newText: "y",
    });
  });

  it("joins MultiEdit edits", () => {
    const p = approvalPreview({ file_path: "/r/a.ts", edits: [{ old_string: "1", new_string: "2" }, { old_string: "3", new_string: "4" }] });
    expect(p).toMatchObject({ type: "diff", oldText: "1\n…\n3", newText: "2\n…\n4" });
  });

  it("shows a Write as a whole new file", () => {
    expect(approvalPreview({ file_path: "/r/test_calc.py", content: "def test(): pass\n" })).toMatchObject({
      type: "diff",
      oldText: "",
      newText: "def test(): pass\n",
    });
  });

  it("shows shell commands", () => {
    expect(approvalPreview({ command: "python3 -m pytest -q", cwd: "/r" })).toEqual({
      type: "command",
      command: "python3 -m pytest -q",
      cwd: "/r",
      truncated: false,
    });
  });

  it("caps huge input and marks it truncated", () => {
    const p = approvalPreview({ command: "x".repeat(PREVIEW_MAX_CHARS + 10) });
    expect(p?.type === "command" && p.command.length).toBe(PREVIEW_MAX_CHARS);
    expect(p?.truncated).toBe(true);
  });

  it("leaves outbound bot drafts and unknown input alone", () => {
    expect(approvalPreview({ to: "a@b.c", content: "hi", channel: "email" })).toBeUndefined();
    expect(approvalPreview({ variant: "ExitPlanMode", plan: [] })).toBeUndefined();
    expect(approvalPreview(undefined)).toBeUndefined();
  });
});
