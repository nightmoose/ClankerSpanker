import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APPROVAL_HOOK_SOURCE,
  buildClaudeHookSettings,
  buildPreToolUseDecision,
  claudeToolRestrictArgs,
  extraDirsForClaude,
} from "./runner.js";

describe("buildPreToolUseDecision", () => {
  it("emits Claude Code PreToolUse hookSpecificOutput shape", () => {
    expect(buildPreToolUseDecision("allow", "approved on phone")).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "approved on phone",
      },
    });
  });

  it("supports deny with a reason for the model", () => {
    const body = buildPreToolUseDecision("deny", "rejected on phone");
    expect(body.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(body.hookSpecificOutput.permissionDecisionReason).toBe("rejected on phone");
  });
});

describe("APPROVAL_HOOK_SOURCE", () => {
  it("does not use the flat decision/reason format Claude Code discards", () => {
    // Flat { decision, reason } is silently ignored (claude-code#48760).
    // Reject the old literals so a regression can't reintroduce them.
    expect(APPROVAL_HOOK_SOURCE).not.toMatch(/out\(\{\s*decision:/);
    expect(APPROVAL_HOOK_SOURCE).not.toMatch(/\{\s*decision:\s*"allow"/);
    expect(APPROVAL_HOOK_SOURCE).not.toMatch(/\{\s*decision:\s*"deny"/);
  });

  it("emits hookSpecificOutput.permissionDecision that Claude Code honors", () => {
    expect(APPROVAL_HOOK_SOURCE).toContain("hookSpecificOutput");
    expect(APPROVAL_HOOK_SOURCE).toContain('hookEventName: "PreToolUse"');
    expect(APPROVAL_HOOK_SOURCE).toContain("permissionDecision");
    expect(APPROVAL_HOOK_SOURCE).toContain("permissionDecisionReason");
    expect(APPROVAL_HOOK_SOURCE).toContain('decide("allow"');
    expect(APPROVAL_HOOK_SOURCE).toContain('decide("deny"');
  });

  it("exits 0 after JSON decisions so the payload is parsed (not exit-2 stderr path)", () => {
    // Exit 2 feeds stderr as a blocking error and can skip structured JSON.
    // All decision paths should process.exit(0) after decide(...).
    const decideThenExit = APPROVAL_HOOK_SOURCE.match(
      /decide\([^)]+\);\s*process\.exit\((\d+)\)/g,
    );
    expect(decideThenExit?.length).toBeGreaterThanOrEqual(4);
    for (const line of decideThenExit ?? []) {
      expect(line).toMatch(/process\.exit\(0\)/);
    }
  });
});

describe("buildClaudeHookSettings extra dirs", () => {
  it("grants Read + additionalDirectories so screenshot attachments are not sandboxed", () => {
    const dir = "/tmp/cs-attachments";
    const settings = buildClaudeHookSettings("/hooks/pretool.mjs", [dir]);
    const perms = settings.permissions as {
      additionalDirectories: string[];
      allow: string[];
    };
    expect(perms.additionalDirectories).toEqual([dir]);
    expect(perms.allow).toEqual([`Read(${dir}/**)`]);
  });

  it("omits permissions when there are no extra dirs", () => {
    const settings = buildClaudeHookSettings("/hooks/pretool.mjs");
    expect(settings.permissions).toBeUndefined();
  });
});

describe("claudeToolRestrictArgs", () => {
  it("passes --tools when a pre-flight allowlist is set", () => {
    expect(claudeToolRestrictArgs(["Read", "Grep"])).toEqual(["--tools", "Read,Grep"]);
    expect(claudeToolRestrictArgs([])).toEqual([]);
    expect(claudeToolRestrictArgs(undefined)).toEqual([]);
  });
});

describe("extraDirsForClaude", () => {
  it("drops missing paths and dedupes", () => {
    const real = mkdtempSync(join(tmpdir(), "cs-extra-"));
    mkdirSync(real, { recursive: true });
    expect(extraDirsForClaude([real, real, "/no/such/dir-xyz", ""])).toEqual([real]);
  });
});
