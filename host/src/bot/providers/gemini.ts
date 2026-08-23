import type { ChatMessage, ChatProvider, ChatResponse, FetchLike, ToolCall, ToolSpec } from "../protocol.js";

const CLOUD_CODE = "https://cloudcode-pa.googleapis.com/v1internal";

type GeminiParsed = {
  response?: GeminiParsed;
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        functionCall?: { name?: string; args?: unknown };
      }>;
    };
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
};

export function createGeminiProvider(opts: {
  apiKey?: string;
  accessToken?: string;
  model: string;
  fetchImpl?: FetchLike;
}): ChatProvider {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const rawModel = (opts.model || "").trim();
  const model =
    rawModel.startsWith("gemini") || rawModel.startsWith("models/")
      ? rawModel.replace(/^models\//, "")
      : "gemini-2.5-flash";
  const oauth = Boolean(opts.accessToken?.trim());
  let cachedProject: string | undefined;

  return {
    kind: "gemini",
    async chat(messages, tools, signal): Promise<ChatResponse> {
      if (oauth) {
        return cloudCodeChat(fetchImpl, opts.accessToken!.trim(), model, messages, tools, signal ?? new AbortController().signal, {
          getProject: () => cachedProject,
          setProject: (p) => {
            cachedProject = p;
          },
        });
      }
      const key = (opts.apiKey || "").trim();
      const url =
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent` +
        `?key=${encodeURIComponent(key)}`;
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(geminiBody(messages, tools)),
        signal,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`Gemini ${res.status}: ${text.slice(0, 500)}`);
      return parseGeminiResponse(text);
    },
  };
}

function geminiBody(messages: ChatMessage[], tools: ToolSpec[]): Record<string, unknown> {
  return {
    contents: toGeminiContents(messages),
    tools: tools.length
      ? [
          {
            functionDeclarations: tools.map((t) => ({
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            })),
          },
        ]
      : undefined,
  };
}

async function cloudCodeChat(
  fetchImpl: FetchLike,
  accessToken: string,
  model: string,
  messages: ChatMessage[],
  tools: ToolSpec[],
  signal: AbortSignal,
  project: { getProject: () => string | undefined; setProject: (p: string) => void },
): Promise<ChatResponse> {
  const vertex = geminiBody(messages, tools);
  const payload: Record<string, unknown> = {
    model,
    project: project.getProject(),
    request: vertex,
  };
  let res = await fetchImpl(`${CLOUD_CODE}:generateContent`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal,
  });
  let text = await res.text();
  if (!res.ok && !project.getProject()) {
    const loaded = await loadCodeAssistProject(fetchImpl, accessToken, signal);
    if (loaded) {
      project.setProject(loaded);
      payload.project = loaded;
      res = await fetchImpl(`${CLOUD_CODE}:generateContent`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal,
      });
      text = await res.text();
    }
  }
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${text.slice(0, 500)}`);
  return parseGeminiResponse(text);
}

async function loadCodeAssistProject(
  fetchImpl: FetchLike,
  accessToken: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    const res = await fetchImpl(`${CLOUD_CODE}:loadCodeAssist`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        metadata: {
          ideType: "ANTIGRAVITY",
          platform: "PLATFORM_UNSPECIFIED",
          pluginType: "GEMINI",
        },
      }),
      signal,
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as {
      cloudaicompanionProject?: string;
      currentTier?: { id?: string };
    };
    return data.cloudaicompanionProject?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function parseGeminiResponse(text: string): ChatResponse {
  let parsed: GeminiParsed;
  try {
    parsed = JSON.parse(text) as GeminiParsed;
  } catch {
    throw new Error(`Gemini returned non-JSON: ${text.slice(0, 200)}`);
  }
  const inner = parsed.response ?? parsed;
  const parts = inner.candidates?.[0]?.content?.parts ?? [];
  const textParts: string[] = [];
  const toolCalls: ToolCall[] = [];
  for (const p of parts) {
    if (p.text) textParts.push(p.text);
    if (p.functionCall?.name) {
      toolCalls.push({
        id: `call_${toolCalls.length}`,
        name: p.functionCall.name,
        arguments: JSON.stringify(p.functionCall.args ?? {}),
      });
    }
  }
  return {
    text: textParts.join("\n"),
    toolCalls,
    usage: {
      inputTokens: inner.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: inner.usageMetadata?.candidatesTokenCount ?? 0,
    },
  };
}

function toGeminiContents(messages: ChatMessage[]): Array<Record<string, unknown>> {
  const contents: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    if (m.role === "system") {
      contents.push({ role: "user", parts: [{ text: `[system]\n${m.content}` }] });
      continue;
    }
    if (m.role === "tool") {
      contents.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name: m.name ?? "tool",
              response: { result: m.content },
            },
          },
        ],
      });
      continue;
    }
    if (m.role === "assistant") {
      const parts: unknown[] = [];
      if (m.content) parts.push({ text: m.content });
      for (const tc of m.toolCalls ?? []) {
        let args: unknown = {};
        try {
          args = JSON.parse(tc.arguments);
        } catch {
          args = { _raw: tc.arguments };
        }
        parts.push({ functionCall: { name: tc.name, args } });
      }
      contents.push({ role: "model", parts });
      continue;
    }
    contents.push({ role: "user", parts: [{ text: m.content }] });
  }
  return contents;
}
