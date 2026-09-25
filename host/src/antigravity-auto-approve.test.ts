import { describe, expect, it } from "vitest";
import { antigravityAutoApproves, publicProfiles } from "./profiles.js";
import type { HostConfigFile } from "./types.js";

describe("antigravityAutoApproves (RFC-030)", () => {
  it("defaults to auto-approve", () => {
    expect(antigravityAutoApproves({})).toBe(true);
  });
  it("opts out with ANTIGRAVITY_REQUIRE_PERMISSIONS=1/true", () => {
    expect(antigravityAutoApproves({ ANTIGRAVITY_REQUIRE_PERMISSIONS: "1" })).toBe(false);
    expect(antigravityAutoApproves({ ANTIGRAVITY_REQUIRE_PERMISSIONS: " TRUE " })).toBe(false);
    expect(antigravityAutoApproves({ ANTIGRAVITY_REQUIRE_PERMISSIONS: "0" })).toBe(true);
  });
});

describe("publicProfiles autoApprovesTools", () => {
  it("is true only for auto-approving Antigravity profiles, and leaks no env", () => {
    const config = {
      profiles: [
        { id: "g", name: "Gemini", backend: "antigravity", color: "#0f0", env: { GEMINI_API_KEY: "secret" } },
        { id: "g2", name: "Gemini safe", backend: "antigravity", color: "#0f0", env: { ANTIGRAVITY_REQUIRE_PERMISSIONS: "1" } },
        { id: "c", name: "Claude", backend: "claude", color: "#00f" },
        { id: "x", name: "Grok", backend: "grok", color: "#fff" },
      ],
    } as unknown as HostConfigFile;
    const out = publicProfiles(config);
    expect(out.map((p) => p.autoApprovesTools)).toEqual([true, false, false, false]);
    expect(JSON.stringify(out)).not.toContain("secret");
  });
});
