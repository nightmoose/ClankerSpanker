import { describe, expect, it } from "vitest";
import {
  botTaggedTitle,
  claudeApprovalSignature,
  expiresInIso,
  grokApprovalSignature,
  isSafeBashCommand,
  matchesProfileAllowlist,
  shortTitle,
} from "./session-helpers.js";

// RFC-051: direct tests for helpers moved out of session-manager.ts.

describe("approval signatures", () => {
  it("scopes Claude signatures to the command / file", () => {
    expect(claudeApprovalSignature("Bash", { command: " ls -la " })).toBe("claude:bash:ls -la");
    expect(claudeApprovalSignature("Edit", { file_path: "/r/a.ts" })).toBe("claude:edit:/r/a.ts");
    expect(claudeApprovalSignature("WebFetch", {})).toBe("claude:webfetch");
  });

  it("scopes Grok signatures to kind + title", () => {
    expect(grokApprovalSignature("Edit", " Edit `/r/a.ts` ")).toBe("grok:edit:Edit `/r/a.ts`");
    expect(grokApprovalSignature(undefined, "x")).toBe("grok:other:x");
  });
});

describe("matchesProfileAllowlist (decides what runs without asking)", () => {
  it("matches exact entries only by default", () => {
    expect(matchesProfileAllowlist("claude:edit:/r/a.ts", ["claude:edit:/r/a.ts"])).toBe(true);
    expect(matchesProfileAllowlist("claude:edit:/r/b.ts", ["claude:edit:/r/a.ts"])).toBe(false);
  });

  it("supports /* path stems without matching siblings by prefix", () => {
    expect(matchesProfileAllowlist("claude:edit:/r/src/a.ts", ["claude:edit:/r/src/*"])).toBe(true);
    expect(matchesProfileAllowlist("claude:edit:/r/srcx/a.ts", ["claude:edit:/r/src/*"])).toBe(false);
  });

  it("treats a bare tool (one colon) as every argument of that tool", () => {
    expect(matchesProfileAllowlist("claude:bash:rm -rf /tmp/x", ["claude:bash"])).toBe(true);
    expect(matchesProfileAllowlist("claude:bashful:x", ["claude:bash"])).toBe(false);
  });

  it("ignores blank entries and an empty list", () => {
    expect(matchesProfileAllowlist("claude:bash:ls", ["", "  "])).toBe(false);
    expect(matchesProfileAllowlist("claude:bash:ls", [])).toBe(false);
  });
});

describe("isSafeBashCommand", () => {
  it("allows read-only commands and refuses writes", () => {
    expect(isSafeBashCommand("ls -la")).toBe(true);
    expect(isSafeBashCommand("git status")).toBe(true);
    expect(isSafeBashCommand("rm -rf /")).toBe(false);
    expect(isSafeBashCommand("git push")).toBe(false);
  });
});

describe("titles and times", () => {
  it("shortTitle prefers an explicit title and truncates long prompts", () => {
    expect(shortTitle("prompt", "  Explicit  ")).toBe("Explicit");
    expect(shortTitle("first line\nsecond")).toBe("first line");
    expect(shortTitle("x".repeat(100))).toHaveLength(70);
  });

  it("botTaggedTitle tags once", () => {
    expect(botTaggedTitle("Hunt")).toBe("<bot> Hunt");
    expect(botTaggedTitle("<bot> Hunt")).toBe("<bot> Hunt");
  });

  it("expiresInIso is in the future", () => {
    expect(Date.parse(expiresInIso(60_000))).toBeGreaterThan(Date.now());
  });
});
