import { randomUUID } from "node:crypto";
import type { AgentProfile, DispatchSession, PendingApproval, SessionEvent, ToolCallRecord } from "../types.js";
import type { ChatMessage, FetchLike, ToolCall } from "./protocol.js";
import { pickProvider } from "./providers/index.js";
import { runBotLoop } from "./loop.js";
import { parseOutbound, toolsForAllowlist, type BotTool, type ToolContext } from "./tools/index.js";

const DEFAULT_PROMPT_MAX_MS = 6 * 60 * 60_000;

export interface BotHostCallbacks {
  persist(session: DispatchSession): void;
  emit(session: DispatchSession, type: SessionEvent["type"], payload: unknown): void;
  /**
   * Park an approval on the session and wait for phone resolveApproval.
   * Rejects if the run is cancelled/timed out.
   */
  requestApproval(session: DispatchSession, approval: PendingApproval): Promise<{
    decision: "approve" | "reject";
    comment?: string;
  }>;
  isCancelled(): boolean;
}

function botPreamble(): string {
  const today = new Date().toISOString().slice(0, 10);
  return `You are an autonomous ClankerSpanker bot. You run inside the host process with a small, owned tool set.

Today's UTC date is ${today}. Use that date on outbox files. Do not invent a different year.

Rules:
- You cannot send email or post to X. propose_outbound writes a draft to .bot-outbox/ for later review. Nothing is sent. Do not wait for approval.
- write_file is confined to .bot-outbox/ and auto-runs.
- There is no shell. Do not ask for one.
- Public HTTP only: no cookies, no logins, no private/loopback URLs.
- Never claim you emailed, posted, or contacted anyone.
- Keep drafts in the user's voice: short, peer-to-peer, no hype.
- Empty search results mean the search backend failed, NOT that the market is empty. Follow up with web_fetch on specific URLs.`;
}

export async function runBotSession(opts: {
  session: DispatchSession;
  profile: AgentProfile;
  prompt: string;
  isFollowUp: boolean;
  maxTurns?: number;
  promptMaxMs?: number;
  toolsAllowlist?: string[];
  autoApproveKinds: string[];
  fetchImpl?: FetchLike;
  /** Test seam — production callers omit this and pickProvider is used. */
  provider?: import("./protocol.js").ChatProvider;
  callbacks: BotHostCallbacks;
  signal: AbortSignal;
}): Promise<void> {
  const { session, profile, callbacks } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const tools = toolsForAllowlist(opts.toolsAllowlist);
  const provider = opts.provider ?? (await pickProvider(profile, fetchImpl));
  const maxTurns = opts.maxTurns ?? 20;
  const maxMs = opts.promptMaxMs && opts.promptMaxMs > 0 ? opts.promptMaxMs : DEFAULT_PROMPT_MAX_MS;

  const timeout = AbortSignal.timeout(maxMs);
  const signal = combineSignals(opts.signal, timeout);

  session.status = "running";
  session.updatedAt = iso();
  callbacks.persist(session);
  callbacks.emit(session, "session.updated", { status: "running", backend: "bot" });

  const messages = buildMessages(session, opts.prompt, opts.isFollowUp, profile.systemPrompt);
  const ctx: ToolContext = { cwd: session.cwd, sessionId: session.id, fetchImpl };

  const result = await runBotLoop({
    provider,
    tools: tools.map((t) => t.spec),
    messages,
    maxTurns,
    signal,
    onAssistant: (text, calls) => {
      if (text.trim()) {
        const entry = {
          id: randomUUID(),
          role: "assistant" as const,
          text,
          at: iso(),
        };
        session.transcript.push(entry);
        callbacks.emit(session, "transcript", entry);
        callbacks.persist(session);
      }
      for (const call of calls) {
        recordTool(session, call, "pending");
        callbacks.emit(session, "tool_call", session.toolCalls[session.toolCalls.length - 1]);
      }
      callbacks.persist(session);
    },
    executeTool: async (call) => executeOne(call, tools, ctx, session, opts.autoApproveKinds, callbacks, signal),
  });

  if (callbacks.isCancelled() || result.stopReason === "cancelled") {
    // cancel() may have already flipped the session; still persist a terminal snapshot.
    session.status = "cancelled";
    session.completedAt = session.completedAt ?? iso();
    session.updatedAt = iso();
    callbacks.persist(session);
    callbacks.emit(session, "session.completed", { status: "cancelled" });
    return;
  }

  if (result.stopReason === "timeout") {
    session.status = "failed";
    session.error = `Bot run hit wall-clock cap (${maxMs}ms)`;
    session.completedAt = iso();
    session.updatedAt = iso();
    callbacks.persist(session);
    callbacks.emit(session, "session.failed", { error: session.error });
    return;
  }

  session.stopReason = result.stopReason;
  session.status = "idle";
  session.updatedAt = iso();
  callbacks.persist(session);
  callbacks.emit(session, "session.updated", { status: "idle", backend: "bot", stopReason: result.stopReason });
}

async function executeOne(
  call: ToolCall,
  tools: BotTool[],
  ctx: ToolContext,
  session: DispatchSession,
  autoApproveKinds: string[],
  callbacks: BotHostCallbacks,
  signal: AbortSignal,
): Promise<string> {
  const tool = tools.find((t) => t.spec.name === call.name);
  if (!tool) {
    const msg = `Unknown tool: ${call.name}`;
    finishTool(session, call.id, "failed", callbacks);
    return msg;
  }

  let args: Record<string, unknown>;
  try {
    const parsed = JSON.parse(call.arguments || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("tool arguments must be a JSON object");
    }
    args = parsed as Record<string, unknown>;
  } catch (err) {
    const msg = `Malformed tool JSON for ${call.name}: ${err instanceof Error ? err.message : String(err)}`;
    finishTool(session, call.id, "failed", callbacks);
    return msg;
  }

  const needsGate = !tool.auto && (tool.alwaysApprove || !autoApproveKinds.includes(tool.kind));
  if (needsGate) {
    const approval = buildApproval(session, call, tool, args);
    session.pendingApprovalId = approval.id;
    session.pendingApproval = approval;
    session.status = "awaiting_approval";
    session.updatedAt = iso();
    callbacks.persist(session);
    callbacks.emit(session, "approval.needed", approval);

    let decision: { decision: "approve" | "reject"; comment?: string };
    try {
      decision = await callbacks.requestApproval(session, approval);
    } catch (err) {
      finishTool(session, call.id, "cancelled", callbacks);
      return `Approval interrupted: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (signal.aborted) {
      finishTool(session, call.id, "cancelled", callbacks);
      return "Run cancelled";
    }
    session.pendingApprovalId = undefined;
    session.pendingApproval = null;
    session.status = "running";
    session.updatedAt = iso();
    callbacks.persist(session);
    callbacks.emit(session, "approval.resolved", {
      approvalId: approval.id,
      decision: decision.decision,
      comment: decision.comment,
      backend: "bot",
    });
    if (decision.decision === "reject") {
      finishTool(session, call.id, "rejected", callbacks);
      return `User rejected ${call.name}${decision.comment ? `: ${decision.comment}` : ""}. Do not retry the same outbound.`;
    }
  }

  try {
    const result = await tool.execute(args, ctx);
    finishTool(session, call.id, "completed", callbacks);
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    finishTool(session, call.id, "failed", callbacks);
    return `Tool error (${call.name}): ${msg}`;
  }
}

function buildApproval(
  session: DispatchSession,
  call: ToolCall,
  tool: BotTool,
  args: Record<string, unknown>,
): PendingApproval {
  const title =
    tool.spec.name === "propose_outbound"
      ? outboundTitle(args)
      : `${tool.spec.name} ${typeof args.path === "string" ? args.path : ""}`.trim();
  return {
    id: randomUUID(),
    sessionId: session.id,
    toolCallId: call.id,
    title,
    kind: tool.kind,
    rawInput: args,
    options: [
      {
        optionId: "allow-once",
        name: tool.kind === "outbound" ? "Queue in outbox" : "Allow once",
        kind: "allow_once",
      },
      { optionId: "reject-once", name: "Skip", kind: "reject_once" },
    ],
    createdAt: iso(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
  };
}

function outboundTitle(args: Record<string, unknown>): string {
  try {
    const p = parseOutbound(args);
    return `Outbound ${p.channel} → ${p.to}`;
  } catch {
    return "Outbound draft";
  }
}

function recordTool(session: DispatchSession, call: ToolCall, status: string): void {
  const rec: ToolCallRecord = {
    toolCallId: call.id,
    title: call.name,
    kind: call.name === "propose_outbound" ? "outbound" : call.name === "write_file" ? "edit" : "other",
    status,
    rawInput: safeJson(call.arguments),
    updatedAt: iso(),
  };
  session.toolCalls.push(rec);
}

function finishTool(
  session: DispatchSession,
  id: string,
  status: string,
  callbacks: BotHostCallbacks,
): void {
  const rec = session.toolCalls.find((t) => t.toolCallId === id);
  if (rec) {
    rec.status = status;
    rec.updatedAt = iso();
  }
  callbacks.persist(session);
  callbacks.emit(session, "tool_call_update", { toolCallId: id, status });
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function buildMessages(
  session: DispatchSession,
  prompt: string,
  isFollowUp: boolean,
  persona?: string,
): ChatMessage[] {
  const system = [botPreamble(), persona?.trim()].filter(Boolean).join("\n\n");
  const messages: ChatMessage[] = [{ role: "system", content: system }];
  if (isFollowUp) {
    for (const t of session.transcript) {
      if (t.role === "user") messages.push({ role: "user", content: t.text });
      else if (t.role === "assistant") messages.push({ role: "assistant", content: t.text });
    }
    messages.push({ role: "user", content: prompt });
    return messages;
  }
  messages.push({ role: "user", content: prompt });
  return messages;
}

function iso(): string {
  return new Date().toISOString();
}

function combineSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (typeof AbortSignal.any === "function") return AbortSignal.any([a, b]);
  const c = new AbortController();
  const onAbort = () => c.abort(a.aborted ? a.reason : b.reason);
  a.addEventListener("abort", onAbort);
  b.addEventListener("abort", onAbort);
  if (a.aborted || b.aborted) c.abort(a.aborted ? a.reason : b.reason);
  return c.signal;
}
