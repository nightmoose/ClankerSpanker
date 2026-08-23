import { describe, expect, it } from "vitest";
import { runBotLoop } from "./loop.js";
import type { ChatMessage, ChatProvider, ChatResponse, ToolCall, ToolSpec } from "./protocol.js";

function fakeProvider(script: ChatResponse[]): ChatProvider {
  let i = 0;
  return {
    kind: "openai-compat",
    async chat(): Promise<ChatResponse> {
      const next = script[Math.min(i, script.length - 1)]!;
      i += 1;
      return next;
    },
  };
}

const tools: ToolSpec[] = [
  { name: "web_search", description: "search", parameters: { type: "object", properties: {} } },
];

describe("runBotLoop", () => {
  it("runs one tool then final text", async () => {
    const executed: string[] = [];
    const result = await runBotLoop({
      provider: fakeProvider([
        {
          text: "",
          toolCalls: [{ id: "c1", name: "web_search", arguments: '{"query":"kafka contracts"}' }],
        },
        { text: "Found two leads.", toolCalls: [] },
      ]),
      tools,
      messages: [{ role: "user", content: "hunt" }],
      maxTurns: 20,
      executeTool: async (call: ToolCall) => {
        executed.push(call.name);
        return "ok";
      },
    });
    expect(executed).toEqual(["web_search"]);
    expect(result.stopReason).toBe("end_turn");
    expect(result.turns).toBe(2);
    const last = result.messages.at(-1);
    expect(last?.role).toBe("assistant");
    expect(last?.content).toBe("Found two leads.");
  });

  it("stops at maxTurns", async () => {
    const alwaysTool: ChatResponse = {
      text: "",
      toolCalls: [{ id: "c", name: "web_search", arguments: "{}" }],
    };
    const result = await runBotLoop({
      provider: fakeProvider([alwaysTool]),
      tools,
      messages: [{ role: "user", content: "hunt" }],
      maxTurns: 2,
      executeTool: async () => "ok",
    });
    expect(result.stopReason).toBe("max_turns");
    expect(result.turns).toBe(2);
  });

  it("does not crash the host on malformed tool JSON — executor returns a string", async () => {
    const result = await runBotLoop({
      provider: fakeProvider([
        { text: "", toolCalls: [{ id: "c1", name: "web_search", arguments: "NOT JSON" }] },
        { text: "recovered", toolCalls: [] },
      ]),
      tools,
      messages: [{ role: "user", content: "hunt" }],
      maxTurns: 5,
      executeTool: async (call) => {
        try {
          JSON.parse(call.arguments);
          return "ok";
        } catch (err) {
          return `Malformed tool JSON: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });
    expect(result.stopReason).toBe("end_turn");
    const toolMsg = result.messages.find((m: ChatMessage) => m.role === "tool");
    expect(toolMsg?.content).toMatch(/Malformed tool JSON/);
  });
});
