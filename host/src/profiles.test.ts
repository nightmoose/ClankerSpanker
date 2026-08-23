import { describe, expect, it } from "vitest";
import {
  defaultModelForBackend,
  isGrokBackend,
  normalizeBackend,
  normalizeProfiles,
  profileHasCredentials,
} from "./profiles.js";

describe("normalizeProfiles", () => {
  it("accepts antigravity backend and aliases", () => {
    const profiles = normalizeProfiles([
      { id: "a", name: "Agy", backend: "antigravity", color: "#34A853" },
      { id: "b", name: "Agy2", backend: "agy", color: "#00ff00" },
      { id: "c", name: "Gem", backend: "gemini", color: "#111111" },
    ]);
    expect(profiles).toHaveLength(3);
    expect(profiles.every((p) => p.backend === "antigravity")).toBe(true);
  });

  it("preserves claude and grok", () => {
    const profiles = normalizeProfiles([
      { id: "g", name: "Grok", backend: "grok", color: "#73B8FF" },
      { id: "c", name: "Claude", backend: "claude", color: "#F97316" },
    ]);
    expect(profiles.map((p) => p.backend)).toEqual(["grok", "claude"]);
  });

  it("defaults unknown backend to grok", () => {
    const profiles = normalizeProfiles([
      { id: "x", name: "X", backend: "nope" as "grok", color: "#fff" },
    ]);
    expect(profiles[0]!.backend).toBe("grok");
  });

  it("preserves bot backend (must not become grok)", () => {
    const profiles = normalizeProfiles([
      { id: "h", name: "Hunter", backend: "bot", color: "#E879F9" },
    ]);
    expect(profiles[0]!.backend).toBe("bot");
  });
});

describe("normalizeBackend", () => {
  it("keeps bot as bot and maps unknown to grok", () => {
    expect(normalizeBackend("bot")).toBe("bot");
    expect(normalizeBackend("BOT")).toBe("bot");
    expect(normalizeBackend("nope")).toBe("grok");
    expect(normalizeBackend(undefined)).toBe("grok");
    expect(normalizeBackend("claude")).toBe("claude");
  });
});

describe("defaultModelForBackend", () => {
  it("maps backends", () => {
    expect(defaultModelForBackend("grok")).toBe("grok-build");
    expect(defaultModelForBackend("claude")).toBe("claude");
    expect(defaultModelForBackend("antigravity")).toBe("antigravity");
    expect(defaultModelForBackend("bot")).toBe("grok-4");
  });
});

describe("isGrokBackend", () => {
  it("only grok (and empty) are ACP meta backends", () => {
    expect(isGrokBackend("grok")).toBe(true);
    expect(isGrokBackend(undefined)).toBe(true);
    expect(isGrokBackend("claude")).toBe(false);
    expect(isGrokBackend("antigravity")).toBe(false);
    expect(isGrokBackend("bot")).toBe(false);
  });
});

describe("profileHasCredentials antigravity", () => {
  it("returns true when GEMINI_API_KEY is set on profile env", () => {
    expect(
      profileHasCredentials({
        id: "a",
        name: "A",
        backend: "antigravity",
        color: "#34A853",
        env: { GEMINI_API_KEY: "test-key" },
      }),
    ).toBe(true);
  });
});

describe("profileHasCredentials bot", () => {
  it("accepts XAI_API_KEY on the profile and ignores grok CLI login", () => {
    expect(
      profileHasCredentials({
        id: "b",
        name: "Bot",
        backend: "bot",
        color: "#E879F9",
        env: { XAI_API_KEY: "xai-test" },
      }),
    ).toBe(true);
  });

  it("treats OPENAI_API_KEY+OPENAI_BASE_URL as credentials", () => {
    expect(
      profileHasCredentials({
        id: "b",
        name: "Bot",
        backend: "bot",
        color: "#E879F9",
        env: { OPENAI_API_KEY: "sk-test", OPENAI_BASE_URL: "http://127.0.0.1:11434/v1" },
      }),
    ).toBe(true);
  });

  it("accepts Grok CLI login (~/.grok/auth.json) as bot credentials", () => {
    expect(
      profileHasCredentials({
        id: "b",
        name: "Bot",
        backend: "bot",
        color: "#E879F9",
        env: {},
      }),
    ).toBe(true);
  });
});
