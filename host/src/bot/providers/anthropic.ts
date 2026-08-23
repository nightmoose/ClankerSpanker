import type { ChatMessage, ChatProvider, ChatResponse, FetchLike, ToolCall, ToolSpec } from "../protocol.js";

export function createAnthropicProvider(opts: {
  apiKey?: string;
  accessToken?: string;
  userAgent?: string;
  model: string;
  fetchImpl?: FetchLike;
}): ChatProvider {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const model = opts.model.startsWith("claude") && opts.model !== "claude"
    ? opts.model
    : "claude-sonnet-4-6";
  const oauth = Boolean(opts.accessToken?.trim());
  const token = (opts.accessToken || opts.apiKey || "").trim();

  return {
    kind: "anthropic",
    async chat(messages, tools, signal): Promise<ChatResponse> {
      const { system, rest } = splitSystem(messages);
      const body = {
        model,
        max_tokens: 4096,
        system: system || undefined,
        messages: toAnthropicMessages(rest),
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters,
        })),
      };
      const headers: Record<string, string> = {
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      };
      if (oauth) {
        headers.Authorization = `Bearer ${token}`;
        headers["anthropic-beta"] = "oauth-2025-04-20";
        if (opts.userAgent) headers["User-Agent"] = opts.userAgent;
      } else {
        headers["x-api-key"] = token;
      }
      const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`Anthropic ${res.status}: ${text.slice(0, 500)}`);
      }
      let parsed: {
        content?: Array<{
          type?: string;
          text?: string;
          id?: string;
          name?: string;
          input?: unknown;
        }>;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      try {
        parsed = JSON.parse(text) as typeof parsed;
      } catch {
        throw new Error(`Anthropic returned non-JSON: ${text.slice(0, 200)}`);
      }
      const blocks = parsed.content ?? [];
      const textParts: string[] = [];
      const toolCalls: ToolCall[] = [];
      for (const b of blocks) {
        if (b.type === "text" && b.text) textParts.push(b.text);
        if (b.type === "tool_use") {
          toolCalls.push({
            id: b.id || `call_${toolCalls.length}`,
            name: b.name ?? "unknown",
            arguments: JSON.stringify(b.input ?? {}),
          });
        }
      }
      return {
        text: textParts.join("\n"),
        toolCalls,
        usage: {
          inputTokens: parsed.usage?.input_tokens ?? 0,
          outputTokens: parsed.usage?.output_tokens ?? 0,
        },
      };
    },
  };
}

function splitSystem(messages: ChatMessage[]): { system: string; rest: ChatMessage[] } {
  const sys = messages.filter((m) => m.role === "system").map((m) => m.content);
  const rest = messages.filter((m) => m.role !== "system");
  return { system: sys.join("\n\n"), rest };
}

function toAnthropicMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    if (m.role === "tool") {
      const prev = out[out.length - 1];
      const block = {
        type: "tool_result",
        tool_use_id: m.toolCallId,
        content: m.content,
      };
      if (prev && prev.role === "user" && Array.isArray(prev.content)) {
        (prev.content as unknown[]).push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
      continue;
    }
    if (m.role === "assistant") {
      const content: unknown[] = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls ?? []) {
        let input: unknown = {};
        try {
          input = JSON.parse(tc.arguments);
        } catch {
          input = { _raw: tc.arguments };
        }
        content.push({ type: "tool_use", id: tc.id, name: tc.name, input });
      }
      out.push({ role: "assistant", content });
      continue;
    }
    out.push({ role: m.role, content: m.content });
  }
  return out;
}
