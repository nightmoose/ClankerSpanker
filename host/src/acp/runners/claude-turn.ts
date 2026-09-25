// Extracted from session-manager.ts (RFC-052). Behavior unchanged.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { DispatchSession, PromptImage, ToolCallRecord, TranscriptEntry } from "../../types.js";
import { isAuthFailureMessage } from "../../login.js";
import { mcpEnvFor, writeProfileMcpJson } from "../../mcp.js";
import { refreshAllMcpOAuth } from "../../mcp-oauth.js";
import { ClaudeRunner } from "../../claude/runner.js";
import { lastUserTextIs, now } from "../session-helpers.js";
import { ensureAttachmentDirs, materializeImagesInCwd, savePromptImagesForSession } from "../session-support.js";
import type { TurnContext } from "./context.js";

/** One Claude Code turn: stream-json + optional phone tool approvals. */
export async function claudeTurn(
  ctx: TurnContext,
  sessionId: string,
  prompt: string,
  images: PromptImage[] = [],
  opts?: { recordUser?: boolean },
): Promise<DispatchSession> {
  const session = ctx.get(sessionId);
  if (!session) throw new Error("Session not found");

  const extraDirs = ensureAttachmentDirs(ctx.config, session);
  const savedPaths = savePromptImagesForSession(ctx.config, session, images);
  const promptPaths = materializeImagesInCwd(session.cwd, savedPaths);
  let claudePrompt =
    promptPaths.length === 0
      ? prompt
      : `${prompt}\n\n[User attached screenshot file(s) for debugging — open/read these paths with your tools:]\n${promptPaths.map((p) => `- ${p}`).join("\n")}`;

  // Fresh Claude after profile transfer: inject prior transcript so the new account has context.
  if (session.transferHandoffPending || (!session.claudeSessionId && session.transcript.length > 1)) {
    if (session.transferHandoffPending) {
      claudePrompt = ctx.buildTransferHandoffPrompt(session, claudePrompt);
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
  ctx.emitEvent(session, "session.updated", { status: "running", backend: "claude" });

  const hostBase = `http://127.0.0.1:${ctx.config.bindPort}`;
  const profile = ctx.profileFor(session);
  if (profile) {
    await refreshAllMcpOAuth(ctx.config.dataDir, profile.id, profile.mcpServers).catch(() => undefined);
  }
  const runner = new ClaudeRunner({
    cwd: session.cwd,
    resumeSessionId: session.claudeSessionId,
    prompt: claudePrompt,
    dispatchSessionId: session.id,
    hostBaseUrl: hostBase,
    hostToken: ctx.config.hostToken,
    dataDir: ctx.config.dataDir,
    requirePhoneApproval: true,
    profileEnv: ctx.profileEnvFor(session),
    model: session.model,
    appendSystemPrompt: profile?.systemPrompt,
    extraDirs,
    toolAllowlist: profile?.toolAllowlist,
    mcpConfigPath: profile
      ? writeProfileMcpJson(ctx.config.dataDir, profile, mcpEnvFor(profile))
      : undefined,
  });
  ctx.cliRunners.set(sessionId, runner);

  let streamBuf = "";
  let thoughtBuf = "";
  runner.on("text", (chunk: string) => {
    streamBuf += chunk;
    ctx.emitEvent(session, "transcript", { role: "assistant", text: chunk, streaming: true });
  });
  runner.on("thought", (chunk: string) => {
    thoughtBuf += chunk;
    ctx.emitEvent(session, "thought", { role: "thought", text: chunk, streaming: true });
  });
  runner.on("usage", (u: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  }) => {
    const prev = session.usage;
    session.usage = {
      inputTokens: (prev?.inputTokens ?? 0) + u.inputTokens,
      outputTokens: (prev?.outputTokens ?? 0) + u.outputTokens,
      cacheReadTokens: (prev?.cacheReadTokens ?? 0) + u.cacheReadTokens,
      cacheCreationTokens: (prev?.cacheCreationTokens ?? 0) + u.cacheCreationTokens,
      turns: (prev?.turns ?? 0) + 1,
      updatedAt: now(),
    };
    ctx.persist(session);
    ctx.emitEvent(session, "usage", session.usage);
  });
  runner.on("tool", (info: { name: string; id?: string; input?: unknown; status: string }) => {
    const record: ToolCallRecord = {
      toolCallId: info.id ?? randomUUID(),
      title: info.name,
      kind: /edit|write|delete/i.test(info.name) ? "edit" : /bash/i.test(info.name) ? "execute" : "other",
      status: info.status,
      rawInput: info.input,
      updatedAt: now(),
    };
    const idx = session.toolCalls.findIndex((t) => t.toolCallId === record.toolCallId);
    if (idx >= 0) session.toolCalls[idx] = { ...session.toolCalls[idx]!, ...record };
    else session.toolCalls.push(record);
    ctx.persist(session);
    ctx.emitEvent(session, "tool_call", record);
  });

  try {
    const { text, sessionId: claudeSid } = await runner.run();
    if (claudeSid) session.claudeSessionId = claudeSid;
    // Persist the extended-thinking transcript ahead of the reply so the
    // phone renders it above the answer bubble (matches typical chat UX).
    if (thoughtBuf.trim()) {
      session.transcript.push({
        id: randomUUID(),
        role: "thought",
        text: thoughtBuf,
        at: now(),
      });
    }
    const finalText = text || streamBuf || "(Claude returned empty output)";
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
    ctx.emitEvent(session, "session.updated", { status: "idle", backend: "claude" });
    ctx.maybeNotify("ClankerSpanker", `Claude ready: ${session.title}`);
    return session;
  } catch (err) {
    const e = err as { message?: string };
    const msg = (e.message ?? String(err)).slice(0, 2000);
    session.status = "failed";
    session.error = msg;
    session.updatedAt = now();
    if (isAuthFailureMessage(msg)) {
      const name = session.profileName ?? session.profileId ?? "this profile";
      const note = {
        id: randomUUID(),
        role: "system" as const,
        text:
          `Sign-in required for ${name}. OAuth token missing or revoked. ` +
          `Use “Sign in…” in the app to open a browser login on this Mac, then retry.`,
        at: now(),
      };
      session.transcript.push(note);
      ctx.emitEvent(session, "transcript", note);
      ctx.emitEvent(session, "session.updated", {
        status: "failed",
        needsLogin: true,
        profileId: session.profileId,
        backend: "claude",
      });
    }
    ctx.persist(session);
    ctx.emitEvent(session, "session.failed", {
      error: session.error,
      needsLogin: isAuthFailureMessage(msg),
      profileId: session.profileId,
    });
    throw new Error(session.error);
  } finally {
    ctx.cliRunners.delete(sessionId);
  }
}
