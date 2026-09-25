// Extracted from session-manager.ts (RFC-052). Behavior unchanged.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { DispatchSession, PromptImage, ToolCallRecord, TranscriptEntry } from "../../types.js";
import { extraDirsAgentNote } from "../../sessions/files.js";
import { antigravityAutoApproves } from "../../profiles.js";
import { AntigravityRunner } from "../../antigravity/runner.js";
import { lastUserTextIs, now } from "../session-helpers.js";
import { materializeImagesInCwd, savePromptImagesForSession } from "../session-support.js";
import type { TurnContext } from "./context.js";

/**
 * One Antigravity CLI (`agy`) turn: headless -p + stream-json + conversation resume.
 * Phone tool-approval hooks are not available (agy soft-denies shell in headless unless
 * --dangerously-skip-permissions or settings allow rules). We default to skip-permissions
 * so Dispatch tasks can actually edit/run like Claude acceptEdits; tighten via profile env
 * ANTIGRAVITY_REQUIRE_PERMISSIONS=1 if desired.
 */
export async function antigravityTurn(
  ctx: TurnContext,
  sessionId: string,
  prompt: string,
  images: PromptImage[] = [],
  opts?: { recordUser?: boolean },
): Promise<DispatchSession> {
  const session = ctx.get(sessionId);
  if (!session) throw new Error("Session not found");

  const savedPaths = savePromptImagesForSession(ctx.config, session, images);
  const promptPaths = materializeImagesInCwd(session.cwd, savedPaths);
  let agentPrompt =
    extraDirsAgentNote(session.extraDirs) +
    (promptPaths.length === 0
      ? prompt
      : `${prompt}\n\n[User attached screenshot file(s) for debugging — open/read these paths with your tools:]\n${promptPaths.map((p) => `- ${p}`).join("\n")}`);

  if (session.transferHandoffPending || (!session.antigravityConversationId && session.transcript.length > 1)) {
    if (session.transferHandoffPending) {
      agentPrompt = ctx.buildTransferHandoffPrompt(session, agentPrompt);
      session.transferHandoffPending = false;
    }
  }

  const userText =
    images.length === 0
      ? prompt
      : `📷 ${images.length} screenshot${images.length === 1 ? "" : "s"}${prompt ? `\n${prompt}` : ""}`;
  const recordUser = opts?.recordUser !== false && !lastUserTextIs(session, userText);
  const entry: TranscriptEntry = {
    id: randomUUID(),
    role: "user",
    text: userText,
    at: now(),
  };
  if (recordUser) session.transcript.push(entry);
  session.status = "running";
  session.error = undefined;
  session.completedAt = undefined;
  session.updatedAt = now();
  ctx.persist(session);
  if (recordUser) ctx.emitEvent(session, "transcript", entry);
  ctx.emitEvent(session, "session.updated", { status: "running", backend: "antigravity" });

  const profileEnv = ctx.profileEnvFor(session);
  const requirePerms = !antigravityAutoApproves(profileEnv);

  const profile = ctx.profileFor(session);
  const runner = new AntigravityRunner({
    cwd: session.cwd,
    conversationId: session.antigravityConversationId,
    prompt: agentPrompt,
    model: session.model,
    skipPermissions: !requirePerms,
    profileEnv,
    systemPrompt: profile?.systemPrompt,
    toolAllowlist: profile?.toolAllowlist,
  });
  ctx.cliRunners.set(sessionId, runner);

  let streamBuf = "";
  runner.on("text", (chunk: string) => {
    streamBuf += chunk;
    ctx.emitEvent(session, "transcript", { role: "assistant", text: chunk, streaming: true });
  });
  runner.on("system", (text: string) => {
    ctx.emitEvent(session, "session.updated", { diagnostic: text.slice(0, 200) });
  });
  runner.on("tool", (info: { name: string; id?: string; input?: unknown; status: string }) => {
    const record: ToolCallRecord = {
      toolCallId: info.id ?? randomUUID(),
      title: info.name,
      kind: /write|edit|delete|file/i.test(info.name)
        ? "edit"
        : /command|bash|shell|run/i.test(info.name)
          ? "execute"
          : "other",
      status: info.status,
      rawInput: info.input,
      updatedAt: now(),
    };
    // Match by title when no stable id (agy stream often omits ids)
    const idx = info.id
      ? session.toolCalls.findIndex((t) => t.toolCallId === info.id)
      : session.toolCalls.findIndex(
          (t) => t.title === record.title && t.status === "pending",
        );
    if (idx >= 0) session.toolCalls[idx] = { ...session.toolCalls[idx]!, ...record };
    else session.toolCalls.push(record);
    ctx.persist(session);
    ctx.emitEvent(session, "tool_call", record);
  });

  try {
    const { text, conversationId } = await runner.run();
    if (conversationId) session.antigravityConversationId = conversationId;
    const finalText = text || streamBuf || "(Antigravity returned empty output)";
    const assistantEntry: TranscriptEntry = {
      id: randomUUID(),
      role: "assistant",
      text: finalText,
      at: now(),
    };
    session.transcript.push(assistantEntry);
    session.status = "idle";
    session.updatedAt = now();
    session.stopReason = "end_turn";
    ctx.persist(session);
    ctx.emitEvent(session, "transcript", assistantEntry);
    ctx.emitEvent(session, "session.updated", {
      status: "idle",
      backend: "antigravity",
      antigravityConversationId: session.antigravityConversationId,
    });
    ctx.maybeNotify("ClankerSpanker", `Antigravity ready: ${session.title}`);
    return session;
  } catch (err) {
    const e = err as { message?: string };
    session.status = "failed";
    session.error = (e.message ?? String(err)).slice(0, 2000);
    session.updatedAt = now();
    ctx.persist(session);
    ctx.emitEvent(session, "session.failed", { error: session.error });
    throw new Error(session.error);
  } finally {
    ctx.cliRunners.delete(sessionId);
  }
}
