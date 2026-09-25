// Extracted from session-manager.ts (RFC-052). Behavior unchanged.
import { randomUUID } from "node:crypto";
import type { Bot, DispatchSession, TranscriptEntry } from "../../types.js";
import { runBotSession } from "../../bot/runner.js";
import { now } from "../session-helpers.js";
import type { BotRunState } from "../session-helpers.js";
import type { TurnContext } from "./context.js";

export async function botTurn(
  ctx: TurnContext,
  session: DispatchSession,
  prompt: string,
  isFollowUp: boolean,
  maxTurns?: number,
  botTools?: string[],
): Promise<void> {
  if (isFollowUp) {
    const entry: TranscriptEntry = {
      id: randomUUID(),
      role: "user",
      text: prompt,
      at: now(),
    };
    session.transcript.push(entry);
    session.status = "running";
    session.error = undefined;
    session.completedAt = undefined;
    session.updatedAt = now();
    ctx.persist(session);
    ctx.emitEvent(session, "transcript", entry);
  }

  const owner = ctx.profileFor(session);
  if (!owner) throw new Error("Bot session has no profile");
  const profile = ctx.botBrainProfile(owner);

  const abort = new AbortController();
  const run: BotRunState = { sessionId: session.id, cancelled: false, abort };
  ctx.botRuns.set(session.id, run);

  try {
    await runBotSession({
      session,
      profile,
      prompt,
      isFollowUp,
      maxTurns: maxTurns ?? 20,
      toolsAllowlist: botTools?.length ? botTools : owner.toolAllowlist,
      promptMaxMs: ctx.config.promptMaxMs,
      autoApproveKinds: (ctx.config.autoApproveKinds ?? []).map((k) => k.toLowerCase()),
      callbacks: {
        persist: (s) => ctx.persist(s),
        emit: (s, type, payload) => ctx.emitEvent(s, type, payload),
        isCancelled: () => run.cancelled,
        requestApproval: (s, approval) =>
          new Promise((resolve, reject) => {
            if (run.cancelled) {
              reject(new Error("cancelled"));
              return;
            }
            run.pending = { approvalId: approval.id, resolve, reject };
            ctx.maybeNotify("Bot needs approval", `${s.title}: ${approval.title}`);
          }),
      },
      signal: abort.signal,
    });
  } finally {
    ctx.botRuns.delete(session.id);
  }
}
