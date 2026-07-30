import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { HostConfigFile } from "../types.js";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  AgentQuestion,
  AnswerQuestionsRequest,
  AttachClaudeRequest,
  AttachRequest,
  DispatchRequest,
  DispatchSession,
  PendingApproval,
  PendingQuestion,
  PlanEntry,
  PromptImage,
  SessionEvent,
  ToolCallRecord,
  TranscriptEntry,
} from "../types.js";
import { resolveProjectPath } from "../config.js";
import { SessionStore } from "../sessions/store.js";
import {
  extractClaudeContext,
  gitDiff,
  listClaudeSessions,
} from "../sessions/reader.js";
import { notifyDesktop } from "../notify/local.js";
import { profileProcessEnv, resolveProfile } from "../profiles.js";
import { AcpClient } from "./client.js";
import { ClaudeRunner } from "../claude/runner.js";

const execFileAsync = promisify(execFile);

function now(): string {
  return new Date().toISOString();
}

function shortTitle(prompt: string, explicit?: string): string {
  if (explicit?.trim()) return explicit.trim().slice(0, 80);
  const line = prompt.trim().split(/\n/)[0] ?? "Untitled task";
  return line.length > 72 ? line.slice(0, 69) + "…" : line;
}

interface LiveSession {
  session: DispatchSession;
  client: AcpClient;
  pendingApprovals: Map<string, PendingApproval & { rpcId?: number | string; source?: "grok" | "claude" }>;
  pendingQuestions: Map<string, PendingQuestion & { rpcId?: number | string }>;
  assistantBuffer: string;
  thoughtBuffer: string;
}

interface ClaudeHookApproval {
  id: string;
  sessionId: string;
  status: "pending" | "approved" | "rejected";
  title: string;
  toolName: string;
  toolInput?: unknown;
  comment?: string;
  createdAt: string;
}

/**
 * Manages dispatched sessions: Grok (ACP) + Claude Code (stream-json + phone hooks).
 */
export class SessionManager extends EventEmitter {
  private live = new Map<string, LiveSession>();
  /** Claude PreToolUse hook approvals (polled by hook process). */
  private claudeApprovals = new Map<string, ClaudeHookApproval>();
  readonly store: SessionStore;

  constructor(private readonly config: HostConfigFile) {
    super();
    this.store = new SessionStore(config.dataDir);
  }

  list(): DispatchSession[] {
    const disk = this.store.list();
    // Overlay live status
    return disk.map((s) => this.live.get(s.id)?.session ?? s);
  }

  get(id: string): DispatchSession | null {
    const s = this.live.get(id)?.session ?? this.store.load(id);
    if (!s) return null;
    // Rehydrate questionnaire UI from a pending AskUserQuestion tool call
    if (!s.pendingQuestion) {
      const parked = findPendingAskUserTool(s);
      if (parked) {
        s.pendingQuestion = parked;
        s.pendingQuestionId = parked.id;
        if (s.status === "running") s.status = "awaiting_question";
      }
    }
    return s;
  }

  getPendingApproval(sessionId: string): PendingApproval | null {
    const live = this.live.get(sessionId);
    const session = live?.session ?? this.store.load(sessionId);
    const id = session?.pendingApprovalId;
    if (!id) return null;

    if (live) {
      const full = live.pendingApprovals.get(id);
      if (full) {
        const { rpcId: _rpc, source: _s, ...publicApproval } = full;
        return publicApproval;
      }
    }

    // Claude hook approval (no ACP live client)
    const hook = this.claudeApprovals.get(id);
    if (hook && hook.status === "pending" && hook.sessionId === sessionId) {
      return {
        id: hook.id,
        sessionId: hook.sessionId,
        title: hook.title,
        kind: hook.toolName.toLowerCase().includes("bash") ? "execute" : "edit",
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
        createdAt: hook.createdAt,
        rawInput: hook.toolInput,
      };
    }
    return null;
  }

  getPendingQuestion(sessionId: string): PendingQuestion | null {
    const live = this.live.get(sessionId);
    if (live) {
      const id = live.session.pendingQuestionId;
      if (id) {
        const full = live.pendingQuestions.get(id);
        if (full) {
          const { rpcId: _r, ...pub } = full;
          return { ...pub, canRespondViaAcp: _r !== undefined };
        }
      }
    }
    // Fall back to persisted snapshot (e.g. after reload of detail while still running)
    const s = this.get(sessionId);
    return s?.pendingQuestion ?? null;
  }

  async dispatch(req: DispatchRequest): Promise<DispatchSession> {
    if (!req.prompt?.trim()) throw new Error("prompt is required");

    const profile = resolveProfile(this.config, req.profileId);
    const { path: cwd, projectId } = resolveProjectPath(this.config, req.projectId, req.cwd);
    const id = randomUUID();
    const createdAt = now();
    const model =
      req.model ??
      profile.model ??
      (profile.backend === "claude" ? "claude" : "grok-build");

    const session: DispatchSession = {
      id,
      backend: profile.backend,
      profileId: profile.id,
      profileName: profile.name,
      profileColor: profile.color,
      title: shortTitle(req.prompt, req.title),
      prompt: req.prompt.trim(),
      cwd,
      projectId,
      model,
      planMode: req.planMode ?? false,
      subagents: req.subagents ?? true,
      worktree: req.worktree ?? true,
      status: "queued",
      createdAt,
      updatedAt: createdAt,
      transcript: [
        {
          id: randomUUID(),
          role: "user",
          text: req.prompt.trim(),
          at: createdAt,
        },
      ],
      toolCalls: [],
      events: [],
    };

    this.store.save(session);
    this.emitEvent(session, "session.created", { session: this.store.toSummary(session) });
    console.log(
      `[dispatch] profile=${profile.id} (${profile.name}) backend=${profile.backend} model=${model} session=${id.slice(0, 8)}`,
    );

    // Start async so HTTP returns immediately
    void this.runSession(session, req).catch((err) => {
      console.error(`[session ${id}] fatal:`, err);
      session.status = "failed";
      session.error = err instanceof Error ? err.message : String(err);
      session.updatedAt = now();
      this.persist(session);
      this.emitEvent(session, "session.failed", { error: session.error });
    });

    return session;
  }

  isLive(sessionId: string): boolean {
    return this.live.has(sessionId);
  }

  /**
   * Continue a conversation. Re-attaches the ACP process + loads the Grok
   * session from disk if the host restarted or the process died.
   * Claude-backed sessions use headless `claude -p --resume` per turn.
   */
  async followUp(
    sessionId: string,
    prompt: string,
    images?: PromptImage[],
  ): Promise<DispatchSession> {
    const imgs = normalizeImages(images);
    const text = (prompt ?? "").trim();
    if (!text && imgs.length === 0) throw new Error("prompt or images required");

    const session = this.get(sessionId);
    if (!session) throw new Error("Session not found");

    const displayText =
      imgs.length === 0
        ? text
        : `📷 ${imgs.length} screenshot${imgs.length === 1 ? "" : "s"}${text ? `\n${text}` : ""}`;

    if (session.backend === "claude") {
      return this.claudeTurn(sessionId, text || displayText, imgs);
    }

    const live = await this.ensureLive(sessionId);

    const entry: TranscriptEntry = {
      id: randomUUID(),
      role: "user",
      text: displayText,
      at: now(),
    };
    live.session.transcript.push(entry);
    live.session.status = "running";
    live.session.completedAt = undefined;
    live.session.error = undefined;
    live.session.updatedAt = now();
    this.persist(live.session);
    this.emitEvent(live.session, "transcript", entry);

    await this.promptTurn(live, text || displayText, imgs);
    return live.session;
  }

  /**
   * Open an existing Grok Build session (from TUI / headless / prior Dispatch)
   * so the phone can keep chatting in that context.
   */
  async attach(req: AttachRequest): Promise<DispatchSession> {
    if (!req.grokSessionId?.trim()) throw new Error("grokSessionId is required");
    if (!req.cwd?.trim()) throw new Error("cwd is required");

    // Reuse Dispatch wrapper if we already track this Grok session
    const existing = this.list().find((s) => s.grokSessionId === req.grokSessionId);
    if (existing) {
      await this.ensureLive(existing.id);
      if (req.prompt?.trim()) {
        return this.followUp(existing.id, req.prompt.trim());
      }
      return this.get(existing.id)!;
    }

    const profile = resolveProfile(this.config, req.profileId, "grok");
    const id = randomUUID();
    const createdAt = now();
    const session: DispatchSession = {
      id,
      backend: "grok",
      profileId: profile.id,
      profileName: profile.name,
      profileColor: profile.color,
      grokSessionId: req.grokSessionId.trim(),
      title: shortTitle(req.prompt ?? "Resumed session", req.title),
      prompt: req.prompt?.trim() || `(Resumed Grok session ${req.grokSessionId.slice(0, 8)})`,
      cwd: req.cwd,
      model: req.model ?? profile.model ?? "grok-build",
      planMode: false,
      subagents: true,
      worktree: false,
      status: "queued",
      createdAt,
      updatedAt: createdAt,
      transcript: req.prompt?.trim()
        ? [{ id: randomUUID(), role: "user", text: req.prompt.trim(), at: createdAt }]
        : [
            {
              id: randomUUID(),
              role: "system",
              text: `Attached existing Grok Build session ${req.grokSessionId}`,
              at: createdAt,
            },
          ],
      toolCalls: [],
      events: [],
    };
    this.store.save(session);
    this.emitEvent(session, "session.created", { session: this.store.toSummary(session), attached: true });

    const live = await this.spawnAndLoad(session, session.grokSessionId!);
    live.session.status = "idle";
    live.session.updatedAt = now();
    this.persist(live.session);
    this.emitEvent(live.session, "session.updated", { status: "idle", attached: true });

    if (req.prompt?.trim()) {
      await this.promptTurn(live, req.prompt.trim());
    }
    return live.session;
  }

  /**
   * Open a Claude Code session.
   * Default: hand off context to Grok (best multi-turn + approval UX).
   * Optional: resume-claude keeps using Claude CLI headlessly.
   */
  async attachClaude(req: AttachClaudeRequest): Promise<DispatchSession> {
    if (!req.claudeSessionId?.trim()) throw new Error("claudeSessionId is required");
    if (!req.cwd?.trim()) throw new Error("cwd is required");

    const mode = req.mode ?? "continue-with-grok";
    const claudeId = req.claudeSessionId.trim();

    // Already attached?
    const existing = this.list().find(
      (s) => s.claudeSessionId === claudeId || (s.backend === "claude" && s.claudeSessionId === claudeId),
    );
    if (existing) {
      if (req.prompt?.trim()) return this.followUp(existing.id, req.prompt.trim());
      return existing;
    }

    const transcriptPath =
      req.transcriptPath ??
      listClaudeSessions(200).find((s) => s.id === claudeId)?.transcriptPath ??
      findClaudeTranscriptPath(claudeId);

    if (mode === "continue-with-grok") {
      let contextBlock = "";
      if (transcriptPath && existsSync(transcriptPath)) {
        const { excerpt } = await extractClaudeContext(transcriptPath);
        contextBlock = excerpt;
      }

      const handoffPrompt =
        req.prompt?.trim() ||
        `You are continuing work that started in Claude Code (session ${claudeId.slice(0, 8)}).\n` +
          `Project: ${req.cwd}\n\n` +
          `Below is a recent excerpt of that Claude conversation. Pick up the thread, ` +
          `verify current repo state, and continue the work. Do not re-do completed steps unless needed.\n\n` +
          `----- CLAUDE TRANSCRIPT EXCERPT -----\n${contextBlock || "(no transcript excerpt found)"}\n` +
          `----- END EXCERPT -----\n\n` +
          `Acknowledge briefly what you understand the next step to be, then proceed.`;

      const grokProfile = resolveProfile(this.config, req.profileId, "grok");
      const session = await this.dispatch({
        prompt: handoffPrompt,
        cwd: req.cwd,
        title: req.title ?? `From Claude · ${claudeId.slice(0, 8)}`,
        planMode: false,
        worktree: false,
        subagents: true,
        model: grokProfile.model ?? "grok-build",
        profileId: grokProfile.id,
      });

      // Annotate wrapper with Claude provenance
      session.claudeSessionId = claudeId;
      session.backend = "grok";
      session.transcript.unshift({
        id: randomUUID(),
        role: "system",
        text: `Continued from Claude Code session ${claudeId} (context imported into Grok).`,
        at: now(),
      });
      this.persist(session);
      return session;
    }

    // resume-claude: Claude-backed Dispatch session with streaming + phone approvals
    const id = randomUUID();
    const createdAt = now();
    const imported: TranscriptEntry[] = [];
    if (transcriptPath && existsSync(transcriptPath)) {
      try {
        const { messages } = await extractClaudeContext(transcriptPath, 20_000);
        for (const m of messages.slice(-12)) {
          imported.push({
            id: randomUUID(),
            role: m.role === "user" ? "user" : "assistant",
            text: m.text.slice(0, 4000),
            at: createdAt,
          });
        }
      } catch {
        /* ignore import errors */
      }
    }

    const profile = resolveProfile(this.config, req.profileId, "claude");
    const session: DispatchSession = {
      id,
      backend: "claude",
      profileId: profile.id,
      profileName: profile.name,
      profileColor: profile.color,
      claudeSessionId: claudeId,
      title: shortTitle(req.prompt ?? req.title ?? "Claude session", req.title),
      prompt: req.prompt?.trim() || `(Claude session ${claudeId.slice(0, 8)})`,
      cwd: req.cwd,
      model: profile.model ?? "claude",
      planMode: false,
      subagents: false,
      worktree: false,
      status: "idle",
      createdAt,
      updatedAt: createdAt,
      transcript: [
        {
          id: randomUUID(),
          role: "system",
          text:
            `Attached Claude Code session ${claudeId} as ${profile.name}. ` +
            `Streaming + phone approval for Edit/Write/Bash (via PreToolUse hook). ` +
            `Read-only tools auto-run.`,
          at: createdAt,
        },
        ...imported,
      ],
      toolCalls: [],
      events: [],
    };
    this.store.save(session);
    this.emitEvent(session, "session.created", {
      session: this.store.toSummary(session),
      attached: true,
      backend: "claude",
    });

    if (req.prompt?.trim()) {
      return this.claudeTurn(id, req.prompt.trim());
    }
    return session;
  }

  /** Create a Claude tool approval and park the session (called by PreToolUse hook). */
  createClaudeApproval(body: {
    sessionId: string;
    toolName: string;
    title: string;
    toolInput?: unknown;
  }): ClaudeHookApproval {
    const session = this.get(body.sessionId);
    if (!session) throw new Error("Session not found");

    const id = randomUUID();
    const approval: ClaudeHookApproval = {
      id,
      sessionId: body.sessionId,
      status: "pending",
      title: body.title || body.toolName,
      toolName: body.toolName,
      toolInput: body.toolInput,
      createdAt: now(),
    };
    this.claudeApprovals.set(id, approval);

    const publicApproval: PendingApproval & { source?: "claude" } = {
      id,
      sessionId: body.sessionId,
      title: approval.title,
      kind: body.toolName.toLowerCase().includes("bash") ? "execute" : "edit",
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
      createdAt: approval.createdAt,
      rawInput: body.toolInput,
    };

    // Park on session for phone UI even without ACP live client
    session.pendingApprovalId = id;
    session.status = "awaiting_approval";
    session.updatedAt = now();
    this.persist(session);

    // Also stash if grok live map has entry
    const live = this.live.get(body.sessionId);
    if (live) {
      live.pendingApprovals.set(id, { ...publicApproval, source: "claude" });
    }

    this.emitEvent(session, "approval.needed", publicApproval);
    this.maybeNotify("Claude needs approval", `${session.title}: ${approval.title}`);
    return approval;
  }

  getClaudeApproval(approvalId: string): ClaudeHookApproval | null {
    return this.claudeApprovals.get(approvalId) ?? null;
  }

  async cancel(sessionId: string): Promise<DispatchSession> {
    const live = this.live.get(sessionId);
    if (live) {
      // Cancel pending approvals
      for (const [aid, approval] of live.pendingApprovals) {
        if (approval.rpcId !== undefined) {
          live.client.respond(approval.rpcId, { outcome: { outcome: "cancelled" } });
        }
        live.pendingApprovals.delete(aid);
      }
      try {
        live.client.notify("session/cancel", { sessionId: live.session.grokSessionId });
      } catch {
        /* ignore */
      }
      live.session.status = "cancelled";
      live.session.updatedAt = now();
      live.session.completedAt = now();
      this.persist(live.session);
      this.emitEvent(live.session, "session.completed", { status: "cancelled" });
      await live.client.stop();
      this.live.delete(sessionId);
      return live.session;
    }

    const s = this.store.load(sessionId);
    if (!s) throw new Error("Session not found");
    s.status = "cancelled";
    s.updatedAt = now();
    s.completedAt = now();
    this.store.save(s);
    return s;
  }

  /** Update display title for a session (phone-editable name). */
  rename(sessionId: string, title: string): DispatchSession {
    const trimmed = title.trim();
    if (!trimmed) throw new Error("title is required");
    const live = this.live.get(sessionId);
    if (live) {
      live.session.title = trimmed.slice(0, 200);
      live.session.updatedAt = now();
      this.persist(live.session);
      this.emitEvent(live.session, "session.updated", { title: live.session.title });
      return live.session;
    }
    const s = this.store.load(sessionId);
    if (!s) throw new Error("Session not found");
    s.title = trimmed.slice(0, 200);
    s.updatedAt = now();
    this.store.save(s);
    this.emitEvent(s, "session.updated", { title: s.title });
    return s;
  }

  /**
   * Soft-archive (or restore) a Dispatch session.
   * Archived chats drop out of the default Active list but stay on disk and openable.
   */
  setArchived(sessionId: string, archived: boolean): DispatchSession {
    const live = this.live.get(sessionId);
    if (live) {
      live.session.archived = archived;
      live.session.archivedAt = archived ? now() : undefined;
      live.session.updatedAt = now();
      this.persist(live.session);
      this.emitEvent(live.session, "session.updated", {
        archived: live.session.archived,
        archivedAt: live.session.archivedAt,
      });
      return live.session;
    }
    const s = this.store.load(sessionId);
    if (!s) throw new Error("Session not found");
    s.archived = archived;
    s.archivedAt = archived ? now() : undefined;
    s.updatedAt = now();
    this.store.save(s);
    this.emitEvent(s, "session.updated", { archived: s.archived, archivedAt: s.archivedAt });
    return s;
  }

  /**
   * Answer an ask_user_question questionnaire from the phone.
   * Prefer live ACP response; fall back to a structured follow-up message.
   */
  async answerQuestions(sessionId: string, body: AnswerQuestionsRequest): Promise<DispatchSession> {
    const answers = (body.answers ?? []).map((a) => a.trim()).filter(Boolean);
    if (answers.length === 0 && body.outcome !== "skip" && body.outcome !== "chat") {
      throw new Error("answers required (or outcome skip/chat)");
    }

    const live = this.live.get(sessionId);
    const session = live?.session ?? this.store.load(sessionId);
    if (!session) throw new Error("Session not found");

    const qid = body.questionId ?? session.pendingQuestionId;
    const pending =
      (qid && live?.pendingQuestions.get(qid)) ||
      (session.pendingQuestionId && live?.pendingQuestions.get(session.pendingQuestionId)) ||
      null;

    const questions = pending?.questions ?? session.pendingQuestion?.questions ?? [];
    const summaryLines =
      questions.length > 0
        ? questions.map((q, i) => `Q: ${q.question}\nA: ${answers[i] ?? "(no answer)"}`).join("\n\n")
        : answers.map((a, i) => `A${i + 1}: ${a}`).join("\n");

    const note: TranscriptEntry = {
      id: randomUUID(),
      role: "user",
      text:
        body.outcome === "skip"
          ? "[Skipped questionnaire]"
          : body.outcome === "chat"
            ? `[Discussing questions instead]\n${body.comment ?? answers.join("\n")}`
            : `[Answers to your questions]\n${summaryLines}${body.comment ? `\n\nNotes: ${body.comment}` : ""}`,
      at: now(),
    };
    session.transcript.push(note);
    this.emitEvent(session, "transcript", note);

    // Prefer ACP extension response when we still hold the request id
    if (live && pending?.rpcId !== undefined) {
      const outcome = body.outcome ?? "accepted";
      if (outcome === "skip") {
        live.client.respond(pending.rpcId, { type: "skip_interview" });
      } else if (outcome === "chat") {
        live.client.respond(pending.rpcId, { type: "chat_about_this" });
      } else {
        // Accepted: answers list aligned with questions
        live.client.respond(pending.rpcId, {
          type: "accepted",
          answers,
          partial_answers: answers.length < questions.length,
        });
      }
      live.pendingQuestions.delete(pending.id);
    } else if (live && pending && pending.rpcId === undefined) {
      // Soft recovery: questionnaire seen via tool stream but no RPC id.
      // Send answers as interjection text the agent can consume once unblocked,
      // and also try completing the tool path by canceling the hung turn then re-prompting.
      const answerText = `Here are my answers to your questions:\n\n${summaryLines}${body.comment ? `\n\nAdditional notes: ${body.comment}` : ""}\n\nPlease continue.`;
      live.pendingQuestions.delete(pending.id);
      session.pendingQuestionId = undefined;
      session.pendingQuestion = null;
      session.status = "running";
      this.persist(session);
      this.emitEvent(session, "question.answered", { answers, via: "soft_prompt" });
      // Fire-and-forget new turn if no prompt in flight is hard; use followUp-style path
      // by notifying cancel then prompting (await may race with existing promptTurn).
      try {
        live.client.notify("session/cancel", { sessionId: session.grokSessionId });
      } catch {
        /* ignore */
      }
      // Don't await a second concurrent promptTurn; schedule after microtask
      void this.promptTurn(live, answerText).catch((err) => {
        console.error(`[session ${sessionId}] soft answer prompt failed:`, err);
      });
      return session;
    } else if (!live) {
      // Process gone — reattach and send answers as follow-up
      await this.followUp(
        sessionId,
        `Here are my answers to your earlier questions (they may have been lost in the Dispatch UI):\n\n${summaryLines}${body.comment ? `\n\nNotes: ${body.comment}` : ""}\n\nPlease continue with the task.`,
      );
      const refreshed = this.get(sessionId)!;
      refreshed.pendingQuestionId = undefined;
      refreshed.pendingQuestion = null;
      refreshed.status = refreshed.status === "awaiting_question" ? "running" : refreshed.status;
      this.persist(refreshed);
      return refreshed;
    }

    session.pendingQuestionId = undefined;
    session.pendingQuestion = null;
    if (session.status === "awaiting_question") {
      session.status = "running";
    }
    session.updatedAt = now();
    this.persist(session);
    this.emitEvent(session, "question.answered", {
      answers,
      outcome: body.outcome ?? "accepted",
      via: pending?.rpcId !== undefined ? "acp" : "local",
    });
    this.emitEvent(session, "session.updated", { status: session.status });
    return session;
  }

  async resolveApproval(
    sessionId: string,
    approvalId: string,
    decision: "approve" | "reject",
    optionId?: string,
    comment?: string,
  ): Promise<DispatchSession> {
    // Claude PreToolUse hook approvals (no ACP client required)
    const claudeHook = this.claudeApprovals.get(approvalId);
    if (claudeHook) {
      claudeHook.status = decision === "approve" ? "approved" : "rejected";
      claudeHook.comment = comment;
      const session = this.get(sessionId);
      if (!session) throw new Error("Session not found");
      session.pendingApprovalId = undefined;
      session.status = "running";
      session.updatedAt = now();
      if (comment?.trim()) {
        session.transcript.push({
          id: randomUUID(),
          role: "system",
          text: `${decision === "approve" ? "Approved" : "Rejected"} Claude tool: ${claudeHook.title}${comment ? ` — ${comment}` : ""}`,
          at: now(),
        });
      }
      this.persist(session);
      this.emitEvent(session, "approval.resolved", { approvalId, decision, comment, backend: "claude" });
      const live = this.live.get(sessionId);
      live?.pendingApprovals.delete(approvalId);
      return session;
    }

    const live = this.live.get(sessionId);
    if (!live) throw new Error("Session is not active");

    const approval = live.pendingApprovals.get(approvalId);
    if (!approval) throw new Error("Approval not found or already resolved");

    let selected = optionId;
    if (!selected) {
      const kindWanted = decision === "approve" ? "allow_once" : "reject_once";
      const match = approval.options.find((o) => o.kind === kindWanted) ?? approval.options[0];
      selected = match?.optionId;
    }
    if (!selected) throw new Error("No permission option available");

    if (approval.rpcId !== undefined) {
      const raw = approval.rawInput as { variant?: string } | undefined;
      if (raw?.variant === "ExitPlanMode") {
        // Grok exit_plan_mode expects accepted/rejected, not permission optionIds.
        live.client.respond(approval.rpcId, {
          outcome: {
            outcome: decision === "approve" ? "accepted" : "rejected",
          },
        });
      } else {
        live.client.respond(approval.rpcId, {
          outcome: { outcome: "selected", optionId: selected },
        });
      }
    }

    live.pendingApprovals.delete(approvalId);
    live.session.pendingApprovalId = undefined;
    live.session.status = "running";
    live.session.updatedAt = now();

    let noteText: string | null = null;
    if (rawIsExitPlan(approval.rawInput)) {
      noteText =
        decision === "approve"
          ? "Plan approved — implementing."
          : "Plan rejected — continue planning.";
    } else if (comment?.trim()) {
      noteText = `${decision === "approve" ? "Approved" : "Rejected"} with comment: ${comment.trim()}`;
    }
    if (noteText) {
      const note: TranscriptEntry = {
        id: randomUUID(),
        role: "system",
        text: noteText,
        at: now(),
      };
      live.session.transcript.push(note);
      this.emitEvent(live.session, "transcript", note);
    }

    this.persist(live.session);
    this.emitEvent(live.session, "approval.resolved", {
      approvalId,
      decision,
      optionId: selected,
      comment,
    });

    return live.session;
  }

  async diff(sessionId: string): Promise<{ cwd: string; diff: string }> {
    const s = this.get(sessionId);
    if (!s) throw new Error("Session not found");
    const diff = await gitDiff(s.cwd);
    return { cwd: s.cwd, diff };
  }

  // ── internals ──────────────────────────────────────────────

  /** One Claude Code turn: stream-json + optional phone tool approvals. */
  private async claudeTurn(
    sessionId: string,
    prompt: string,
    images: PromptImage[] = [],
  ): Promise<DispatchSession> {
    const session = this.get(sessionId);
    if (!session) throw new Error("Session not found");

    const savedPaths = savePromptImages(this.config.dataDir, sessionId, images);
    const claudePrompt =
      savedPaths.length === 0
        ? prompt
        : `${prompt}\n\n[User attached screenshot file(s) for debugging — open/read these paths with your tools:]\n${savedPaths.map((p) => `- ${p}`).join("\n")}`;

    const entry: TranscriptEntry = {
      id: randomUUID(),
      role: "user",
      text:
        images.length === 0
          ? prompt
          : `📷 ${images.length} screenshot${images.length === 1 ? "" : "s"}${prompt ? `\n${prompt}` : ""}`,
      at: now(),
    };
    session.transcript.push(entry);
    session.status = "running";
    session.error = undefined;
    session.completedAt = undefined;
    session.updatedAt = now();
    this.persist(session);
    this.emitEvent(session, "transcript", entry);
    this.emitEvent(session, "session.updated", { status: "running", backend: "claude" });

    const hostBase = `http://127.0.0.1:${this.config.bindPort}`;
    const runner = new ClaudeRunner({
      cwd: session.cwd,
      resumeSessionId: session.claudeSessionId,
      prompt: claudePrompt,
      dispatchSessionId: session.id,
      hostBaseUrl: hostBase,
      hostToken: this.config.hostToken,
      dataDir: this.config.dataDir,
      requirePhoneApproval: true,
      profileEnv: this.profileEnvFor(session),
    });

    let streamBuf = "";
    runner.on("text", (chunk: string) => {
      streamBuf += chunk;
      this.emitEvent(session, "transcript", { role: "assistant", text: chunk, streaming: true });
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
      this.persist(session);
      this.emitEvent(session, "tool_call", record);
    });

    try {
      const { text, sessionId: claudeSid } = await runner.run();
      if (claudeSid) session.claudeSessionId = claudeSid;
      const finalText = text || streamBuf || "(Claude returned empty output)";
      session.transcript.push({
        id: randomUUID(),
        role: "assistant",
        text: finalText,
        at: now(),
      });
      session.status = "idle";
      session.updatedAt = now();
      session.stopReason = "end_turn";
      this.persist(session);
      this.emitEvent(session, "session.updated", { status: "idle", backend: "claude" });
      this.maybeNotify("ClankerSpanker", `Claude ready: ${session.title}`);
      return session;
    } catch (err) {
      const e = err as { message?: string };
      session.status = "failed";
      session.error = (e.message ?? String(err)).slice(0, 2000);
      session.updatedAt = now();
      this.persist(session);
      this.emitEvent(session, "session.failed", { error: session.error });
      throw new Error(session.error);
    }
  }

  /** Get live handle, re-spawning ACP + session/load when needed. */
  private async ensureLive(sessionId: string): Promise<LiveSession> {
    const existing = this.live.get(sessionId);
    if (existing) return existing;

    const session = this.store.load(sessionId);
    if (!session) throw new Error("Session not found");
    if (!session.grokSessionId) {
      throw new Error("Session has no Grok session id — cannot resume. Dispatch a new task.");
    }
    return this.spawnAndLoad(session, session.grokSessionId);
  }

  private wireClient(live: LiveSession): void {
    const { session, client } = live;

    client.on("stderr", (line: string) => {
      console.log(`[grok ${session.id.slice(0, 8)}] ${line}`);
    });

    client.on("notification", (msg: { id?: number | string; method: string; params?: unknown }) => {
      void this.handleAgentMessage(live, msg);
    });

    client.on("exit", (info?: { code?: number | null; signal?: string | null; stderr?: string }) => {
      if (this.live.get(session.id) !== live) return;

      const stderr = (info?.stderr ?? client.lastStderr ?? "").trim();
      const mapped =
        mapAgentExitError(stderr) ??
        (stderr
          ? `Agent process exited (code=${info?.code ?? "?"}, signal=${info?.signal ?? "null"}): ${stderr.split("\n").slice(-2).join(" | ").slice(0, 400)}`
          : null);

      if (
        session.status === "running" ||
        session.status === "awaiting_approval" ||
        session.status === "awaiting_question"
      ) {
        // Keep awaiting_question so phone can still answer after reattach.
        if (session.status === "awaiting_question" && session.pendingQuestion) {
          session.error =
            mapped ??
            "Agent process exited while waiting for your answers — reopen and submit answers again.";
          session.updatedAt = now();
          this.persist(session);
          this.emitEvent(session, "session.updated", {
            status: "awaiting_question",
            process: "exited",
            recoverable: Boolean(session.grokSessionId),
          });
        } else if (session.grokSessionId) {
          // Recoverable: disk session still exists — don't hard-fail the whole chat.
          // Next follow-up / open will ensureLive → session/load.
          session.status = "idle";
          session.error = mapped ?? "Agent process disconnected — open the chat again to continue.";
          session.updatedAt = now();
          this.persist(session);
          this.emitEvent(session, "session.updated", {
            status: "idle",
            process: "exited",
            recoverable: true,
            error: session.error,
          });
          this.maybeNotify("ClankerSpanker", `Disconnected (recoverable): ${session.title}`);
        } else {
          session.status = "failed";
          session.error = mapped ?? "Agent process exited unexpectedly";
          session.updatedAt = now();
          this.persist(session);
          this.emitEvent(session, "session.failed", {
            error: session.error,
            recoverable: false,
          });
          this.maybeNotify("ClankerSpanker", `Session failed: ${session.title}`);
        }
      } else if (session.status === "idle" || session.status === "completed") {
        session.updatedAt = now();
        this.persist(session);
        this.emitEvent(session, "session.updated", { status: session.status, process: "exited" });
      }
      this.live.delete(session.id);
    });
  }

  private newAcpClient(session: DispatchSession): AcpClient {
    const agentArgs: string[] = [];
    if (session.model) agentArgs.push("--model", session.model);
    return new AcpClient(this.config.grokBinary, agentArgs, this.profileEnvFor(session), {
      promptIdleTimeoutMs: this.config.promptIdleTimeoutMs,
      promptMaxMs: this.config.promptMaxMs,
    });
  }

  /** True while a prompt is parked on the human (do not idle-fail). */
  private isHumanGateOpen(live: LiveSession): boolean {
    const st = live.session.status;
    if (st === "awaiting_approval" || st === "awaiting_question") return true;
    if (live.pendingApprovals.size > 0 || live.pendingQuestions.size > 0) return true;
    if (live.session.pendingApprovalId || live.session.pendingQuestionId) return true;
    return false;
  }

  private profileEnvFor(session: DispatchSession): NodeJS.ProcessEnv {
    try {
      const profile = resolveProfile(
        this.config,
        session.profileId,
        session.backend === "claude" ? "claude" : "grok",
      );
      return profileProcessEnv(profile);
    } catch {
      return { ...process.env };
    }
  }

  private async spawnAndLoad(session: DispatchSession, grokSessionId: string): Promise<LiveSession> {
    const client = this.newAcpClient(session);
    const live: LiveSession = {
      session,
      client,
      pendingApprovals: new Map(),
      pendingQuestions: new Map(),
      assistantBuffer: "",
      thoughtBuffer: "",
    };
    this.live.set(session.id, live);
    this.wireClient(live);

    try {
      await client.start();
      await client.request("session/load", {
        sessionId: grokSessionId,
        cwd: session.cwd,
        mcpServers: [],
      });
      session.grokSessionId = grokSessionId;
      session.updatedAt = now();
      this.persist(session);
      return live;
    } catch (err) {
      await client.stop().catch(() => undefined);
      this.live.delete(session.id);
      throw err;
    }
  }

  private async runSession(session: DispatchSession, req: DispatchRequest): Promise<void> {
    if (session.backend === "claude") {
      await this.claudeTurn(session.id, session.prompt);
      return;
    }

    // Never pass --always-approve: phone is the human gate for file changes.
    const client = this.newAcpClient(session);
    const live: LiveSession = {
      session,
      client,
      pendingApprovals: new Map(),
      pendingQuestions: new Map(),
      assistantBuffer: "",
      thoughtBuffer: "",
    };
    this.live.set(session.id, live);
    this.wireClient(live);

    try {
      await client.start();

      const newParams: Record<string, unknown> = {
        cwd: session.cwd,
        mcpServers: [],
      };
      if (session.worktree) {
        newParams._meta = { ...(newParams._meta as object), worktree: true };
      }
      if (session.planMode) {
        newParams._meta = { ...(newParams._meta as object), planMode: true };
      }
      if (!session.subagents) {
        newParams._meta = { ...(newParams._meta as object), noSubagents: true };
      }

      const result = (await client.request("session/new", newParams)) as {
        sessionId?: string;
      };
      session.grokSessionId = result.sessionId ?? randomUUID();
      session.status = "running";
      session.updatedAt = now();
      this.persist(session);
      this.emitEvent(session, "session.updated", { grokSessionId: session.grokSessionId, status: "running" });

      let promptText = session.prompt;
      if (session.planMode) {
        promptText =
          `[Plan mode] Explore the codebase and write a concrete implementation plan before making any file edits. ` +
          `Present the plan for approval before implementing.\n\n${session.prompt}`;
      }

      await this.promptTurn(live, promptText);
    } catch (err) {
      session.status = "failed";
      const base = err instanceof Error ? err.message : String(err);
      const stderr = client.lastStderr?.trim();
      const mapped = mapAgentExitError(base) ?? mapAgentExitError(stderr ?? "");
      session.error =
        mapped ??
        (stderr && !base.includes(stderr.slice(0, 40)) ? `${base}\n${stderr.slice(-500)}` : base);
      session.completedAt = now();
      session.updatedAt = now();
      this.persist(session);
      this.emitEvent(session, "session.failed", { error: session.error });
      this.maybeNotify("ClankerSpanker", `Failed: ${session.title}`);
      // Stop the child so the next follow-up/ensureLive can respawn cleanly.
      await client.stop().catch(() => undefined);
      this.live.delete(session.id);
    }
  }

  private async promptTurn(
    live: LiveSession,
    text: string,
    images: PromptImage[] = [],
  ): Promise<void> {
    const { session, client } = live;
    if (!session.grokSessionId) throw new Error("Missing grok session id");

    live.assistantBuffer = "";
    live.thoughtBuffer = "";
    session.status = "running";
    session.updatedAt = now();
    this.persist(session);
    this.emitEvent(session, "session.updated", { status: "running" });

    // Persist attachments on disk (debug/audit) and send ACP image content blocks
    savePromptImages(this.config.dataDir, session.id, images);

    const promptBlocks: Array<Record<string, unknown>> = [];
    if (text.trim()) {
      promptBlocks.push({ type: "text", text });
    }
    for (const img of images) {
      promptBlocks.push({
        type: "image",
        mimeType: img.mimeType,
        data: img.data,
      });
    }
    if (promptBlocks.length === 0) {
      promptBlocks.push({ type: "text", text: "(empty)" });
    }

    try {
      // No short wall clock: long plan-mode / multi-tool turns and human gates
      // must stay open. Idle hang detection resets on ACP activity and freezes
      // while awaiting approval or questions on the phone.
      const result = (await client.request(
        "session/prompt",
        {
          sessionId: session.grokSessionId,
          prompt: promptBlocks,
        },
        {
          isIdlePaused: () => this.isHumanGateOpen(live),
        },
      )) as { stopReason?: string };

      this.flushAssistant(live);

      session.stopReason = result.stopReason;
      const statusNow = live.session.status;
      if (statusNow !== "cancelled" && statusNow !== "failed") {
        if (
          statusNow !== "awaiting_approval" &&
          statusNow !== "awaiting_question" &&
          live.pendingApprovals.size === 0 &&
          live.pendingQuestions.size === 0
        ) {
          // Idle = ready for another message (multi-turn). Not a terminal "Done".
          live.session.status = "idle";
          live.session.updatedAt = now();
          this.persist(live.session);
          this.emitEvent(live.session, "session.updated", {
            stopReason: result.stopReason,
            status: "idle",
          });
          this.maybeNotify("ClankerSpanker", `Your turn: ${live.session.title}`);
        }
      }
    } catch (err) {
      if (live.session.status === "cancelled") return;
      this.flushAssistant(live);
      live.session.status = "failed";
      const base = err instanceof Error ? err.message : String(err);
      live.session.error = mapAgentExitError(base) ?? base;
      live.session.completedAt = now();
      live.session.updatedAt = now();
      this.persist(live.session);
      this.emitEvent(live.session, "session.failed", { error: live.session.error });
      this.maybeNotify("ClankerSpanker", `Failed: ${live.session.title}`);
      // Kill hung/orphaned agent so ensureLive can respawn on retry.
      await client.stop().catch(() => undefined);
      this.live.delete(live.session.id);
      throw err;
    }
  }

  private async handleAgentMessage(
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
          this.emitEvent(session, "transcript", {
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
          this.emitEvent(session, "thought", { text: chunk });
          break;
        }
        case "tool_call": {
          this.flushAssistant(live);
          const record: ToolCallRecord = {
            toolCallId: String(update.toolCallId ?? randomUUID()),
            title: String(update.title ?? "Tool"),
            kind: update.kind as string | undefined,
            status: String(update.status ?? "pending"),
            rawInput: update.rawInput,
            locations: update.locations as ToolCallRecord["locations"],
            content: update.content,
            updatedAt: now(),
          };
          const idx = session.toolCalls.findIndex((t) => t.toolCallId === record.toolCallId);
          if (idx >= 0) session.toolCalls[idx] = record;
          else session.toolCalls.push(record);
          session.updatedAt = now();
          this.persist(session);
          this.emitEvent(session, "tool_call", record);
          // Surface questionnaires even if the extension method arrives late/missing
          this.maybeParkAskUserQuestionFromTool(live, record);
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
            existing.updatedAt = now();
          }
          session.updatedAt = now();
          this.persist(session);
          this.emitEvent(session, "tool_call_update", update);

          if (existing) this.maybeParkAskUserQuestionFromTool(live, existing);

          // Surface diffs embedded in tool content
          const content = update.content as Array<{ type?: string; path?: string; oldText?: string; newText?: string }> | undefined;
          if (Array.isArray(content)) {
            for (const c of content) {
              if (c.type === "diff") {
                this.emitEvent(session, "diff", c);
              }
            }
          }
          break;
        }
        case "plan": {
          const entries = (update.entries as PlanEntry[]) ?? [];
          session.plan = entries;
          session.updatedAt = now();
          this.persist(session);
          this.emitEvent(session, "plan", { entries });
          break;
        }
        case "usage_update": {
          this.emitEvent(session, "usage", update);
          break;
        }
        default:
          this.emitEvent(session, "session.updated", update);
      }
      return;
    }

    if (method === "session/request_permission") {
      await this.handlePermissionRequest(live, msg.id!, msg.params);
      return;
    }

    // Grok extension: interactive questionnaire (the thing that was leaving sessions stuck)
    // Accept both x.ai/… and _x.ai/… (agent has used both).
    if (method === "x.ai/ask_user_question" && msg.id !== undefined) {
      this.handleAskUserQuestionRequest(live, msg.id, msg.params);
      return;
    }

    // Plan approval surface — park on phone when possible; auto-accept if no UI path.
    if (method === "x.ai/exit_plan_mode" && msg.id !== undefined) {
      await this.handleExitPlanMode(live, msg.id, msg.params);
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
  private async handleExitPlanMode(
    live: LiveSession,
    rpcId: number | string,
    params: unknown,
  ): Promise<void> {
    const p = (params ?? {}) as {
      title?: string;
      plan?: unknown;
      options?: Array<{ optionId: string; name: string; kind: string }>;
    };

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
      rpcId,
      source: "grok",
    };

    live.pendingApprovals.set(approvalId, approval);
    live.session.pendingApprovalId = approvalId;
    live.session.status = "awaiting_approval";
    live.session.updatedAt = now();
    this.persist(live.session);

    const { rpcId: _r, source: _s, ...publicApproval } = approval;
    this.emitEvent(live.session, "approval.needed", publicApproval);
    this.emitEvent(live.session, "session.updated", { status: "awaiting_approval" });
    this.maybeNotify("Plan ready for approval", live.session.title);
  }

  private handleAskUserQuestionRequest(
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
      live.client.respond(rpcId, { type: "accepted", answers: [], partial_answers: false });
      return;
    }

    const id = randomUUID();
    const pending: PendingQuestion & { rpcId?: number | string } = {
      id,
      sessionId: live.session.id,
      toolCallId: p.toolCallId,
      title: p.title ?? `Answer ${questions.length} question${questions.length === 1 ? "" : "s"}`,
      questions,
      createdAt: now(),
      rpcId,
      canRespondViaAcp: true,
    };
    live.pendingQuestions.set(id, pending);
    live.session.pendingQuestionId = id;
    const { rpcId: _r, ...publicQ } = pending;
    live.session.pendingQuestion = publicQ;
    live.session.status = "awaiting_question";
    live.session.updatedAt = now();
    this.persist(live.session);
    this.emitEvent(live.session, "question.needed", publicQ);
    this.emitEvent(live.session, "session.updated", { status: "awaiting_question" });
    this.maybeNotify("Grok needs your input", live.session.title);
  }

  /** When tool stream shows AskUserQuestion but extension method was missed/lost. */
  private maybeParkAskUserQuestionFromTool(live: LiveSession, record: ToolCallRecord): void {
    const ri = record.rawInput as { variant?: string; questions?: unknown } | undefined;
    if (!ri || ri.variant !== "AskUserQuestion") return;
    if (record.status === "completed" || record.status === "failed") {
      // Clear soft pending if tool finished
      if (live.session.pendingQuestion?.toolCallId === record.toolCallId) {
        live.session.pendingQuestionId = undefined;
        live.session.pendingQuestion = null;
        if (live.session.status === "awaiting_question") live.session.status = "running";
        this.persist(live.session);
      }
      return;
    }
    // Already have an ACP-backed question
    for (const q of live.pendingQuestions.values()) {
      if (q.rpcId !== undefined) return;
    }
    const questions = normalizeQuestions(ri.questions);
    if (questions.length === 0) return;
    if (live.session.pendingQuestion?.toolCallId === record.toolCallId) return;

    const id = randomUUID();
    const pending: PendingQuestion & { rpcId?: number | string } = {
      id,
      sessionId: live.session.id,
      toolCallId: record.toolCallId,
      title: record.title || `Answer ${questions.length} question${questions.length === 1 ? "" : "s"}`,
      questions,
      createdAt: now(),
      canRespondViaAcp: false,
    };
    live.pendingQuestions.set(id, pending);
    live.session.pendingQuestionId = id;
    live.session.pendingQuestion = pending;
    live.session.status = "awaiting_question";
    live.session.updatedAt = now();
    this.persist(live.session);
    this.emitEvent(live.session, "question.needed", pending);
    this.emitEvent(live.session, "session.updated", { status: "awaiting_question" });
    this.maybeNotify("Grok needs your input", live.session.title);
  }

  private async handlePermissionRequest(
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

    // Never auto-approve AskUserQuestion (needs structured answers, not allow/deny)
    const raw = toolCall as { rawInput?: { variant?: string } };
    if (raw.rawInput?.variant === "AskUserQuestion" || /ask .*question/i.test(toolCall.title ?? "")) {
      // Permission to *show* the questionnaire — allow once, then questions arrive via x.ai/ask_user_question
      // or tool stream. If options look like the questionnaire itself, park them.
      const maybeQs = extractQuestionsFromUnknown(toolCall);
      if (maybeQs.length > 0) {
        this.handleAskUserQuestionRequest(live, rpcId, {
          questions: maybeQs,
          toolCallId: toolCall.toolCallId,
          title: toolCall.title,
        });
        return;
      }
      const allow = options.find((o) => o.kind === "allow_once") ?? options[0];
      if (allow) {
        live.client.respond(rpcId, {
          outcome: { outcome: "selected", optionId: allow.optionId },
        });
      }
      return;
    }

    // Auto-approve safe kinds (reads/searches). Do NOT include "other" if it masks questionnaires —
    // still allow configured kinds except we already special-cased AskUser.
    if (this.config.autoApproveKinds.map((k) => k.toLowerCase()).includes(kind)) {
      const allow = options.find((o) => o.kind === "allow_once" || o.kind === "allow_always") ?? options[0];
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
      options,
      createdAt: now(),
      rpcId,
    };

    live.pendingApprovals.set(approvalId, approval);
    live.session.pendingApprovalId = approvalId;
    live.session.status = "awaiting_approval";
    live.session.updatedAt = now();
    this.persist(live.session);

    const { rpcId: _r, ...publicApproval } = approval;
    this.emitEvent(live.session, "approval.needed", publicApproval);
    this.maybeNotify("Approval needed", `${live.session.title}: ${approval.title}`);
  }

  private flushAssistant(live: LiveSession): void {
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
    this.persist(live.session);
    this.emitEvent(live.session, "transcript", entry);
  }

  private persist(session: DispatchSession): void {
    this.store.save(session);
  }

  private emitEvent(session: DispatchSession, type: SessionEvent["type"], payload: unknown): void {
    const event: SessionEvent = {
      type,
      sessionId: session.id,
      at: now(),
      payload,
    };
    session.events.push(event);
    // Keep event log bounded
    if (session.events.length > 500) {
      session.events = session.events.slice(-400);
    }
    this.emit("event", event);
  }

  private maybeNotify(title: string, message: string): void {
    if (this.config.notifyDesktop ?? this.config.notifyMac) notifyDesktop(title, message);
  }

  async shutdown(): Promise<void> {
    const stops = [...this.live.values()].map((l) => l.client.stop());
    await Promise.allSettled(stops);
    this.live.clear();
  }
}

/** Normalize ACP extension method names (`_x.ai/…` → `x.ai/…`). */
function normalizeAcpMethod(method: string): string {
  if (method.startsWith("_x.ai/")) return "x.ai/" + method.slice("_x.ai/".length);
  if (method.startsWith("_")) {
    // Generic leading underscore used by some agent builds for extensions
    const rest = method.slice(1);
    if (rest.startsWith("x.ai/")) return rest;
  }
  return method;
}

function mapAgentExitError(detail: string | undefined | null): string | null {
  if (!detail) return null;
  const lower = detail.toLowerCase();
  // Nested worker noise often says AuthorizationRequired even while the main
  // session is healthy. Only map to a hard auth message when it looks terminal.
  if (
    lower.includes("authorizationrequired") ||
    lower.includes("auth(authorizationrequired)")
  ) {
    if (lower.includes("worker quit") || lower.includes("transport channel closed")) {
      return (
        "Grok agent worker disconnected (auth/transport). " +
        "Usually transient — reopen the chat to continue. " +
        "If every new session fails immediately, run `grok login` on the Mac."
      );
    }
    return (
      "Grok auth issue on the host (AuthorizationRequired). " +
      "If new sessions fail, run `grok login` on the Mac."
    );
  }
  return null;
}

function rawIsExitPlan(raw: unknown): boolean {
  return Boolean(raw && typeof raw === "object" && (raw as { variant?: string }).variant === "ExitPlanMode");
}

function findClaudeTranscriptPath(sessionId: string): string | undefined {
  const root = join(homedir(), ".claude", "projects");
  if (!existsSync(root)) return undefined;
  for (const proj of readdirSync(root)) {
    const p = join(root, proj, `${sessionId}.jsonl`);
    if (existsSync(p)) return p;
  }
  return undefined;
}

function normalizeQuestions(raw: unknown): AgentQuestion[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((q) => {
      if (!q || typeof q !== "object") return null;
      const o = q as Record<string, unknown>;
      const question = String(o.question ?? o.prompt ?? "").trim();
      if (!question) return null;
      const optionsRaw = Array.isArray(o.options) ? o.options : [];
      const options = optionsRaw
        .map((opt) => {
          if (typeof opt === "string") return { label: opt };
          if (!opt || typeof opt !== "object") return null;
          const oo = opt as Record<string, unknown>;
          const label = String(oo.label ?? oo.name ?? oo.id ?? "").trim();
          if (!label) return null;
          return {
            label,
            description: oo.description != null ? String(oo.description) : undefined,
            preview: oo.preview != null ? String(oo.preview) : undefined,
          };
        })
        .filter((x): x is { label: string; description?: string; preview?: string } => x !== null);
      return {
        question,
        options,
        multiSelect: Boolean(o.multiSelect ?? o.multi_select),
      } as AgentQuestion;
    })
    .filter((x): x is AgentQuestion => x !== null);
}

function extractQuestionsFromUnknown(params: unknown): AgentQuestion[] {
  if (!params || typeof params !== "object") return [];
  const p = params as Record<string, unknown>;
  if (Array.isArray(p.questions)) return normalizeQuestions(p.questions);
  const ri = p.rawInput as Record<string, unknown> | undefined;
  if (ri && Array.isArray(ri.questions)) return normalizeQuestions(ri.questions);
  const tc = p.toolCall as Record<string, unknown> | undefined;
  if (tc) {
    const tri = tc.rawInput as Record<string, unknown> | undefined;
    if (tri && Array.isArray(tri.questions)) return normalizeQuestions(tri.questions);
  }
  return [];
}

function findPendingAskUserTool(s: DispatchSession): PendingQuestion | null {
  for (const t of [...(s.toolCalls ?? [])].reverse()) {
    const ri = t.rawInput as { variant?: string; questions?: unknown } | undefined;
    if (ri?.variant !== "AskUserQuestion") continue;
    if (t.status === "completed" || t.status === "failed") continue;
    const questions = normalizeQuestions(ri.questions);
    if (!questions.length) continue;
    return {
      id: `tool-${t.toolCallId}`,
      sessionId: s.id,
      toolCallId: t.toolCallId,
      title: t.title || "Grok has questions",
      questions,
      createdAt: t.updatedAt || now(),
      canRespondViaAcp: false,
    };
  }
  return null;
}

const MAX_PROMPT_IMAGES = 4;
const MAX_IMAGE_BYTES = 3_500_000; // ~decoded size cap per image

function normalizeImages(images?: PromptImage[]): PromptImage[] {
  if (!images?.length) return [];
  const out: PromptImage[] = [];
  for (const img of images.slice(0, MAX_PROMPT_IMAGES)) {
    if (!img?.data || !img.mimeType) continue;
    const mime = String(img.mimeType).toLowerCase();
    if (!mime.startsWith("image/")) continue;
    // Strip accidental data-URL prefix
    let data = String(img.data).trim();
    const comma = data.indexOf(",");
    if (data.startsWith("data:") && comma >= 0) data = data.slice(comma + 1);
    const approxBytes = Math.floor((data.length * 3) / 4);
    if (approxBytes <= 0 || approxBytes > MAX_IMAGE_BYTES) continue;
    out.push({
      mimeType: mime === "image/jpg" ? "image/jpeg" : mime,
      data,
      name: img.name,
    });
  }
  return out;
}

/** Save attachments under dataDir for Claude path-based access / audit. */
function savePromptImages(dataDir: string, sessionId: string, images: PromptImage[]): string[] {
  if (!images.length) return [];
  const dir = join(dataDir, "sessions", sessionId, "attachments");
  mkdirSync(dir, { recursive: true });
  const paths: string[] = [];
  for (const img of images) {
    const ext =
      img.mimeType.includes("png") ? "png" : img.mimeType.includes("webp") ? "webp" : "jpg";
    const file = join(dir, `${randomUUID()}.${ext}`);
    try {
      writeFileSync(file, Buffer.from(img.data, "base64"));
      paths.push(file);
    } catch (err) {
      console.warn("[attachments] failed to save image:", err);
    }
  }
  return paths;
}
