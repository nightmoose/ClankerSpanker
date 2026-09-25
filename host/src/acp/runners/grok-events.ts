import { randomUUID } from "node:crypto";
import type { AgentQuestion, PendingApproval, PendingQuestion, PlanEntry, ToolCallRecord, TranscriptEntry } from "../../types.js";
import { approvalPreview } from "../../approval-preview.js";
import { allowlistAllowsTool } from "../../profiles.js";
import { toolOutputSummary } from "../../tool-output.js";
import { questionAcceptedResult } from "../grok-ext.js";
import {
  DEFAULT_APPROVAL_TTL_MS,
  drainPendingQuestionsByToolCall,
  expiresInIso,
  grokApprovalSignature,
  matchesProfileAllowlist,
  now,
} from "../session-helpers.js";
import type { LiveSession } from "../session-helpers.js";
import { extractQuestionsFromUnknown, normalizeAcpMethod, normalizeQuestions } from "../session-support.js";
import type { TurnContext } from "./context.js";

/**
 * Grok ACP inbound traffic (RFC-055): `session/update` streaming, permission
 * requests, `x.ai/ask_user_question`, `x.ai/exit_plan_mode`. Moved verbatim
 * from SessionManager; state lives on the LiveSession, side effects go
 * through the TurnContext.
 */

export async function handleGrokAgentMessage(
  ctx: TurnContext,
  live: LiveSession,
  msg: { id?: number | string; method: string; params?: unknown },
): Promise<void> {
  const { session } = live;
  // Grok sometimes prefixes extension methods with a leading underscore.
  const method = normalizeAcpMethod(msg.method);

  if (method === "session/update") {
    const params = msg.params as {
      sessionId?: string;
      update?: Record<string, unknown>;
    };
    const update = params.update ?? {};
    const kind = String(update.sessionUpdate ?? "");

    switch (kind) {
      case "agent_message_chunk": {
        const content = update.content as { text?: string } | undefined;
        const chunk = content?.text ?? "";
        live.assistantBuffer += chunk;
        ctx.emitEvent(session, "transcript", {
          role: "assistant",
          text: chunk,
          streaming: true,
        });
        break;
      }
      case "agent_thought_chunk": {
        const content = update.content as { text?: string } | undefined;
        const chunk = content?.text ?? "";
        live.thoughtBuffer += chunk;
        ctx.emitEvent(session, "thought", { text: chunk });
        break;
      }
      case "tool_call": {
        flushAssistant(ctx, live);
        const record: ToolCallRecord = {
          toolCallId: String(update.toolCallId ?? randomUUID()),
          title: String(update.title ?? "Tool"),
          kind: update.kind as string | undefined,
          status: String(update.status ?? "pending"),
          rawInput: update.rawInput,
          locations: update.locations as ToolCallRecord["locations"],
          content: update.content,
          ...toolOutputSummary(update.content, update.rawOutput),
          updatedAt: now(),
        };
        const idx = session.toolCalls.findIndex((t) => t.toolCallId === record.toolCallId);
        if (idx >= 0) session.toolCalls[idx] = record;
        else session.toolCalls.push(record);
        session.updatedAt = now();
        ctx.persist(session);
        ctx.emitEvent(session, "tool_call", record);
        // Surface questionnaires even if the extension method arrives late/missing
        maybeParkAskUserQuestionFromTool(ctx, live, record);
        break;
      }
      case "tool_call_update": {
        const toolCallId = String(update.toolCallId ?? "");
        const existing = session.toolCalls.find((t) => t.toolCallId === toolCallId);
        if (existing) {
          if (update.status) existing.status = String(update.status);
          if (update.content) existing.content = update.content;
          if (update.rawInput) existing.rawInput = update.rawInput;
          if (update.locations) existing.locations = update.locations as ToolCallRecord["locations"];
          if (update.title) existing.title = String(update.title);
          if (update.kind) existing.kind = String(update.kind);
          // RFC-040: keep a short tail of command output + exit code.
          if (update.content || update.rawOutput) {
            const summary = toolOutputSummary(existing.content, update.rawOutput);
            if (summary.outputPreview !== undefined) existing.outputPreview = summary.outputPreview;
            if (summary.exitCode !== undefined) existing.exitCode = summary.exitCode;
          }
          existing.updatedAt = now();
        }
        session.updatedAt = now();
        ctx.persist(session);
        ctx.emitEvent(session, "tool_call_update", update);

        if (existing) maybeParkAskUserQuestionFromTool(ctx, live, existing);

        // Surface diffs embedded in tool content
        const content = update.content as Array<{ type?: string; path?: string; oldText?: string; newText?: string }> | undefined;
        if (Array.isArray(content)) {
          for (const c of content) {
            if (c.type === "diff") {
              ctx.emitEvent(session, "diff", c);
            }
          }
        }
        break;
      }
      case "plan": {
        const entries = (update.entries as PlanEntry[]) ?? [];
        session.plan = entries;
        session.updatedAt = now();
        ctx.persist(session);
        ctx.emitEvent(session, "plan", { entries });
        break;
      }
      case "usage_update": {
        ctx.emitEvent(session, "usage", update);
        break;
      }
      default:
        ctx.emitEvent(session, "session.updated", update);
    }
    return;
  }

  if (method === "session/request_permission") {
    await handlePermissionRequest(ctx, live, msg.id!, msg.params);
    return;
  }

  // Grok extension: interactive questionnaire (the thing that was leaving sessions stuck)
  // Accept both x.ai/… and _x.ai/… (agent has used both).
  if (method === "x.ai/ask_user_question" && msg.id !== undefined) {
    handleAskUserQuestionRequest(ctx, live, msg.id, msg.params);
    return;
  }

  // Plan approval surface — park on phone when possible; auto-accept if no UI path.
  if (method === "x.ai/exit_plan_mode" && msg.id !== undefined) {
    await handleExitPlanMode(ctx, live, msg.id, msg.params);
    return;
  }

  // Client-side fs methods if agent asks — deny writes, allow nothing for MVP safety
  if (method === "fs/read_text_file" && msg.id !== undefined) {
    live.client.respondError(msg.id, -32000, "fs/read_text_file not implemented by host; use agent tools");
    return;
  }
  if (method === "fs/write_text_file" && msg.id !== undefined) {
    live.client.respondError(msg.id, -32000, "Client-side writes disabled");
    return;
  }

  // Don't leave the agent hung on unknown inbound requests
  if (msg.id !== undefined && method) {
    console.warn(`[acp] unhandled request method=${msg.method} (normalized=${method}) id=${msg.id}`);
    live.client.respondError(msg.id, -32601, `Method not supported by ClankerSpanker host: ${method}`);
  }
}

/**
 * Agent wants to leave plan mode. Prefer phone approve/reject when we can
 * surface it; otherwise accept so long jobs are not stuck forever.
 */
async function handleExitPlanMode(
  ctx: TurnContext,
  live: LiveSession,
  rpcId: number | string,
  params: unknown,
): Promise<void> {
  const p = (params ?? {}) as {
    title?: string;
    plan?: unknown;
    options?: Array<{ optionId: string; name: string; kind: string }>;
  };

  console.log(
    `[acp] exit_plan_mode request session=${live.session.id.slice(0, 8)} rpcId=${rpcId} keys=${Object.keys(p).join(",")}`,
  );

  // If the agent already sent a structured plan, keep it on the session.
  if (Array.isArray(p.plan)) {
    live.session.plan = p.plan as PlanEntry[];
  }

  const options = p.options?.length
    ? p.options
    : [
        { optionId: "accept", name: "Approve plan & implement", kind: "allow_once" },
        { optionId: "reject", name: "Keep planning", kind: "reject_once" },
      ];

  const approvalId = randomUUID();
  const approval: PendingApproval & { rpcId: number | string; source?: "grok" | "claude" } = {
    id: approvalId,
    sessionId: live.session.id,
    title: p.title ?? "Approve plan to implement",
    kind: "other",
    rawInput: { variant: "ExitPlanMode", plan: p.plan ?? live.session.plan },
    options,
    createdAt: now(),
    expiresAt: expiresInIso(DEFAULT_APPROVAL_TTL_MS),
    rpcId,
    source: "grok",
  };

  live.pendingApprovals.set(approvalId, approval);
  live.session.pendingApprovalId = approvalId;
  const { rpcId: _rExit, source: _sExit, ...publicApproval } = approval;
  live.session.pendingApproval = publicApproval;
  live.session.status = "awaiting_approval";
  live.session.updatedAt = now();
  ctx.persist(live.session);

  ctx.emitEvent(live.session, "approval.needed", publicApproval);
  ctx.emitEvent(live.session, "session.updated", {
    status: "awaiting_approval",
    planExit: true,
    planMode: live.session.planMode,
  });
  ctx.maybeNotify("Plan ready for approval", live.session.title);
}

function handleAskUserQuestionRequest(
  ctx: TurnContext,
  live: LiveSession,
  rpcId: number | string,
  params: unknown,
): void {
  const p = (params ?? {}) as {
    questions?: AgentQuestion[];
    toolCallId?: string;
    title?: string;
  };
  const questions = normalizeQuestions(p.questions ?? extractQuestionsFromUnknown(params));
  if (questions.length === 0) {
    // Nothing to ask — accept empty so the agent unblocks
    live.client.respond(rpcId, questionAcceptedResult({}));
    return;
  }

  // The real extension RPC supersedes any soft-parked questionnaire we
  // surfaced from the tool stream / permission payload.
  for (const [existingId, q] of live.pendingQuestions) {
    if (q.rpcId === undefined) live.pendingQuestions.delete(existingId);
  }

  const id = randomUUID();
  const pending: PendingQuestion & { rpcId?: number | string } = {
    id,
    sessionId: live.session.id,
    toolCallId: p.toolCallId,
    title: p.title ?? `Answer ${questions.length} question${questions.length === 1 ? "" : "s"}`,
    questions,
    createdAt: now(),
    expiresAt: expiresInIso(DEFAULT_APPROVAL_TTL_MS),
    rpcId,
    canRespondViaAcp: true,
  };
  live.pendingQuestions.set(id, pending);
  live.session.pendingQuestionId = id;
  const { rpcId: _r, ...publicQ } = pending;
  live.session.pendingQuestion = publicQ;
  live.session.status = "awaiting_question";
  live.session.updatedAt = now();
  ctx.persist(live.session);
  ctx.emitEvent(live.session, "question.needed", publicQ);
  ctx.emitEvent(live.session, "session.updated", { status: "awaiting_question" });
  ctx.maybeNotify("Grok needs your input", live.session.title);
}

/** When tool stream shows AskUserQuestion but extension method was missed/lost. */
function maybeParkAskUserQuestionFromTool(ctx: TurnContext, live: LiveSession, record: ToolCallRecord): void {
  const ri = record.rawInput as { variant?: string; questions?: unknown } | undefined;
  if (!ri || ri.variant !== "AskUserQuestion") return;
  if (record.status === "completed" || record.status === "failed") {
    // Clear soft pending if tool finished. Drain matching entries from
    // `live.pendingQuestions` too — leaving them behind used to keep
    // the end-of-turn block from flipping to idle (RFC-019).
    if (live.session.pendingQuestion?.toolCallId === record.toolCallId) {
      live.session.pendingQuestionId = undefined;
      live.session.pendingQuestion = null;
      if (live.session.status === "awaiting_question") live.session.status = "running";
      ctx.persist(live.session);
    }
    drainPendingQuestionsByToolCall(live.pendingQuestions, record.toolCallId);
    return;
  }
  const questions = normalizeQuestions(ri.questions);
  if (questions.length === 0) return;
  parkSoftQuestions(ctx, live, questions, record.toolCallId, record.title);
}

/**
 * Show a questionnaire in the UI before the `x.ai/ask_user_question` RPC
 * arrives. No rpcId — answering goes through the soft follow-up path unless
 * the real extension request replaces this first.
 */
function parkSoftQuestions(
  ctx: TurnContext,
  live: LiveSession,
  questions: AgentQuestion[],
  toolCallId?: string,
  title?: string,
): void {
  if (questions.length === 0) return;
  for (const q of live.pendingQuestions.values()) {
    if (q.rpcId !== undefined) return;
  }
  if (toolCallId && live.session.pendingQuestion?.toolCallId === toolCallId) return;

  const id = randomUUID();
  const pending: PendingQuestion & { rpcId?: number | string } = {
    id,
    sessionId: live.session.id,
    toolCallId,
    title: title || `Answer ${questions.length} question${questions.length === 1 ? "" : "s"}`,
    questions,
    createdAt: now(),
    expiresAt: expiresInIso(DEFAULT_APPROVAL_TTL_MS),
    canRespondViaAcp: false,
  };
  live.pendingQuestions.set(id, pending);
  live.session.pendingQuestionId = id;
  live.session.pendingQuestion = pending;
  live.session.status = "awaiting_question";
  live.session.updatedAt = now();
  ctx.persist(live.session);
  ctx.emitEvent(live.session, "question.needed", pending);
  ctx.emitEvent(live.session, "session.updated", { status: "awaiting_question" });
  ctx.maybeNotify("Grok needs your input", live.session.title);
}

async function handlePermissionRequest(
  ctx: TurnContext,
  live: LiveSession,
  rpcId: number | string,
  params: unknown,
): Promise<void> {
  const p = params as {
    sessionId?: string;
    toolCall?: {
      toolCallId?: string;
      title?: string;
      kind?: string;
      rawInput?: unknown;
      locations?: Array<{ path: string; line?: number }>;
    };
    options?: Array<{ optionId: string; name: string; kind: string }>;
  };

  const toolCall = p.toolCall ?? {};
  const kind = (toolCall.kind ?? "other").toLowerCase();
  const options = p.options ?? [
    { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
    { optionId: "reject-once", name: "Reject", kind: "reject_once" },
  ];

  // Never answer AskUserQuestion as a permission. Grok auto-permits the
  // *tool*, then issues `x.ai/ask_user_question` with the respondable id.
  // Treating this RPC as the questionnaire and later replying with
  // `{ outcome: "accepted", answers }` against a permission request fails
  // the turn ("Client returned an invalid response to user question").
  const raw = toolCall as { rawInput?: { variant?: string } };
  if (raw.rawInput?.variant === "AskUserQuestion" || /ask .*question/i.test(toolCall.title ?? "")) {
    const allow = options.find((o) => o.kind === "allow_once") ?? options[0];
    if (allow) {
      live.client.respond(rpcId, {
        outcome: { outcome: "selected", optionId: allow.optionId },
      });
    }
    const maybeQs = extractQuestionsFromUnknown(toolCall);
    if (maybeQs.length > 0) {
      parkSoftQuestions(ctx, live, maybeQs, toolCall.toolCallId, toolCall.title);
    }
    return;
  }

  const grokProfile = ctx.profileFor(live.session);
  if (
    grokProfile?.toolAllowlist?.length &&
    !allowlistAllowsTool(grokProfile.toolAllowlist, {
      toolName: toolCall.title,
      kind: toolCall.kind,
      title: toolCall.title,
    })
  ) {
    const reject =
      options.find((o) => o.kind === "reject_once" || o.kind === "reject_always") ?? options[1];
    if (reject) {
      console.log(
        `[approvals] deny toolAllowlist session=${live.session.id.slice(0, 8)} ` +
          `profile=${grokProfile.id} tool="${(toolCall.title ?? toolCall.kind ?? "").slice(0, 80)}"`,
      );
      live.client.respond(rpcId, {
        outcome: { outcome: "selected", optionId: reject.optionId },
      });
    }
    return;
  }

  // Auto-approve safe kinds (reads/searches). Do NOT include "other" if it masks questionnaires —
  // still allow configured kinds except we already special-cased AskUser.
  if (ctx.config.autoApproveKinds.map((k) => k.toLowerCase()).includes(kind)) {
    const allow = options.find((o) => o.kind === "allow_once" || o.kind === "allow_always") ?? options[0];
    live.client.respond(rpcId, {
      outcome: { outcome: "selected", optionId: allow.optionId },
    });
    return;
  }

  // Session-scoped allowlist: user previously chose "Always this session"
  // for this exact tool + title → skip phone.
  const grokSig = grokApprovalSignature(toolCall.kind, toolCall.title ?? "Permission required");
  if (live.session.autoApproveSignatures?.includes(grokSig)) {
    const allow = options.find((o) => o.kind === "allow_once" || o.kind === "allow_always") ?? options[0];
    console.log(
      `[approvals] auto-approve session-allowlist session=${live.session.id.slice(0, 8)} sig="${grokSig}"`,
    );
    live.client.respond(rpcId, {
      outcome: { outcome: "selected", optionId: allow.optionId },
    });
    return;
  }

  if (
    grokProfile?.autoApprovalSignatures?.length &&
    matchesProfileAllowlist(grokSig, grokProfile.autoApprovalSignatures)
  ) {
    const allow = options.find((o) => o.kind === "allow_once" || o.kind === "allow_always") ?? options[0];
    console.log(
      `[approvals] auto-approve profile-allowlist session=${live.session.id.slice(0, 8)} ` +
        `profile=${grokProfile.id} sig="${grokSig}"`,
    );
    live.client.respond(rpcId, {
      outcome: { outcome: "selected", optionId: allow.optionId },
    });
    return;
  }

  // Dangerous / edit / execute → phone approval
  const approvalId = randomUUID();
  const approval: PendingApproval & { rpcId: number | string } = {
    id: approvalId,
    sessionId: live.session.id,
    toolCallId: toolCall.toolCallId,
    title: toolCall.title ?? "Permission required",
    kind: toolCall.kind,
    rawInput: toolCall.rawInput,
    locations: toolCall.locations,
    preview: approvalPreview(toolCall.rawInput, (toolCall as { content?: unknown }).content),
    options,
    createdAt: now(),
    expiresAt: expiresInIso(DEFAULT_APPROVAL_TTL_MS),
    rpcId,
  };

  live.pendingApprovals.set(approvalId, approval);
  live.session.pendingApprovalId = approvalId;
  const { rpcId: _rPerm, ...publicApproval } = approval;
  live.session.pendingApproval = publicApproval;
  live.session.status = "awaiting_approval";
  live.session.updatedAt = now();
  ctx.persist(live.session);

  ctx.emitEvent(live.session, "approval.needed", publicApproval);
  ctx.maybeNotify("Approval needed", `${live.session.title}: ${approval.title}`);
}

export function flushAssistant(ctx: TurnContext, live: LiveSession): void {
  if (!live.assistantBuffer.trim()) {
    live.assistantBuffer = "";
    return;
  }
  const entry: TranscriptEntry = {
    id: randomUUID(),
    role: "assistant",
    text: live.assistantBuffer,
    at: now(),
  };
  live.session.transcript.push(entry);
  live.assistantBuffer = "";
  live.session.updatedAt = now();
  ctx.persist(live.session);
  ctx.emitEvent(live.session, "transcript", entry);
}
