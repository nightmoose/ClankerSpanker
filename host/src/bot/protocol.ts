/** Shared chat/tool protocol for the in-process bot loop. Providers map vendor APIs onto this. */

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Assistant tool calls (role=assistant). */
  toolCalls?: ToolCall[];
  /** Matching id when role=tool. */
  toolCallId?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string from the model. May be malformed. */
  arguments: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatResponse {
  text: string;
  toolCalls: ToolCall[];
  usage?: { inputTokens: number; outputTokens: number };
}

export interface ChatProvider {
  kind: "xai" | "openai-compat" | "anthropic" | "gemini";
  chat(
    messages: ChatMessage[],
    tools: ToolSpec[],
    signal?: AbortSignal,
  ): Promise<ChatResponse>;
}

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
