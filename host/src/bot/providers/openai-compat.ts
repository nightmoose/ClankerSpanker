import type { ChatMessage, ChatProvider, ChatResponse, FetchLike, ToolCall, ToolSpec } from "../protocol.js";

export function createOpenAICompatProvider(opts: {
  apiKey: string;
  baseUrl: string;
  model: string;
  kind?: "xai" | "openai-compat";
  fetchImpl?: FetchLike;
}): ChatProvider {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, "");
  const kind = opts.kind ?? (base.includes("api.x.ai") ? "xai" : "openai-compat");

  return {
    kind,
    async chat(messages, tools, signal): Promise<ChatResponse> {
      const url = `${base}/chat/completions`;
      const body = {
        model: remapBotModel(opts.model),
        messages: messages.map(toOpenAIMessage),
        tools: tools.map((t) => ({
          type: "function",
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          },
        })),
        tool_choice: tools.length ? "auto" : undefined,
      };
      const res = await fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`OpenAI-compat ${res.status}: ${text.slice(0, 500)}`);
      }
      let parsed: {
        choices?: Array<{
          message?: {
            content?: string | null;
            tool_calls?: Array<{
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      try {
        parsed = JSON.parse(text) as typeof parsed;
      } catch {
        throw new Error(`OpenAI-compat returned non-JSON: ${text.slice(0, 200)}`);
      }
      const msg = parsed.choices?.[0]?.message ?? {};
      const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((tc, i) => ({
        id: tc.id || `call_${i}`,
        name: tc.function?.name ?? "unknown",
        arguments: tc.function?.arguments ?? "{}",
      }));
      return {
        text: msg.content ?? "",
        toolCalls,
        usage: {
          inputTokens: parsed.usage?.prompt_tokens ?? 0,
          outputTokens: parsed.usage?.completion_tokens ?? 0,
        },
      };
    },
  };
}

/** grok-build is ACP-only; the HTTP chat API needs a real chat slug. */
export function remapBotModel(model: string): string {
  const m = model.trim();
  if (!m || m === "grok-build" || m === "default") return "grok-4";
  return m;
}

function toOpenAIMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === "tool") {
    return {
      role: "tool",
      tool_call_id: m.toolCallId,
      content: m.content,
      name: m.name,
    };
  }
  if (m.role === "assistant" && m.toolCalls?.length) {
    return {
      role: "assistant",
      content: m.content || null,
      tool_calls: m.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.arguments },
      })),
    };
  }
  return { role: m.role, content: m.content };
}
