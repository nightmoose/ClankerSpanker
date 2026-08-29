import { describe, expect, it } from "vitest";
import { buildAntigravityArgs } from "./runner.js";

describe("buildAntigravityArgs", () => {
  it("prepends systemPrompt on a fresh conversation", () => {
    const args = buildAntigravityArgs({
      prompt: "do the thing",
      skipPermissions: false,
      systemPrompt: "You are Gemini-on-this-profile.",
    });
    expect(args[0]).toBe("-p");
    expect(args[1]).toContain("[Profile instructions]");
    expect(args[1]).toContain("You are Gemini-on-this-profile.");
    expect(args[1]).toContain("do the thing");
    expect(args).not.toContain("--conversation");
  });

  it("does not restate systemPrompt when resuming --conversation", () => {
    const args = buildAntigravityArgs({
      prompt: "follow up",
      conversationId: "conv-1",
      skipPermissions: false,
      systemPrompt: "You are Gemini-on-this-profile.",
    });
    expect(args[1]).toBe("follow up");
    expect(args).toContain("--conversation");
    expect(args).toContain("conv-1");
  });

  it("omits --model for sentinel slugs and pins a real one", () => {
    const sentinel = buildAntigravityArgs({
      prompt: "hi",
      model: "gemini",
      skipPermissions: false,
    });
    expect(sentinel).not.toContain("--model");

    const pinned = buildAntigravityArgs({
      prompt: "hi",
      model: "gemini-2.5-flash",
      skipPermissions: true,
    });
    expect(pinned).toEqual(
      expect.arrayContaining(["--model", "gemini-2.5-flash", "--dangerously-skip-permissions"]),
    );
  });

  it("prepends an advisory tool allowlist on a fresh conversation", () => {
    const args = buildAntigravityArgs({
      prompt: "do the thing",
      skipPermissions: false,
      toolAllowlist: ["Read", "Grep"],
    });
    expect(args[1]).toContain("Read, Grep");
    expect(args[1]).toContain("do the thing");
  });
});
