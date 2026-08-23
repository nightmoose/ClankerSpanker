import type { ChatMessage, ChatProvider, ToolCall, ToolSpec } from "./protocol.js";

export interface LoopResult {
  messages: ChatMessage[];
  stopReason: "end_turn" | "max_turns" | "cancelled" | "timeout";
  turns: number;
}

export interface RunLoopOptions {
  provider: ChatProvider;
  tools: ToolSpec[];
  messages: ChatMessage[];
  maxTurns: number;
  signal?: AbortSignal;
  /** Execute one tool call. Must never throw — return an error string instead. */
  executeTool: (call: ToolCall) => Promise<string>;
  onAssistant?: (text: string, toolCalls: ToolCall[]) => void;
}

/**
 * messages + tools until the model stops calling tools, hits maxTurns, or the
 * abort signal fires. Malformed tool JSON is the executor's problem (it should
 * return a tool-error string, not throw).
 */
export async function runBotLoop(opts: RunLoopOptions): Promise<LoopResult> {
  const messages = [...opts.messages];
  const maxTurns = Math.max(1, opts.maxTurns);
  let turns = 0;

  while (turns < maxTurns) {
    if (opts.signal?.aborted) {
      return { messages, stopReason: abortReason(opts.signal), turns };
    }
    turns += 1;
    let response;
    try {
      response = await opts.provider.chat(messages, opts.tools, opts.signal);
    } catch (err) {
      if (opts.signal?.aborted) {
        return { messages, stopReason: abortReason(opts.signal), turns };
      }
      throw err;
    }

    const assistant: ChatMessage = {
      role: "assistant",
      content: response.text ?? "",
      toolCalls: response.toolCalls.length ? response.toolCalls : undefined,
    };
    messages.push(assistant);
    opts.onAssistant?.(response.text ?? "", response.toolCalls);

    if (!response.toolCalls.length) {
      return { messages, stopReason: "end_turn", turns };
    }

    for (const call of response.toolCalls) {
      if (opts.signal?.aborted) {
        return { messages, stopReason: abortReason(opts.signal), turns };
      }
      let result: string;
      try {
        result = await opts.executeTool(call);
      } catch (err) {
        result = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
      }
      messages.push({
        role: "tool",
        name: call.name,
        toolCallId: call.id,
        content: result,
      });
    }
  }

  messages.push({
    role: "user",
    content: `[system] Stopped after ${maxTurns} tool turns (maxTurnsPerRun). Summarize what you have so far in one short note; do not call more tools.`,
  });
  try {
    if (!opts.signal?.aborted) {
      const last = await opts.provider.chat(messages, [], opts.signal);
      messages.push({ role: "assistant", content: last.text ?? "" });
      opts.onAssistant?.(last.text ?? "", []);
    }
  } catch {
    /* already at cap; ignore a failed wrap-up */
  }
  return { messages, stopReason: "max_turns", turns };
}

function abortReason(signal: AbortSignal): "cancelled" | "timeout" {
  const reason = (signal as AbortSignal & { reason?: unknown }).reason;
  if (reason === "timeout" || (reason instanceof Error && reason.name === "TimeoutError")) {
    return "timeout";
  }
  if (typeof reason === "string" && reason.includes("timeout")) return "timeout";
  return "cancelled";
}
