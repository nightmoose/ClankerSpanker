import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultModelForBackend,
  grokAgentModelArgs,
  isClaudeModelSentinel,
  isGrokBackend,
  isModelSentinel,
  isToolOnAllowlist,
  normalizeBackend,
  normalizeProfiles,
  profileHasCredentials,
  profileProcessEnv,
  splitProfileToolFields,
  wrapWithProfileSystemPrompt,
} from "./profiles.js";
import type { SessionBackend } from "./types.js";

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

  it("preserves named mcpServers", () => {
    const [p] = normalizeProfiles([
      {
        id: "g",
        name: "Grok",
        backend: "grok",
        color: "#73B8FF",
        mcpServers: [{ name: "databricks", command: "npx", args: ["-y", "databricks-mcp"] }],
      },
    ]);
    expect(p!.mcpServers).toEqual([
      { name: "databricks", command: "npx", args: ["-y", "databricks-mcp"], transport: "stdio" },
    ]);
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

  it("accepts Grok CLI login (GROK_HOME/auth.json) as bot credentials", () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-grok-home-"));
    writeFileSync(join(dir, "auth.json"), "{}");
    const prev = process.env.GROK_HOME;
    process.env.GROK_HOME = dir;
    try {
      expect(
        profileHasCredentials({
          id: "b",
          name: "Bot",
          backend: "bot",
          color: "#E879F9",
          env: {},
        }),
      ).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("profile grokHome isolation", () => {
  it("normalizeProfiles trims and preserves grokHome", () => {
    const [p] = normalizeProfiles([
      {
        id: "g",
        name: "Grok",
        backend: "grok",
        color: "#73B8FF",
        grokHome: "  /tmp/some/grok-home  ",
      },
    ]);
    expect(p!.grokHome).toBe("/tmp/some/grok-home");
  });

  it("profileProcessEnv exposes GROK_HOME when profile.grokHome is set", () => {
    const env = profileProcessEnv({
      id: "g",
      name: "Grok",
      backend: "grok",
      color: "#73B8FF",
      grokHome: "/tmp/nightmoose-grok",
    });
    expect(env.GROK_HOME).toBe("/tmp/nightmoose-grok");
  });

  it("profileProcessEnv leaves GROK_HOME untouched when profile.grokHome is unset", () => {
    const prev = process.env.GROK_HOME;
    delete process.env.GROK_HOME;
    try {
      const env = profileProcessEnv({
        id: "g",
        name: "Grok",
        backend: "grok",
        color: "#73B8FF",
      });
      expect(env.GROK_HOME).toBeUndefined();
    } finally {
      if (prev !== undefined) process.env.GROK_HOME = prev;
    }
  });

  it("profileHasCredentials(grok) accepts profile.grokHome/auth.json even without shared login", () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-profile-grok-home-"));
    writeFileSync(join(dir, "auth.json"), "{}");
    const prevGrokHome = process.env.GROK_HOME;
    const prevXai = process.env.XAI_API_KEY;
    // Point ambient GROK_HOME at an empty dir so the shared-login fallback fails.
    const emptyShared = mkdtempSync(join(tmpdir(), "cs-empty-shared-grok-"));
    process.env.GROK_HOME = emptyShared;
    delete process.env.XAI_API_KEY;
    try {
      expect(
        profileHasCredentials({
          id: "g",
          name: "Grok",
          backend: "grok",
          color: "#73B8FF",
          grokHome: dir,
        }),
      ).toBe(true);
    } finally {
      if (prevGrokHome === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = prevGrokHome;
      if (prevXai !== undefined) process.env.XAI_API_KEY = prevXai;
      rmSync(dir, { recursive: true, force: true });
      rmSync(emptyShared, { recursive: true, force: true });
    }
  });
});

describe("isModelSentinel", () => {
  it("covers sentinels for every backend", () => {
    const rows: Array<[SessionBackend, string, boolean]> = [
      ["claude", "claude", true],
      ["claude", "default", true],
      ["claude", "", true],
      ["claude", "  CLAUDE  ", true],
      ["claude", "claude-sonnet-4-6", false],
      ["antigravity", "antigravity", true],
      ["antigravity", "agy", true],
      ["antigravity", "gemini", true],
      ["antigravity", "default", true],
      ["antigravity", "", true],
      ["antigravity", "gemini-2.5-flash", false],
      ["grok", "grok", true],
      ["grok", "grok-build", true],
      ["grok", "default", true],
      ["grok", "", true],
      ["grok", "grok-4", false],
      ["bot", "grok-4", false],
      ["bot", "default", false],
    ];
    for (const [backend, model, expected] of rows) {
      expect({
        backend,
        model,
        sentinel: isModelSentinel(backend, model),
      }).toEqual({ backend, model, sentinel: expected });
    }
    expect(isClaudeModelSentinel("claude")).toBe(true);
    expect(isClaudeModelSentinel("claude-opus-4-7")).toBe(false);
  });
});

describe("grokAgentModelArgs", () => {
  it("omits --model for sentinels and pins real slugs", () => {
    expect(grokAgentModelArgs("grok-build")).toEqual([]);
    expect(grokAgentModelArgs("grok")).toEqual([]);
    expect(grokAgentModelArgs("default")).toEqual([]);
    expect(grokAgentModelArgs("")).toEqual([]);
    expect(grokAgentModelArgs(undefined)).toEqual([]);
    expect(grokAgentModelArgs("grok-4")).toEqual(["--model", "grok-4"]);
  });
});

describe("wrapWithProfileSystemPrompt", () => {
  it("prepends the persona on a fresh session only", () => {
    const out = wrapWithProfileSystemPrompt("do the thing", "You are NightMoose.", { fresh: true });
    expect(out).toContain("[Profile instructions]");
    expect(out).toContain("You are NightMoose.");
    expect(out).toContain("do the thing");
  });

  it("does not restate the persona on resume or follow-up", () => {
    expect(
      wrapWithProfileSystemPrompt("follow up", "You are NightMoose.", { fresh: false }),
    ).toBe("follow up");
  });

  it("is a no-op when systemPrompt is empty", () => {
    expect(wrapWithProfileSystemPrompt("hi", "  ", { fresh: true })).toBe("hi");
    expect(wrapWithProfileSystemPrompt("hi", undefined, { fresh: true })).toBe("hi");
  });
});

describe("splitProfileToolFields", () => {
  it("migrates signature-shaped toolAllowlist entries to autoApprovalSignatures", () => {
    const split = splitProfileToolFields({
      toolAllowlist: ["claude:bash:git status", "Read", "Grep", "claude:read"],
    });
    expect(split.toolAllowlist).toEqual(["Read", "Grep"]);
    expect(split.autoApprovalSignatures).toEqual(["claude:bash:git status", "claude:read"]);
  });

  it("keeps explicit autoApprovalSignatures and still strips signatures from toolAllowlist", () => {
    const split = splitProfileToolFields({
      toolAllowlist: ["Write", "claude:write"],
      autoApprovalSignatures: ["claude:bash"],
    });
    expect(split.toolAllowlist).toEqual(["Write"]);
    expect(split.autoApprovalSignatures).toEqual(["claude:bash", "claude:write"]);
  });
});

describe("isToolOnAllowlist", () => {
  it("treats an empty list as unrestricted", () => {
    expect(isToolOnAllowlist(undefined, "Write")).toBe(true);
    expect(isToolOnAllowlist([], "Write")).toBe(true);
  });

  it("matches bare tool names case-insensitively", () => {
    expect(isToolOnAllowlist(["Read", "Grep"], "read")).toBe(true);
    expect(isToolOnAllowlist(["Read", "Grep"], "Write")).toBe(false);
  });
});
