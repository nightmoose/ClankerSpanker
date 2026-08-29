import { describe, expect, it } from "vitest";
import { selectProviderKind, pickProvider, envFromProfile } from "./providers/index.js";
import { remapBotModel } from "./providers/openai-compat.js";

describe("selectProviderKind", () => {
  it("picks xai vs openai-compat vs anthropic from env", () => {
    expect(selectProviderKind({ XAI_API_KEY: "x" })).toBe("xai");
    expect(
      selectProviderKind({ OPENAI_API_KEY: "sk", OPENAI_BASE_URL: "http://localhost:11434/v1" }),
    ).toBe("openai-compat");
    expect(selectProviderKind({ ANTHROPIC_API_KEY: "sk-ant" })).toBe("anthropic");
    expect(selectProviderKind({ GEMINI_API_KEY: "g" })).toBe("gemini");
    expect(selectProviderKind({})).toBe("none");
  });

  it("lets a claude model slug win over XAI_API_KEY", () => {
    expect(selectProviderKind({ XAI_API_KEY: "x", ANTHROPIC_API_KEY: "a" }, "claude-sonnet-4-6")).toBe(
      "anthropic",
    );
  });

  it("does not fall through to Grok when the chip is Claude", () => {
    expect(selectProviderKind({ XAI_API_KEY: "x" }, "grok-4", "claude")).toBe("none");
    expect(selectProviderKind({ XAI_API_KEY: "x", ANTHROPIC_AUTH_TOKEN: "oauth" }, "claude", "claude")).toBe(
      "anthropic",
    );
  });

  it("does not fall through to Grok when the chip is Antigravity", () => {
    expect(selectProviderKind({ XAI_API_KEY: "x" }, "grok-4", "antigravity")).toBe("none");
    expect(selectProviderKind({ GEMINI_OAUTH_TOKEN: "ya29" }, "gemini-2.5-flash", "antigravity")).toBe(
      "gemini",
    );
  });

  it("prefers OPENAI_BASE_URL over XAI when both are set", () => {
    expect(
      selectProviderKind({
        XAI_API_KEY: "x",
        OPENAI_API_KEY: "sk",
        OPENAI_BASE_URL: "https://example/v1",
      }),
    ).toBe("openai-compat");
  });
});

describe("remapBotModel", () => {
  it("does not send grok-build to the HTTP chat API", () => {
    expect(remapBotModel("grok-build")).toBe("grok-4");
    expect(remapBotModel("grok-4")).toBe("grok-4");
  });
});

describe("envFromProfile", () => {
  it("merges profile.env and sets GROK_HOME from grokHome", () => {
    const env = envFromProfile({
      id: "b",
      name: "B",
      backend: "bot",
      color: "#fff",
      grokHome: "/tmp/nightmoose-2",
      env: { OPENAI_API_KEY: "sk-test", OPENAI_BASE_URL: "http://127.0.0.1:11434/v1" },
    });
    expect(env.GROK_HOME).toBe("/tmp/nightmoose-2");
    expect(env.OPENAI_API_KEY).toBe("sk-test");
    expect(env.OPENAI_BASE_URL).toBe("http://127.0.0.1:11434/v1");
  });
});

describe("pickProvider", () => {
  it("constructs an xai chat provider from an isolated env", async () => {
    const p = await pickProvider(
      {
        id: "b",
        name: "B",
        backend: "bot",
        color: "#fff",
        model: "grok-4",
        env: { XAI_API_KEY: "xai-test-key" },
      },
      async () => new Response("{}", { status: 200 }),
    );
    expect(p.kind).toBe("xai");
  });

  it("uses Claude OAuth Bearer instead of x-api-key", async () => {
    let headers: Headers | undefined;
    const p = await pickProvider(
      {
        id: "fullscore",
        name: "FullScore",
        backend: "claude",
        color: "#f90",
        model: "claude",
        env: { ANTHROPIC_AUTH_TOKEN: "oauth-token" },
      },
      async (_url, init) => {
        headers = new Headers(init?.headers);
        return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), {
          status: 200,
        });
      },
    );
    expect(p.kind).toBe("anthropic");
    await p.chat([], [], new AbortController().signal);
    expect(headers?.get("authorization")).toBe("Bearer oauth-token");
    expect(headers?.get("x-api-key")).toBeNull();
    expect(headers?.get("anthropic-beta")).toContain("oauth-2025-04-20");
  });

  it("uses Agy OAuth against Cloud Code, not a Studio API key", async () => {
    let url = "";
    let headers: Headers | undefined;
    const p = await pickProvider(
      {
        id: "agy",
        name: "Agy",
        backend: "antigravity",
        color: "#34A853",
        model: "antigravity",
        env: { GEMINI_OAUTH_TOKEN: "ya29.test" },
      },
      async (input, init) => {
        url = String(input);
        headers = new Headers(init?.headers);
        return new Response(JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "hi" }] } }] } }), {
          status: 200,
        });
      },
    );
    expect(p.kind).toBe("gemini");
    await p.chat([{ role: "user", content: "hi" }], [], new AbortController().signal);
    expect(url).toContain("cloudcode-pa.googleapis.com");
    expect(headers?.get("authorization")).toBe("Bearer ya29.test");
  });
});
