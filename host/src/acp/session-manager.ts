import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { HostConfigFile } from "../types.js";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentQuestion, AnswerQuestionsRequest, AttachAgyRequest, AttachClaudeRequest, AttachRequest, Bot, DispatchRequest, DispatchSession, PendingApproval, PendingQuestion, PlanEntry, PromptImage, PublicToolCallDetail, SessionEvent, SessionNote, SessionTask, ToolCallRecord, TranscriptEntry, ReviewWorkRequest, TransferProfileRequest } from "../types.js";
import { normalizeExtraDirs, resolveProjectPath } from "../config.js";
import { extraDirsAgentNote, listSessionFiles, readSessionFile } from "../sessions/files.js";
import { SessionStore, toolBlobToJson } from "../sessions/store.js";
import { extractClaudeContext, gitDiff, isGrokHelperCwd, listAgySessions, listClaudeSessions, type DiskSessionHint } from "../sessions/reader.js";
import { notifyDesktop } from "../notify/local.js";
import { allowlistAllowsTool, defaultModelForBackend, grokAgentModelArgs, isGrokBackend, profileProcessEnv, resolveProfile, antigravityAutoApproves } from "../profiles.js";
import { isAuthFailureMessage } from "../login.js";
import { approvalPreview } from "../approval-preview.js";
import { toolOutputSummary } from "../tool-output.js";
import { knownGrokHomes, listGrokHomeSessions } from "../grok-home.js";
import { TombstoneFile } from "./tombstones.js";
import { mcpEnvFor, toAcpMcpServers, writeProfileMcpJson } from "../mcp.js";
import { oauthHeaderMap, refreshAllMcpOAuth } from "../mcp-oauth.js";
import { fetchGrokWeeklyCreditPct } from "../usage.js";
import {
  applyEndTurnCreditSnapshot,
  applyOpenCreditSnapshot,
  shouldSnapshotEndTurnCredits,
} from "../session-meter.js";
import { AcpClient } from "./client.js";
import {
  buildQuestionAnswers,
  exitPlanResult,
  exitPlanVerdictFor,
  questionAcceptedResult,
  questionAnnotationsForComment,
  questionCancelledResult,
  questionChatResult,
} from "./grok-ext.js";
import { ClaudeRunner } from "../claude/runner.js";
import { AntigravityRunner } from "../antigravity/runner.js";
import { runBotSession } from "../bot/runner.js";
import { BotScheduler } from "../bot/scheduler.js";

const execFileAsync = promisify(execFile);

import { APPROVAL_SWEEP_INTERVAL_MS, DEFAULT_APPROVAL_TTL_MS, botTaggedTitle, buildOrphanedApprovalResumePrompt, claudeApprovalSignature, composeGrokOpeningPrompt, drainPendingQuestionsByToolCall, expiresInIso, grokApprovalSignature, isSafeBashCommand, lastUserTextIs, matchesProfileAllowlist, now, shortTitle, shouldFlipToIdleAfterTurn, toolNameFromParkedApproval } from "./session-helpers.js";
import { ensureAttachmentDirs, extractQuestionsFromUnknown, findClaudeTranscriptPath, findPendingAskUserTool, isGrokExitPlanApproval, mapAgentExitError, materializeImagesInCwd, normalizeAcpMethod, normalizeImages, normalizeQuestions, rawIsExitPlan, savePromptImagesForSession } from "./session-support.js";
import type { BotRunState, ClaudeHookApproval, LiveSession } from "./session-helpers.js";
// Public helpers stay importable from here (tests, other modules).
export { buildOrphanedApprovalResumePrompt, composeGrokOpeningPrompt, isSafeBashCommand, lastUserTextIs, drainPendingQuestionsByToolCall, shouldFlipToIdleAfterTurn } from "./session-helpers.js";
export { materializeImagesInCwd, savePromptImagesForSession } from "./session-support.js";

export class SessionManager extends EventEmitter {
  private live = new Map<string, LiveSession>();
  /**
   * Canonical in-memory session objects. Claude/Antigravity turns are not in
   * `live` (that's ACP), so `get()` used to `store.load()` a fresh copy every
   * call. `createClaudeApproval` would park pendingApproval on copy A, then
   * `claudeTurn`'s `runner.on("tool")` persist of copy B would wipe it — the
   * phone never saw Approve, the hook timed out after 10m, and the model
   * reported the tool as denied.
   */
  private hydrated = new Map<string, DispatchSession>();
  /** Claude PreToolUse hook approvals (polled by hook process). */
  private claudeApprovals = new Map<string, ClaudeHookApproval>();
  /** Active headless CLI runners (Claude / Antigravity) so cancel can SIGTERM them. */
  private cliRunners = new Map<string, { stop: () => void }>();
  /** In-process bot loops (no child process). */
  private botRuns = new Map<string, BotRunState>();
  readonly store: SessionStore;
  private approvalSweeper?: ReturnType<typeof setInterval>;
  /** Highest seq number emitted per session. Ensures replay is consistent
   *  across host restarts by re-initializing from persisted events. */
  private eventSeq = new Map<string, number>();
  /** Set by the server layer so `maybeNotify` can skip shell-based desktop
   *  notifications when a local Mac client (loopback WS) is already going to
   *  post its own richer local notification. Prevents duplicate banners. */
  private hasLocalClientCheck?: () => boolean;
  /** Tombstone set of Grok session IDs the user has explicitly deleted, so
   *  syncGrokDiskSessions doesn't re-import them from ~/.grok/sessions on
   *  every list refresh. Persisted to <dataDir>/deleted-grok-sessions.json. */
  private readonly forgottenGrok: TombstoneFile;
  /** Tombstone set of Claude session IDs the user has explicitly deleted, so
   *  their `.jsonl` files at ~/.claude/projects don't come back as attach
   *  hints on every list refresh. Persisted to
   *  <dataDir>/deleted-claude-sessions.json. */
  private readonly forgottenClaude: TombstoneFile;
  private readonly forgottenAgy: TombstoneFile;

  constructor(private readonly config: HostConfigFile) {
    super();
    this.store = new SessionStore(config.dataDir);
    this.forgottenGrok = new TombstoneFile(join(config.dataDir, "deleted-grok-sessions.json"), "grokSessionId");
    this.forgottenClaude = new TombstoneFile(join(config.dataDir, "deleted-claude-sessions.json"), "claudeSessionId");
    this.forgottenAgy = new TombstoneFile(join(config.dataDir, "deleted-agy-sessions.json"), "conversationId");
    this.startApprovalSweeper();
  }

  /**
   * After an orphaned approval (agent died / host restarted), kick a follow-up
   * so Approve actually continues work instead of parking the session.
   * Tests replace this to avoid spawning an agent.
   */
  resumeOrphanedSession = (sessionId: string, prompt: string): void => {
    this.trackDetachedTurn(sessionId, this.followUp(sessionId, prompt));
  };

  /** True if this Grok session was previously deleted by the user. */
  isForgottenGrokSession(grokSessionId: string | undefined | null): boolean {
    return this.forgottenGrok.has(grokSessionId);
  }

  isForgottenClaudeSession(claudeSessionId: string | undefined | null): boolean {
    return this.forgottenClaude.has(claudeSessionId);
  }

  isForgottenAgySession(conversationId: string | undefined | null): boolean {
    return this.forgottenAgy.has(conversationId);
  }

  /** For graceful shutdown / tests. */
  stopApprovalSweeper(): void {
    if (this.approvalSweeper) {
      clearInterval(this.approvalSweeper);
      this.approvalSweeper = undefined;
    }
  }

  private startApprovalSweeper(): void {
    this.approvalSweeper = setInterval(() => {
      try {
        this.sweepExpiredApprovals();
      } catch (err) {
        console.error("[sweeper] failed:", err);
      }
    }, APPROVAL_SWEEP_INTERVAL_MS);
    // Don't hold the event loop open just for sweeping.
    this.approvalSweeper.unref?.();
  }

  /**
   * Walk every live session and force-expire approvals/questions whose
   * `expiresAt` has passed. Prevents the "stuck for weeks in awaiting_*
   * because the phone never got the notification" failure mode.
   */
  private sweepExpiredApprovals(): void {
    const nowMs = Date.now();
    for (const [, live] of this.live) {
      for (const [aid, approval] of live.pendingApprovals) {
        const exp = approval.expiresAt ? Date.parse(approval.expiresAt) : NaN;
        if (!Number.isFinite(exp) || exp > nowMs) continue;
        this.expireApproval(live, aid, approval);
      }
      for (const [qid, question] of live.pendingQuestions) {
        const exp = question.expiresAt ? Date.parse(question.expiresAt) : NaN;
        if (!Number.isFinite(exp) || exp > nowMs) continue;
        this.expireQuestion(live, qid, question);
      }
    }
    for (const [sid, run] of this.botRuns) {
      if (!run.pending) continue;
      const session = this.get(sid);
      const approval = session?.pendingApproval;
      if (!approval || approval.id !== run.pending.approvalId) continue;
      const exp = approval.expiresAt ? Date.parse(approval.expiresAt) : NaN;
      if (!Number.isFinite(exp) || exp > nowMs) continue;
      const pending = run.pending;
      run.pending = undefined;
      pending.resolve({ decision: "reject", comment: "expired" });
    }
  }

  private expireApproval(
    live: LiveSession,
    approvalId: string,
    approval: PendingApproval & { rpcId?: number | string; source?: "grok" | "claude" },
  ): void {
    console.log(
      `[sweeper] expiring approval session=${live.session.id.slice(0, 8)} id=${approvalId.slice(0, 8)} title="${approval.title}"`,
    );
    if (approval.rpcId !== undefined) {
      try {
        if (isGrokExitPlanApproval(approval)) {
          // Timeout with no tap: abandon so Grok actually leaves plan mode.
          live.client.respond(approval.rpcId, exitPlanResult(exitPlanVerdictFor("expire")));
          live.session.planMode = false;
        } else {
          const rejectOpt =
            approval.options.find((o) => o.kind === "reject_once") ?? approval.options[0];
          live.client.respond(approval.rpcId, {
            outcome: { outcome: "selected", optionId: rejectOpt?.optionId ?? "reject-once" },
          });
        }
      } catch {
        /* client may already be dead */
      }
    }
    live.pendingApprovals.delete(approvalId);
    if (live.session.pendingApprovalId === approvalId) {
      live.session.pendingApprovalId = undefined;
      live.session.pendingApproval = null;
    }
    if (
      live.session.status === "awaiting_approval" &&
      live.pendingApprovals.size === 0 &&
      live.pendingQuestions.size === 0
    ) {
      live.session.status = "idle";
    }
    live.session.updatedAt = now();
    const note: TranscriptEntry = {
      id: randomUUID(),
      role: "system",
      text: `Approval "${approval.title}" expired without a decision — auto-rejected. Re-open the session to try again.`,
      at: now(),
    };
    live.session.transcript.push(note);
    this.persist(live.session);
    this.emitEvent(live.session, "transcript", note);
    this.emitEvent(live.session, "approval.resolved", {
      approvalId,
      decision: "reject",
      reason: "expired",
    });
  }

  private expireQuestion(
    live: LiveSession,
    questionId: string,
    question: PendingQuestion & { rpcId?: number | string },
  ): void {
    console.log(
      `[sweeper] expiring question session=${live.session.id.slice(0, 8)} id=${questionId.slice(0, 8)} title="${question.title}"`,
    );
    if (question.rpcId !== undefined) {
      try {
        live.client.respond(question.rpcId, questionCancelledResult());
      } catch {
        /* client may already be dead */
      }
    }
    live.pendingQuestions.delete(questionId);
    if (live.session.pendingQuestionId === questionId) {
      live.session.pendingQuestionId = undefined;
      live.session.pendingQuestion = null;
    }
    if (
      live.session.status === "awaiting_question" &&
      live.pendingApprovals.size === 0 &&
      live.pendingQuestions.size === 0
    ) {
      live.session.status = "idle";
    }
    live.session.updatedAt = now();
    const note: TranscriptEntry = {
      id: randomUUID(),
      role: "system",
      text: `Question "${question.title}" expired without an answer — auto-skipped. Re-open the session to try again.`,
      at: now(),
    };
    live.session.transcript.push(note);
    this.persist(live.session);
    this.emitEvent(live.session, "transcript", note);
    this.emitEvent(live.session, "question.answered", {
      questionId,
      via: "expired",
    });
  }

  list(): DispatchSession[] {
    const disk = this.store.list();
    // Overlay the in-memory object (ACP live, or hydrated Claude/agy turn).
    return disk.map((s) => this.live.get(s.id)?.session ?? this.hydrated.get(s.id) ?? s);
  }

  /**
   * Canonical in-memory session. Idle mutations must `persist()` this object
   * so `list()` (hydrated overlay) matches disk. Loading a fresh store copy
   * and `store.save`ing it leaves the overlay stale — Close as done / Archive
   * then look like no-ops.
   */
  private loadMutable(sessionId: string): DispatchSession {
    const s = this.get(sessionId);
    if (!s) throw new Error("Session not found");
    return s;
  }

  get(id: string): DispatchSession | null {
    const live = this.live.get(id)?.session;
    if (live) {
      this.hydrated.set(id, live);
      return this.rehydrateQuestionUi(live);
    }
    const cached = this.hydrated.get(id);
    if (cached) return this.rehydrateQuestionUi(cached);
    const loaded = this.store.load(id);
    if (!loaded) return null;
    this.hydrated.set(id, loaded);
    return this.rehydrateQuestionUi(loaded);
  }

  private rehydrateQuestionUi(s: DispatchSession): DispatchSession {
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
    const session = this.get(sessionId);
    const id = session?.pendingApprovalId;
    if (!id) {
      return this.pendingClaudeHookApproval(sessionId);
    }

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
    // Orphaned approval loaded from disk (host restarted between creation and
    // resolution). Serve the persisted snapshot so the phone can still show it
    // and Approve can auto-resume via resolveApproval.
    if (session?.pendingApproval && session.pendingApproval.id === id) {
      return session.pendingApproval;
    }
    return this.pendingClaudeHookApproval(sessionId);
  }

  /** Last-resort: in-memory hook still pending even if disk lost pendingApprovalId. */
  private pendingClaudeHookApproval(sessionId: string): PendingApproval | null {
    let found: ClaudeHookApproval | undefined;
    for (const hook of this.claudeApprovals.values()) {
      if (hook.sessionId === sessionId && hook.status === "pending") {
        if (!found || hook.createdAt > found.createdAt) found = hook;
      }
    }
    if (!found) return null;
    return {
      id: found.id,
      sessionId: found.sessionId,
      title: found.title,
      kind: found.toolName.toLowerCase().includes("bash") ? "execute" : "edit",
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
      createdAt: found.createdAt,
      rawInput: found.toolInput,
    };
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
    const imgs = normalizeImages(req.images);
    const text = (req.prompt ?? "").trim();
    if (!text && imgs.length === 0) throw new Error("prompt or images required");

    const profile = resolveProfile(this.config, req.profileId);
    const { path: cwd, projectId } = resolveProjectPath(this.config, req.projectId, req.cwd);
    const isBotRun = Boolean(req.botId);
    const backend = isBotRun ? "bot" : profile.backend;
    // CLI backends never use Grok plan-mode / worktree meta — ignore client flags that would confuse UI.
    const grokMeta = isGrokBackend(backend);
    const planMode = grokMeta ? Boolean(req.planMode) : false;
    const worktree = grokMeta ? Boolean(req.worktree) : false;
    const subagents = grokMeta ? (req.subagents ?? true) : false;

    const id = randomUUID();
    const createdAt = now();
    const model =
      req.model ??
      (isBotRun ? "grok-4" : profile.model) ??
      defaultModelForBackend(backend);

    const promptText =
      text ||
      (imgs.length === 1
        ? "Please review this screenshot for debugging."
        : `Please review these ${imgs.length} screenshots for debugging.`);
    const userText =
      imgs.length === 0
        ? promptText
        : `📷 ${imgs.length} screenshot${imgs.length === 1 ? "" : "s"}${text ? `\n${text}` : ""}`;
    const rawTitle = shortTitle(promptText, req.title);
    const session: DispatchSession = {
      id,
      backend,
      botId: req.botId,
      profileId: profile.id,
      profileName: profile.name,
      profileColor: profile.color,
      title: isBotRun ? botTaggedTitle(rawTitle) : rawTitle,
      prompt: promptText,
      cwd,
      extraDirs: normalizeExtraDirs(this.config, cwd, req.extraDirs),
      projectId,
      model,
      planMode,
      subagents,
      worktree,
      status: "queued",
      createdAt,
      updatedAt: createdAt,
      transcript: [
        {
          id: randomUUID(),
          role: "user",
          text: userText,
          at: createdAt,
        },
      ],
      toolCalls: [],
      events: [],
    };

    this.store.save(session);
    this.emitEvent(session, "session.created", { session: this.store.toSummary(session) });
    console.log(
      `[dispatch] profile=${profile.id} (${profile.name}) backend=${profile.backend} model=${model} ` +
        `cwd=${cwd} planMode=${planMode} worktree=${worktree} session=${id.slice(0, 8)}`,
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
    return this.live.has(sessionId) || this.botRuns.has(sessionId) || this.cliRunners.has(sessionId);
  }

  /** Full tool-call payload for the client ellipsis sheet (capped rawInput/content as JSON). */
  getToolCall(sessionId: string, toolCallId: string): PublicToolCallDetail | null {
    const s = this.get(sessionId);
    if (!s) return null;
    const t = (s.toolCalls ?? []).find((x) => x.toolCallId === toolCallId);
    if (!t) return null;
    return {
      toolCallId: t.toolCallId,
      title: t.title,
      kind: t.kind,
      status: t.status,
      updatedAt: t.updatedAt,
      locations: t.locations,
      rawInputJson: toolBlobToJson(t.rawInput),
      contentJson: toolBlobToJson(t.content),
    };
  }

  /**
   * Continue a conversation. Re-attaches the ACP process + loads the Grok
   * session from disk if the host restarted or the process died.
   * Claude / Antigravity sessions use headless CLI (`-p` + resume) per turn.
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

    // Backend-specific turn runners each block for the entire agent response.
    // We return the session snapshot to the caller as soon as the user's
    // message is persisted, and let the turn run in the background — WS
    // events drive the UI from here on out. Prevents the iOS 90 s
    // URLSession timeout error the user was seeing on long turns.
    if (session.backend === "claude") {
      // claudeTurn does its own user-entry push + persist internally; kick it
      // off detached so we can return immediately.
      const p = this.claudeTurn(sessionId, text || displayText, imgs);
      this.trackDetachedTurn(sessionId, p);
      return this.get(sessionId) ?? session;
    }
    if (session.backend === "antigravity") {
      const p = this.antigravityTurn(sessionId, text || displayText, imgs);
      this.trackDetachedTurn(sessionId, p);
      return this.get(sessionId) ?? session;
    }
    if (session.backend === "bot") {
      const p = this.botTurn(session, text || displayText, true);
      this.trackDetachedTurn(sessionId, p);
      return this.get(sessionId) ?? session;
    }

    // After Claude→Grok transfer there is no grokSessionId yet — open a fresh ACP session.
    const live = session.grokSessionId
      ? await this.ensureLive(sessionId)
      : await this.ensureLiveOrCreate(sessionId);

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

    let agentText = text || displayText;
    if (live.session.transferHandoffPending) {
      agentText = this.buildTransferHandoffPrompt(live.session, agentText);
      live.session.transferHandoffPending = false;
      this.persist(live.session);
    }
    agentText = extraDirsAgentNote(live.session.extraDirs) + agentText;

    // Run the ACP turn in the background; return the session snapshot with
    // the user's entry immediately so the phone doesn't hit URLSession's
    // request timeout on long-running turns.
    const promptPromise = this.promptTurn(live, agentText, imgs);
    this.trackDetachedTurn(sessionId, promptPromise);
    return live.session;
  }

  /** Log and surface errors from a background agent turn. */
  private trackDetachedTurn(sessionId: string, p: Promise<unknown>): void {
    p.catch((err) => {
      console.error(
        `[session ${sessionId.slice(0, 8)}] detached turn failed:`,
        err instanceof Error ? err.message : err,
      );
      // promptTurn/claudeTurn/antigravityTurn already emit session.failed on
      // internal errors; this catch just prevents an unhandled rejection when
      // the promise is truly detached from any awaiter.
    });
  }

  /**
   * Open an existing Grok Build session (from TUI / headless / prior Dispatch)
   * so the phone can keep chatting in that context.
   */
  /**
   * Pull every Grok Build session under ~/.grok/sessions into the Dispatch store
   * (idempotent). Does **not** spawn ACP — first follow-up / attach does ensureLive.
   * That way the phone/Mac list matches the Grok TUI without paying spawn cost up front.
   */
  /** Tests replace this to avoid reading ~/.grok/sessions. */
  /**
   * Grok sessions on disk across every known Grok home (RFC-048): the TUI's
   * `~/.grok` and each profile's isolated home. Newest wins on id collisions.
   */
  listGrokDiskSessions = (limit = 200): DiskSessionHint[] =>
    listGrokHomeSessions(knownGrokHomes(this.config.profiles ?? [], this.config.dataDir), limit);

  syncGrokDiskSessions(limit = 200): { imported: number; totalDisk: number } {
    const hints = this.listGrokDiskSessions(limit);
    const linked = new Set(
      this.list()
        .map((s) => s.grokSessionId)
        .filter((id): id is string => Boolean(id)),
    );
    const forgotten = this.forgottenGrok.load();
    // RFC-048: backfill where already-imported sessions live, so resume uses
    // the right GROK_HOME (they were all attached to the default profile).
    const byGrokId = new Map(hints.map((h) => [h.id, h]));
    for (const s of this.list()) {
      const h = s.grokSessionId ? byGrokId.get(s.grokSessionId) : undefined;
      if (h?.grokHome && s.grokHome !== h.grokHome) {
        s.grokHome = h.grokHome;
        // Label only homes that aren't a profile's own (the profile chip says that).
        s.grokHomeLabel = h.profileId ? undefined : h.grokHomeLabel;
        this.persist(s);
      }
    }
    let imported = 0;
    for (const hint of hints) {
      if (!hint.id || linked.has(hint.id)) continue;
      if (forgotten.has(hint.id)) continue;
      if (!hint.cwd?.trim()) continue;
      // Subagent worktrees are not operator sessions — don't wrap them.
      if (isGrokHelperCwd(hint.cwd)) continue;
      this.importGrokDiskHint(hint);
      linked.add(hint.id);
      imported++;
    }
    return { imported, totalDisk: hints.length };
  }

  /** Create a store row for a Grok TUI session without spawning the agent yet. */
  private importGrokDiskHint(hint: DiskSessionHint): DispatchSession {
    // RFC-048: a session from a profile's own home belongs to that profile.
    const profile = resolveProfile(this.config, hint.profileId, "grok");
    const createdAt = hint.updatedAt ?? now();
    const title = shortTitle(hint.title ?? "Grok Build session", hint.title);
    const session: DispatchSession = {
      id: randomUUID(),
      backend: "grok",
      profileId: profile.id,
      profileName: profile.name,
      profileColor: profile.color,
      grokSessionId: hint.id,
      grokHome: hint.grokHome,
      grokHomeLabel: hint.profileId ? undefined : hint.grokHomeLabel,
      title,
      prompt: hint.title?.trim() || `Grok Build session ${hint.id.slice(0, 8)}`,
      cwd: hint.cwd!.trim(),
      model: hint.model ?? profile.model ?? "grok-build",
      planMode: false,
      subagents: true,
      worktree: false,
      status: "idle",
      createdAt,
      updatedAt: createdAt,
      transcript: [
        {
          id: randomUUID(),
          role: "system",
          text: `Imported from Grok Build (on disk). Send a message to re-open this session remotely.`,
          at: createdAt,
        },
      ],
      toolCalls: [],
      events: [],
    };
    this.store.save(session);
    return session;
  }

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

  /**
   * Open an Antigravity / Gemini CLI conversation (`agy --conversation <id>`).
   * Does not parse the sqlite trajectory; the CLI holds history.
   */
  async attachAgy(req: AttachAgyRequest): Promise<DispatchSession> {
    const agyId = req.conversationId?.trim();
    if (!agyId) throw new Error("conversationId is required");
    if (!req.cwd?.trim()) throw new Error("cwd is required");

    const existing = this.list().find((s) => s.antigravityConversationId === agyId);
    if (existing) {
      if (req.prompt?.trim()) return this.followUp(existing.id, req.prompt.trim());
      return existing;
    }

    let profile = req.profileId
      ? resolveProfile(this.config, req.profileId)
      : resolveProfile(this.config, undefined, "antigravity");
    if (profile.backend !== "antigravity") {
      profile = resolveProfile(this.config, undefined, "antigravity");
    }
    if (profile.backend !== "antigravity") {
      throw new Error("No Antigravity / Gemini profile on this host — add one in Profiles.");
    }

    const hint = listAgySessions(200).find((s) => s.id === agyId);
    const id = randomUUID();
    const createdAt = now();
    const title =
      req.title?.trim() ||
      hint?.title ||
      `Gemini ${agyId.slice(0, 8)}`;
    const session: DispatchSession = {
      id,
      backend: "antigravity",
      profileId: profile.id,
      profileName: profile.name,
      profileColor: profile.color,
      antigravityConversationId: agyId,
      title: shortTitle(req.prompt ?? title, req.title ?? title),
      prompt: req.prompt?.trim() || `(Gemini CLI conversation ${agyId.slice(0, 8)})`,
      cwd: req.cwd.trim(),
      model: profile.model ?? "antigravity",
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
            `Attached Gemini CLI conversation ${agyId} as ${profile.name}. ` +
            `Follow-ups resume with agy --conversation. History stays in the CLI.`,
          at: createdAt,
        },
      ],
      toolCalls: [],
      events: [],
    };
    this.store.save(session);
    this.emitEvent(session, "session.created", {
      session: this.store.toSummary(session),
      attached: true,
      backend: "antigravity",
    });
    if (req.prompt?.trim()) {
      return this.antigravityTurn(id, req.prompt.trim());
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

    const profile = this.profileFor(session);

    // Pre-flight: profile.toolAllowlist names the only tools this account may
    // invoke. Deny in the hook so Write never reaches the phone.
    if (
      profile?.toolAllowlist?.length &&
      !allowlistAllowsTool(profile.toolAllowlist, { toolName: body.toolName })
    ) {
      approval.status = "rejected";
      approval.comment = `${body.toolName} is not on this profile's toolAllowlist`;
      console.log(
        `[approvals] deny toolAllowlist session=${body.sessionId.slice(0, 8)} ` +
          `profile=${profile.id} tool=${body.toolName}`,
      );
      return approval;
    }

    // Fast-path #1: Safe bash commands (git status, ls, cat, etc.) never
    // need to bother the phone.
    if (body.toolName.toLowerCase() === "bash") {
      const cmd = String((body.toolInput as { command?: unknown } | undefined)?.command ?? "");
      if (isSafeBashCommand(cmd)) {
        approval.status = "approved";
        console.log(
          `[approvals] auto-approve safe-bash session=${body.sessionId.slice(0, 8)} cmd="${cmd.slice(0, 80)}"`,
        );
        return approval;
      }
    }

    // Fast-path #2: session-scoped "always this session" allowlist.
    const sig = claudeApprovalSignature(body.toolName, body.toolInput);
    if (session.autoApproveSignatures?.includes(sig)) {
      approval.status = "approved";
      console.log(
        `[approvals] auto-approve session-allowlist session=${body.sessionId.slice(0, 8)} sig="${sig}"`,
      );
      return approval;
    }

    // Fast-path #3: profile-scoped auto-approve signatures (persist across sessions).
    // Entries are either exact signatures (e.g. `claude:bash:git status`) or a
    // shorthand tool prefix (`claude:bash` matches every bash invocation).
    if (
      profile?.autoApprovalSignatures?.length &&
      matchesProfileAllowlist(sig, profile.autoApprovalSignatures)
    ) {
      approval.status = "approved";
      console.log(
        `[approvals] auto-approve profile-allowlist session=${body.sessionId.slice(0, 8)} ` +
          `profile=${profile.id} sig="${sig}"`,
      );
      return approval;
    }

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
      expiresAt: expiresInIso(DEFAULT_APPROVAL_TTL_MS),
      rawInput: body.toolInput,
      preview: approvalPreview(body.toolInput),
    };

    // Park on session for phone UI even without ACP live client
    session.pendingApprovalId = id;
    session.pendingApproval = publicApproval;
    session.status = "awaiting_approval";
    session.updatedAt = now();
    this.persist(session);

    // Also stash if grok live map has entry
    const live = this.live.get(body.sessionId);
    if (live) {
      live.pendingApprovals.set(id, { ...publicApproval, source: "claude" });
    }

    console.log(
      `[approvals] park claude session=${body.sessionId.slice(0, 8)} tool=${body.toolName} title="${approval.title.slice(0, 80)}"`,
    );
    this.emitEvent(session, "approval.needed", publicApproval);
    this.emitEvent(session, "session.updated", { status: "awaiting_approval" });
    this.maybeNotify("Claude needs approval", `${session.title}: ${approval.title}`);
    return approval;
  }

  getClaudeApproval(approvalId: string): ClaudeHookApproval | null {
    return this.claudeApprovals.get(approvalId) ?? null;
  }

  async cancel(sessionId: string): Promise<DispatchSession> {
    const botRun = this.botRuns.get(sessionId);
    if (botRun) {
      botRun.cancelled = true;
      botRun.abort.abort("cancelled");
      if (botRun.pending) {
        botRun.pending.reject(new Error("cancelled"));
        botRun.pending = undefined;
      }
      this.botRuns.delete(sessionId);
      const s = this.get(sessionId);
      if (s) {
        s.status = "cancelled";
        s.pendingApprovalId = undefined;
        s.pendingApproval = null;
        s.updatedAt = now();
        s.completedAt = now();
        this.persist(s);
        this.emitEvent(s, "session.completed", { status: "cancelled" });
        return s;
      }
    }

    const live = this.live.get(sessionId);
    if (live) {
      // Cancel pending approvals
      for (const [aid, approval] of live.pendingApprovals) {
        if (approval.rpcId !== undefined) {
          if (isGrokExitPlanApproval(approval)) {
            live.client.respond(approval.rpcId, exitPlanResult(exitPlanVerdictFor("cancel")));
          } else {
            live.client.respond(approval.rpcId, { outcome: { outcome: "cancelled" } });
          }
        }
        live.pendingApprovals.delete(aid);
      }
      // Cancel pending questions — without this the agent's ask_user_question RPC
      // hangs forever after the session is cancelled.
      for (const [qid, question] of live.pendingQuestions) {
        if (question.rpcId !== undefined) {
          try {
            live.client.respond(question.rpcId, questionCancelledResult());
          } catch {
            /* ignore — client may already be torn down */
          }
        }
        live.pendingQuestions.delete(qid);
      }
      live.session.pendingApprovalId = undefined;
      live.session.pendingApproval = null;
      live.session.pendingQuestionId = undefined;
      live.session.pendingQuestion = null;
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

    // Headless Claude / Antigravity — stop the child process if still running
    const cli = this.cliRunners.get(sessionId);
    if (cli) {
      try {
        cli.stop();
      } catch {
        /* ignore */
      }
      this.cliRunners.delete(sessionId);
    }

    const s = this.loadMutable(sessionId);
    s.status = "cancelled";
    s.updatedAt = now();
    s.completedAt = now();
    this.persist(s);
    this.emitEvent(s, "session.completed", { status: "cancelled" });
    return s;
  }

  /**
   * Close a session as successfully done — semantically distinct from cancel.
   * Shuts down the agent process the same way `cancel` does (clearing pending
   * approvals/questions, killing the ACP client), but marks status as
   * `completed` (not `cancelled`) and archives the session so it drops off
   * the active list. Use for "I've reached a natural stopping point and
   * this session is finished."
   */
  async closeAsDone(sessionId: string): Promise<DispatchSession> {
    const botRun = this.botRuns.get(sessionId);
    if (botRun) {
      botRun.cancelled = true;
      botRun.abort.abort("cancelled");
      if (botRun.pending) {
        botRun.pending.reject(new Error("closed"));
        botRun.pending = undefined;
      }
      this.botRuns.delete(sessionId);
      const s = this.get(sessionId);
      if (s) {
        s.status = "completed";
        s.archived = true;
        s.archivedAt = now();
        s.pendingApprovalId = undefined;
        s.pendingApproval = null;
        s.updatedAt = now();
        s.completedAt = now();
        this.persist(s);
        this.emitEvent(s, "session.completed", { status: "completed", archived: true, via: "closeAsDone" });
        return s;
      }
    }

    const live = this.live.get(sessionId);
    if (live) {
      for (const [aid, approval] of live.pendingApprovals) {
        if (approval.rpcId !== undefined) {
          try {
            if (isGrokExitPlanApproval(approval)) {
              live.client.respond(approval.rpcId, exitPlanResult(exitPlanVerdictFor("cancel")));
            } else {
              live.client.respond(approval.rpcId, { outcome: { outcome: "cancelled" } });
            }
          } catch { /* client may be dead */ }
        }
        live.pendingApprovals.delete(aid);
      }
      for (const [qid, question] of live.pendingQuestions) {
        if (question.rpcId !== undefined) {
          try {
            live.client.respond(question.rpcId, questionCancelledResult());
          } catch { /* ignore */ }
        }
        live.pendingQuestions.delete(qid);
      }
      live.session.pendingApprovalId = undefined;
      live.session.pendingApproval = null;
      live.session.pendingQuestionId = undefined;
      live.session.pendingQuestion = null;
      try {
        live.client.notify("session/cancel", { sessionId: live.session.grokSessionId });
      } catch { /* ignore */ }
      live.session.status = "completed";
      live.session.archived = true;
      live.session.archivedAt = now();
      live.session.updatedAt = now();
      live.session.completedAt = now();
      this.persist(live.session);
      this.emitEvent(live.session, "session.completed", {
        status: "completed",
        archived: true,
        via: "closeAsDone",
      });
      await live.client.stop();
      this.live.delete(sessionId);
      return live.session;
    }

    const cli = this.cliRunners.get(sessionId);
    if (cli) {
      try { cli.stop(); } catch { /* ignore */ }
      this.cliRunners.delete(sessionId);
    }

    const s = this.loadMutable(sessionId);
    s.status = "completed";
    s.archived = true;
    s.archivedAt = now();
    s.updatedAt = now();
    s.completedAt = now();
    this.persist(s);
    this.emitEvent(s, "session.completed", {
      status: "completed",
      archived: true,
      via: "closeAsDone",
    });
    return s;
  }

  /**
   * Permanently delete a session. If it's live, cancel first. Purges the
   * session JSON, the session's attachments dir, and (implicitly) its own
   * tasks/notes (they live on the session record). Project attachments that
   * were `fromSessionId` this session are left in place — once promoted to
   * a project they're independent resources.
   */
  async deleteSession(sessionId: string): Promise<void> {
    // If live, shut down first so we don't orphan an agent process.
    if (this.live.has(sessionId) || this.cliRunners.has(sessionId)) {
      try { await this.cancel(sessionId); } catch { /* ignore */ }
    }
    const s = this.store.load(sessionId);
    if (!s) throw new Error("Session not found");
    // Remove the session's on-disk directory (attachments) and JSON file.
    try {
      const dir = join(this.config.dataDir, "sessions", sessionId);
      rmSync(dir, { recursive: true, force: true });
    } catch { /* ignore */ }
    try {
      const file = join(this.config.dataDir, "sessions", `${sessionId}.json`);
      rmSync(file, { force: true });
    } catch { /* ignore */ }
    // Tombstone the underlying Grok session so /sessions doesn't re-import it
    // from ~/.grok/sessions on the next list refresh.
    this.forgottenGrok.add(s.grokSessionId);
    // Same for the underlying Claude jsonl and Antigravity conversation —
    // otherwise they come back as attach hints on the next list refresh.
    this.forgottenClaude.add(s.claudeSessionId);
    this.forgottenAgy.add(s.antigravityConversationId);
    // Emit a terminal event so open clients drop it from their lists.
    this.emitEvent(s, "session.completed", {
      status: "cancelled",
      deleted: true,
    });
    this.hydrated.delete(sessionId);
    this.eventSeq.delete(sessionId);
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
    const s = this.loadMutable(sessionId);
    s.title = trimmed.slice(0, 200);
    s.updatedAt = now();
    this.persist(s);
    this.emitEvent(s, "session.updated", { title: s.title });
    return s;
  }

  /**
   * Set (or clear) a session's projectId. Validates the target project
   * exists and is non-archived. Doesn't change the session's cwd — user
   * can pick a path from the project's list on the next turn if they want.
   * Pass an empty / undefined projectId to detach the session.
   */
  setSessionProject(sessionId: string, projectId: string | null | undefined): DispatchSession {
    const target = projectId?.trim() || null;
    if (target) {
      const project = (this.config.projects ?? []).find((p) => p.id === target);
      if (!project) throw new Error(`Project "${target}" not found`);
      if (project.archived) throw new Error(`Project "${project.name}" is archived`);
    }
    const live = this.live.get(sessionId);
    if (live) {
      live.session.projectId = target ?? undefined;
      live.session.updatedAt = now();
      this.persist(live.session);
      this.emitEvent(live.session, "session.updated", { projectId: live.session.projectId });
      return live.session;
    }
    const s = this.loadMutable(sessionId);
    s.projectId = target ?? undefined;
    s.updatedAt = now();
    this.persist(s);
    this.emitEvent(s, "session.updated", { projectId: s.projectId });
    return s;
  }

  // ── Tasks + Notes CRUD ────────────────────────────────────────────

  /**
   * Add a user-captured action item to a session. Text is trimmed; empty
   * text is rejected. Persists on the session.tasks array and emits
   * `task.created` so open clients update in real time.
   */
  createTask(
    sessionId: string,
    body: { text: string; sourceMessageId?: string },
  ): SessionTask {
    const text = (body.text ?? "").trim();
    if (!text) throw new Error("text is required");
    const session = this.getMutableSession(sessionId);
    const task: SessionTask = {
      id: randomUUID(),
      sourceSessionId: sessionId,
      sourceMessageId: body.sourceMessageId,
      projectId: session.projectId,
      text,
      status: "open",
      createdAt: now(),
    };
    session.tasks = [...(session.tasks ?? []), task];
    session.updatedAt = now();
    this.persist(session);
    this.emitEvent(session, "task.created", task);
    return task;
  }

  updateTask(
    sessionId: string,
    taskId: string,
    body: { text?: string; status?: "open" | "done" },
  ): SessionTask {
    const session = this.getMutableSession(sessionId);
    const tasks = session.tasks ?? [];
    const idx = tasks.findIndex((t) => t.id === taskId);
    if (idx < 0) throw new Error("Task not found");
    const cur = tasks[idx]!;
    const next: SessionTask = {
      ...cur,
      text: body.text !== undefined ? body.text.trim() || cur.text : cur.text,
      status: body.status ?? cur.status,
      updatedAt: now(),
      completedAt:
        body.status === "done"
          ? (cur.completedAt ?? now())
          : body.status === "open"
            ? undefined
            : cur.completedAt,
    };
    tasks[idx] = next;
    session.tasks = tasks;
    session.updatedAt = now();
    this.persist(session);
    this.emitEvent(session, "task.updated", next);
    return next;
  }

  deleteTask(sessionId: string, taskId: string): void {
    const session = this.getMutableSession(sessionId);
    const before = session.tasks?.length ?? 0;
    session.tasks = (session.tasks ?? []).filter((t) => t.id !== taskId);
    if ((session.tasks?.length ?? 0) === before) throw new Error("Task not found");
    session.updatedAt = now();
    this.persist(session);
    this.emitEvent(session, "task.deleted", { taskId });
  }

  createNote(
    sessionId: string,
    body: { text: string; sourceMessageId?: string },
  ): SessionNote {
    const text = (body.text ?? "").trim();
    if (!text) throw new Error("text is required");
    const session = this.getMutableSession(sessionId);
    const note: SessionNote = {
      id: randomUUID(),
      sourceSessionId: sessionId,
      sourceMessageId: body.sourceMessageId,
      text,
      createdAt: now(),
    };
    session.notes = [...(session.notes ?? []), note];
    session.updatedAt = now();
    this.persist(session);
    this.emitEvent(session, "note.created", note);
    return note;
  }

  updateNote(
    sessionId: string,
    noteId: string,
    body: { text?: string },
  ): SessionNote {
    const session = this.getMutableSession(sessionId);
    const notes = session.notes ?? [];
    const idx = notes.findIndex((n) => n.id === noteId);
    if (idx < 0) throw new Error("Note not found");
    const cur = notes[idx]!;
    const next: SessionNote = {
      ...cur,
      text: body.text !== undefined ? body.text.trim() || cur.text : cur.text,
      updatedAt: now(),
    };
    notes[idx] = next;
    session.notes = notes;
    session.updatedAt = now();
    this.persist(session);
    this.emitEvent(session, "note.updated", next);
    return next;
  }

  deleteNote(sessionId: string, noteId: string): void {
    const session = this.getMutableSession(sessionId);
    const before = session.notes?.length ?? 0;
    session.notes = (session.notes ?? []).filter((n) => n.id !== noteId);
    if ((session.notes?.length ?? 0) === before) throw new Error("Note not found");
    session.updatedAt = now();
    this.persist(session);
    this.emitEvent(session, "note.deleted", { noteId });
  }

  /**
   * Global task list across every session on this host. Optionally filter by
   * status. Returns most-recently-updated first so the pull-to-refresh UX
   * on iOS lands with fresh items at the top.
   */
  listTasks(opts?: { status?: "open" | "done" }): SessionTask[] {
    const all: SessionTask[] = [];
    for (const s of this.list()) {
      for (const t of s.tasks ?? []) {
        if (opts?.status && t.status !== opts.status) continue;
        all.push(t);
      }
    }
    all.sort((a, b) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt));
    return all;
  }

  /**
   * Resolve a session to the mutable in-memory reference (live) if possible,
   * otherwise the on-disk record. Used by the small mutations above so
   * callers don't need to know which case they're in.
   */
  private getMutableSession(sessionId: string): DispatchSession {
    const live = this.live.get(sessionId);
    if (live) return live.session;
    const s = this.store.load(sessionId);
    if (!s) throw new Error("Session not found");
    return s;
  }

  /**
   * Move this chat to another profile (FullScore → Personal, Claude → NightMoose, …).
   *
   * - **Original** stays on the old profile and is **Archived** (history / audit trail).
   * - **New** Active session under the target profile gets the transcript + handoff.
   *
   * Not dual-live: only the new row is meant for follow-ups. Claude account / cross-backend
   * switches always get a fresh agent id (config-dir / backend isolation).
   */
  async transferProfile(sessionId: string, req: TransferProfileRequest): Promise<DispatchSession> {
    const targetId = req.profileId?.trim();
    if (!targetId) throw new Error("profileId is required");

    const original = this.get(sessionId);
    if (!original) throw new Error("Session not found");

    const target = resolveProfile(this.config, targetId);
    if (original.profileId === target.id) {
      return original;
    }

    const fromName = original.profileName ?? original.profileId ?? "unknown";
    const fromBackend = original.backend ?? "grok";
    const toBackend = target.backend;
    const ts = now();

    // Stop any live agent on the source chat.
    await this.dropLive(sessionId);
    try {
      this.cliRunners.get(sessionId)?.stop();
    } catch {
      /* ignore */
    }
    this.cliRunners.delete(sessionId);
    const botRun = this.botRuns.get(sessionId);
    if (botRun) {
      botRun.cancelled = true;
      botRun.abort.abort("cancelled");
      botRun.pending?.reject(new Error("transferred"));
      this.botRuns.delete(sessionId);
    }

    // ── New Active session under the target profile ─────────────
    const newId = randomUUID();
    // Grok→Grok can keep the ACP session id; CLI backends always start fresh
    // (account isolation / conversation ids are not portable across profiles).
    const needsFreshAgent =
      fromBackend !== toBackend ||
      !isGrokBackend(toBackend);

    const continuation: DispatchSession = {
      ...structuredClone(original),
      id: newId,
      backend: toBackend,
      profileId: target.id,
      profileName: target.name,
      profileColor: target.color,
      model: target.model ?? defaultModelForBackend(toBackend),
      planMode: isGrokBackend(toBackend) ? original.planMode : false,
      status: "idle",
      error: undefined,
      completedAt: undefined,
      pendingApprovalId: undefined,
      pendingQuestionId: undefined,
      pendingQuestion: null,
      archived: false,
      archivedAt: undefined,
      updatedAt: ts,
      createdAt: ts,
      // Agent ids: only keep when Grok→Grok (same machine account).
      grokSessionId: !needsFreshAgent && toBackend === "grok" ? original.grokSessionId : undefined,
      claudeSessionId:
        toBackend === "claude"
          ? undefined
          : fromBackend === "claude"
            ? original.claudeSessionId
            : undefined,
      antigravityConversationId:
        toBackend === "antigravity"
          ? undefined
          : fromBackend === "antigravity"
            ? original.antigravityConversationId
            : undefined,
      transferHandoffPending: needsFreshAgent,
      transcript: [
        ...(original.transcript ?? []).map((t) => ({ ...t })),
        {
          id: randomUUID(),
          role: "system",
          text:
            `Continued here after transfer from ${fromName} (${fromBackend}) → ${target.name} (${toBackend}). ` +
            (needsFreshAgent
              ? "Next message starts a fresh agent session with prior transcript as context."
              : "Next message continues under this profile."),
          at: ts,
        },
      ],
      toolCalls: (original.toolCalls ?? []).map((t) => ({ ...t })),
      events: [],
      plan: original.plan ? original.plan.map((p) => ({ ...p })) : undefined,
    };

    this.store.save(continuation);
    this.emitEvent(continuation, "session.created", {
      session: this.store.toSummary(continuation),
      transferredFrom: sessionId,
      transferredFromProfile: fromName,
    });

    // ── Archive the original under the old profile ──────────────
    original.status = "idle";
    original.error = undefined;
    original.pendingApprovalId = undefined;
    original.pendingApproval = null;
    original.pendingQuestionId = undefined;
    original.pendingQuestion = null;
    original.archived = true;
    original.archivedAt = ts;
    original.updatedAt = ts;
    original.transferHandoffPending = false;
    // Don't let the archived copy re-attach the same live agent as the continuation.
    if (!needsFreshAgent && toBackend === "grok" && continuation.grokSessionId) {
      original.grokSessionId = undefined;
    }
    original.transcript.push({
      id: randomUUID(),
      role: "system",
      text:
        `Transferred to ${target.name} (${toBackend}) and archived. ` +
        `Continuation session: ${newId}. This copy stays under ${fromName} for history.`,
      at: ts,
    });
    this.persist(original);
    this.emitEvent(original, "session.updated", {
      archived: true,
      archivedAt: ts,
      transferredTo: newId,
      transferredToProfile: target.name,
    });
    this.emitEvent(original, "transcript", original.transcript[original.transcript.length - 1]);

    console.log(
      `[transfer] ${sessionId.slice(0, 8)} (${fromName}/${fromBackend}) archived → ` +
        `new ${newId.slice(0, 8)} (${target.name}/${toBackend}) active freshAgent=${needsFreshAgent}`,
    );

    return continuation;
  }

  /**
   * Reincarnate: archive the long-lived chat and open a fresh session in the same
   * project/cwd with a compact summary of what happened. Keeps status tiles useful
   * without dragging months of transcript into every turn.
   */
  async reincarnate(
    sessionId: string,
    req: { profileId?: string; title?: string; note?: string } = {},
  ): Promise<DispatchSession> {
    const original = this.get(sessionId);
    if (!original) throw new Error("Session not found");

    const profile = resolveProfile(this.config, req.profileId ?? original.profileId);
    const summary = this.buildReincarnationSummary(original);
    const note = (req.note ?? "").trim();
    const kickoff =
      summary +
      (note
        ? `\n\n----- USER NOTE -----\n${note}\n----- END NOTE -----\n\nContinue from here.`
        : `\n\nContinue this project from the summary above. Do not redo finished work unless asked.`);

    const baseTitle = (req.title ?? original.title ?? "Session").trim() || "Session";
    const newTitle = baseTitle.toLowerCase().includes("reincarnat")
      ? baseTitle
      : `${baseTitle} (reincarnated)`;

    // Stop live agent on the old chat before archiving.
    await this.dropLive(sessionId);

    const fresh = await this.dispatch({
      prompt: kickoff,
      cwd: original.cwd,
      projectId: original.projectId,
      title: newTitle,
      model: profile.model ?? original.model,
      planMode: isGrokBackend(profile.backend) ? original.planMode : false,
      subagents: isGrokBackend(profile.backend) ? original.subagents : false,
      worktree: isGrokBackend(profile.backend) ? original.worktree : false,
      profileId: profile.id,
    });

    const ts = now();
    original.status = "idle";
    original.error = undefined;
    original.pendingApprovalId = undefined;
    original.pendingApproval = null;
    original.pendingQuestionId = undefined;
    original.pendingQuestion = null;
    original.archived = true;
    original.archivedAt = ts;
    original.updatedAt = ts;
    original.transferHandoffPending = false;
    original.transcript.push({
      id: randomUUID(),
      role: "system",
      text:
        `Reincarnated into a fresh session (${fresh.id}). ` +
        `This copy is archived under ${original.profileName ?? original.profileId ?? "profile"} for history.`,
      at: ts,
    });
    this.persist(original);
    this.emitEvent(original, "session.updated", {
      archived: true,
      archivedAt: ts,
      reincarnatedTo: fresh.id,
    });
    this.emitEvent(original, "transcript", original.transcript[original.transcript.length - 1]);

    console.log(
      `[reincarnate] ${sessionId.slice(0, 8)} archived → new ${fresh.id.slice(0, 8)} ` +
        `profile=${profile.id} cwd=${original.cwd}`,
    );

    return fresh;
  }

  /**
   * Review recent work: open a *new* session that critiques the source chat's
   * history and workspace changes. Source stays Active and is not taken over.
   */
  async reviewWork(
    sessionId: string,
    req: ReviewWorkRequest = {},
  ): Promise<DispatchSession> {
    const original = this.get(sessionId);
    if (!original) throw new Error("Session not found");

    const profile = resolveProfile(this.config, req.profileId ?? original.profileId);
    const includeDiff = req.includeDiff !== false;

    let diffText = "";
    if (includeDiff) {
      try {
        diffText = await gitDiff(original.cwd, 80_000);
      } catch (err) {
        diffText = `(git diff unavailable: ${err instanceof Error ? err.message : String(err)})`;
      }
    }

    const brief = this.buildReviewBrief(original, diffText);
    const note = (req.note ?? "").trim();
    const kickoff =
      brief +
      (note
        ? `\n\n----- REVIEWER FOCUS -----\n${note}\n----- END FOCUS -----\n`
        : "") +
      `\n\n` +
      `## Your job (read carefully)\n` +
      `You are performing a **code/work review** of another agent's session. You do **not** own that session.\n` +
      `- Inspect the conversation highlights and (if present) the git diff.\n` +
      `- You may **read** files in the project cwd to verify claims; prefer read-only tools.\n` +
      `- **Do not implement fixes, edit files, or run destructive commands** unless the user explicitly asks in a follow-up.\n` +
      `- Produce a clear written critique covering:\n` +
      `  1. **What was built / accomplished** (concrete, evidence-based)\n` +
      `  2. **What's solid** (keep doing this)\n` +
      `  3. **Gaps & risks** (bugs, missing tests, security, UX, maintainability)\n` +
      `  4. **Prioritized improvements** (quick wins first, then deeper work)\n` +
      `  5. **Suggested next prompts** the original session could take (optional)\n` +
      `Keep the tone constructive and specific. Reference file paths and behaviors when you can.\n`;

    const baseTitle = (req.title ?? original.title ?? "Session").trim() || "Session";
    const newTitle = /^review\b/i.test(baseTitle)
      ? baseTitle.slice(0, 80)
      : `Review · ${baseTitle}`.slice(0, 80);

    // Do NOT dropLive / archive the original — review is a sibling session.
    const fresh = await this.dispatch({
      prompt: kickoff,
      cwd: original.cwd,
      projectId: original.projectId,
      title: newTitle,
      model: profile.model ?? original.model,
      planMode: false,
      subagents: isGrokBackend(profile.backend) ? true : false,
      worktree: false,
      profileId: profile.id,
    });

    const ts = now();
    original.transcript.push({
      id: randomUUID(),
      role: "system",
      text:
        `Review session started (${fresh.id}) as ${profile.name} — ` +
        `this chat stays active; the review will not take it over.`,
      at: ts,
    });
    original.updatedAt = ts;
    this.persist(original);
    this.emitEvent(original, "transcript", original.transcript[original.transcript.length - 1]!);
    this.emitEvent(original, "session.updated", {
      reviewSessionId: fresh.id,
      reviewedByProfile: profile.name,
    });

    console.log(
      `[review] ${sessionId.slice(0, 8)} → new review ${fresh.id.slice(0, 8)} ` +
        `profile=${profile.id} includeDiff=${includeDiff} cwd=${original.cwd}`,
    );

    return fresh;
  }

  /** Compact project memory for a fresh session (not a full transcript dump). */
  private buildReincarnationSummary(session: DispatchSession): string {
    return this.buildSessionBrief(session, {
      heading: "Reincarnated session",
      highlightLimit: 12,
      maxChars: 10_000,
    });
  }

  /** Richer brief for independent review sessions (history + optional diff). */
  private buildReviewBrief(session: DispatchSession, diffText: string): string {
    const parts: string[] = [];
    parts.push(
      this.buildSessionBrief(session, {
        heading: "Session under review",
        highlightLimit: 20,
        maxChars: 14_000,
      }),
    );

    if (session.toolCalls?.length) {
      const recentTools = session.toolCalls.slice(-25);
      parts.push(`## Recent tool activity`);
      for (const t of recentTools) {
        parts.push(`- [${t.status}] ${t.title}${t.kind ? ` (${t.kind})` : ""}`);
      }
      parts.push("");
    }

    if (diffText?.trim()) {
      const capped =
        diffText.length > 60_000
          ? diffText.slice(0, 60_000) + "\n…(diff truncated)"
          : diffText;
      parts.push(`## Working tree changes (git)`);
      parts.push("```diff");
      parts.push(capped.trimEnd());
      parts.push("```");
      parts.push("");
    } else {
      parts.push(`## Working tree changes (git)`);
      parts.push(`(no diff included or working tree clean / not a git repo)`);
      parts.push("");
    }

    let out = parts.join("\n");
    if (out.length > 70_000) {
      out = out.slice(0, 70_000) + "\n\n…(review brief truncated)";
    }
    return out;
  }

  private buildSessionBrief(
    session: DispatchSession,
    opts: { heading: string; highlightLimit: number; maxChars: number },
  ): string {
    const lines: string[] = [];
    lines.push(`# ${opts.heading}`);
    lines.push(`Title: ${session.title}`);
    lines.push(`Project cwd: ${session.cwd}`);
    if (session.projectId) lines.push(`Project id: ${session.projectId}`);
    lines.push(
      `Profile: ${session.profileName ?? session.profileId ?? "unknown"} (${session.backend ?? "agent"})`,
    );
    lines.push(`Session id: ${session.id}`);
    lines.push(`Status: ${session.status}`);
    lines.push("");

    if (session.plan?.length) {
      lines.push(`## Plan snapshot`);
      for (const p of session.plan.slice(0, 20)) {
        const st = p.status ? ` [${p.status}]` : "";
        lines.push(`- ${p.content}${st}`);
      }
      lines.push("");
    }

    // Prefer recent assistant conclusions + user asks; skip pure system noise.
    const useful = (session.transcript ?? []).filter((t) => {
      if (!t.text?.trim()) return false;
      if (t.role === "system" && /transferred|reincarnat|archived|review session/i.test(t.text)) {
        return false;
      }
      return t.role === "user" || t.role === "assistant";
    });

    // First user prompt + last N turns for continuity.
    const firstUser = useful.find((t) => t.role === "user");
    const tail = useful.slice(-opts.highlightLimit);
    const picked: typeof useful = [];
    if (firstUser) picked.push(firstUser);
    for (const t of tail) {
      if (!picked.some((p) => p.id === t.id)) picked.push(t);
    }

    lines.push(`## Conversation highlights`);
    for (const t of picked) {
      const role = t.role === "user" ? "User" : "Assistant";
      const body = t.text.trim().slice(0, 1500);
      lines.push(`### ${role}\n${body}`);
    }

    let out = lines.join("\n");
    if (out.length > opts.maxChars) {
      out = out.slice(0, opts.maxChars) + "\n\n…(summary truncated)";
    }
    return out;
  }

  /** Stop ACP child without cancelling the chat (used by profile transfer). */
  private async dropLive(sessionId: string): Promise<void> {
    const live = this.live.get(sessionId);
    if (!live) return;
    for (const [aid, approval] of live.pendingApprovals) {
      if (approval.rpcId !== undefined) {
        try {
          live.client.respond(approval.rpcId, { outcome: { outcome: "cancelled" } });
        } catch {
          /* ignore */
        }
      }
      live.pendingApprovals.delete(aid);
    }
    live.pendingQuestions.clear();
    try {
      if (live.session.grokSessionId) {
        live.client.notify("session/cancel", { sessionId: live.session.grokSessionId });
      }
    } catch {
      /* ignore */
    }
    await live.client.stop().catch(() => undefined);
    this.live.delete(sessionId);
  }

  /**
   * Soft-archive (or restore) a Dispatch session.
   * Archived chats drop out of the default Active list but stay on disk and openable.
   */
  setArchived(sessionId: string, archived: boolean): DispatchSession {
    const s = this.loadMutable(sessionId);
    s.archived = archived;
    s.archivedAt = archived ? now() : undefined;
    s.updatedAt = now();
    this.persist(s);
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

    // Pick the pending question we're going to answer. Prefer one that still
    // holds an ACP rpcId so we can respond directly rather than going through
    // the soft cancel+re-prompt fallback (which loses context and can leave a
    // hung turn). Only fall back to a soft-parked question if no RPC-backed
    // one exists in the live map.
    const qid = body.questionId ?? session.pendingQuestionId;
    const requestedPending =
      (qid && live?.pendingQuestions.get(qid)) ||
      (session.pendingQuestionId && live?.pendingQuestions.get(session.pendingQuestionId)) ||
      null;
    let pending = requestedPending;
    if (live && (!pending || pending.rpcId === undefined)) {
      for (const q of live.pendingQuestions.values()) {
        if (q.rpcId !== undefined) {
          pending = q;
          break;
        }
      }
    }

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

    // Prefer ACP extension response when we still hold the request id.
    // Grok's AskUserQuestionExtResponse is internally tagged on `outcome`;
    // `{ type: "accepted", answers: [...] }` is rejected as "missing field
    // `outcome`" and fails the in-flight session/prompt.
    if (live && pending?.rpcId !== undefined) {
      const outcome = body.outcome ?? "accepted";
      if (outcome === "skip") {
        live.client.respond(pending.rpcId, questionCancelledResult());
      } else if (outcome === "chat") {
        live.client.respond(
          pending.rpcId,
          questionChatResult(body.comment?.trim() || answers.join("\n")),
        );
      } else {
        live.client.respond(
          pending.rpcId,
          questionAcceptedResult(
            buildQuestionAnswers(questions, answers),
            questionAnnotationsForComment(questions, body.comment),
          ),
        );
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
    } else if (!live || !pending) {
      // Process gone, OR the pending question is only on disk (live was respawned
      // after an ACP exit so live.pendingQuestions is empty and the original
      // rpcId is stale). Either way, route the answers via a fresh follow-up
      // turn so they aren't silently dropped.
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

    // Only clear session-level pending state if it still refers to the question we
    // just answered. Prevents wiping out a follow-up question the agent asked
    // between our respond() and now, or clobbering state when the client submits a
    // stale questionId. Also don't flip to "running" if another question or an
    // approval is still open on this live session.
    const resolvedIsCurrent = pending ? session.pendingQuestionId === pending.id : true;
    const otherQuestionsStillOpen = live ? live.pendingQuestions.size > 0 : false;
    const approvalsStillOpen = live ? live.pendingApprovals.size > 0 : false;

    if (resolvedIsCurrent) {
      session.pendingQuestionId = undefined;
      session.pendingQuestion = null;
    }
    if (
      session.status === "awaiting_question" &&
      !otherQuestionsStillOpen &&
      !approvalsStillOpen &&
      resolvedIsCurrent
    ) {
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
    scope: "once" | "always_session" = "once",
  ): Promise<DispatchSession> {
    // In-process bot loop (no ACP rpcId — resolve continues or skips the tool)
    const botRun = this.botRuns.get(sessionId);
    if (botRun?.pending?.approvalId === approvalId) {
      const pending = botRun.pending;
      botRun.pending = undefined;
      const session = this.get(sessionId);
      if (!session) throw new Error("Session not found");
      if (decision === "approve" && scope === "always_session" && session.pendingApproval) {
        const sig = `bot:${session.pendingApproval.kind ?? "other"}:${session.pendingApproval.title}`;
        const list = session.autoApproveSignatures ?? [];
        if (!list.includes(sig)) session.autoApproveSignatures = [...list, sig];
      }
      pending.resolve({ decision, comment });
      return session;
    }

    // Claude PreToolUse hook approvals (no ACP client required)
    const claudeHook = this.claudeApprovals.get(approvalId);
    if (claudeHook) {
      return this.finishClaudeHookApproval(claudeHook, decision, comment, scope);
    }

    // Claude child is still running but the in-memory hook map missed this id
    // (phone is resolving the persisted snapshot). Rehydrate so the waiting
    // PreToolUse poll observes the decision — do NOT dismiss the agent.
    if (this.cliRunners.has(sessionId)) {
      const parked = this.get(sessionId);
      if (parked?.pendingApprovalId === approvalId && parked.pendingApproval) {
        const recovered: ClaudeHookApproval = {
          id: approvalId,
          sessionId,
          status: "pending",
          title: parked.pendingApproval.title,
          toolName: toolNameFromParkedApproval(parked.pendingApproval),
          toolInput: parked.pendingApproval.rawInput,
          createdAt: parked.pendingApproval.createdAt,
        };
        this.claudeApprovals.set(approvalId, recovered);
        return this.finishClaudeHookApproval(recovered, decision, comment, scope);
      }
    }

    // Agent process is gone (host restart / crash) but the session on disk
    // still shows this approval as pending. Approving must resume the session
    // — the old "dismissed, send a follow-up" path stalled every in-flight
    // Claude/Grok turn the moment the host bounced.
    const live = this.live.get(sessionId);
    const persisted = live ? null : this.store.load(sessionId);
    if (!live && persisted && persisted.pendingApprovalId === approvalId && persisted.pendingApproval) {
      const parked = persisted.pendingApproval;
      const title = parked.title;
      const p = persisted;
      if (decision === "approve") {
        const sig =
          p.backend === "claude"
            ? claudeApprovalSignature(toolNameFromParkedApproval(parked), parked.rawInput)
            : grokApprovalSignature(parked.kind, title);
        const list = p.autoApproveSignatures ?? [];
        if (sig && !list.includes(sig)) p.autoApproveSignatures = [...list, sig];
      }
      p.pendingApprovalId = undefined;
      p.pendingApproval = null;
      p.status = decision === "approve" ? "running" : "idle";
      p.updatedAt = now();
      const resume =
        decision === "approve"
          ? buildOrphanedApprovalResumePrompt({
              decision,
              title,
              rawInput: parked.rawInput,
              comment,
            })
          : null;
      const note: TranscriptEntry = {
        id: randomUUID(),
        role: "system",
        text:
          decision === "approve"
            ? `Approved "${title}" after host restart — resuming the agent.`
            : `Rejected "${title}" after host restart — the agent has been dismissed.` +
              (comment?.trim() ? ` Comment: ${comment.trim()}` : ""),
        at: now(),
      };
      p.transcript.push(note);
      this.store.save(p);
      this.emitEvent(p, "transcript", note);
      this.emitEvent(p, "approval.resolved", {
        approvalId,
        decision,
        comment,
        orphaned: true,
        resumed: Boolean(resume),
      });
      this.emitEvent(p, "session.updated", { status: p.status });
      console.log(
        `[approvals] orphaned ${decision} session=${sessionId.slice(0, 8)} title="${title.slice(0, 80)}" resume=${Boolean(resume)}`,
      );
      if (resume) this.resumeOrphanedSession(sessionId, resume);
      return p;
    }
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
      if (isGrokExitPlanApproval(approval)) {
        // Native Grok verdict: flat { outcome: "approved"|"cancelled"|"abandoned" }.
        // Nested { outcome: { outcome: "accepted" } } fail-closes to cancelled
        // (stay in plan mode) — the stuck-in-plan-mode bug.
        const response = exitPlanResult(exitPlanVerdictFor(decision));
        console.log(
          `[acp] exit_plan_mode respond session=${sessionId.slice(0, 8)} decision=${decision} body=${JSON.stringify(response)}`,
        );
        live.client.respond(approval.rpcId, response);
      } else {
        live.client.respond(approval.rpcId, {
          outcome: { outcome: "selected", optionId: selected },
        });
      }
    }

    // "Always this session" — remember signature so future matches skip phone.
    // Skip for exit_plan_mode (one-shot; nothing to remember) and reject cases.
    if (decision === "approve" && scope === "always_session" && !rawIsExitPlan(approval.rawInput)) {
      const sig = grokApprovalSignature(approval.kind, approval.title);
      const list = live.session.autoApproveSignatures ?? [];
      if (!list.includes(sig)) {
        live.session.autoApproveSignatures = [...list, sig];
      }
    }

    live.pendingApprovals.delete(approvalId);
    live.session.pendingApprovalId = undefined;
    live.session.pendingApproval = null;
    live.session.status = "running";
    live.session.updatedAt = now();

    let noteText: string | null = null;
    if (isGrokExitPlanApproval(approval) || rawIsExitPlan(approval.rawInput)) {
      if (decision === "approve") {
        // Critical: clear host-side plan lock so follow-ups and UI know we left plan mode.
        live.session.planMode = false;
        noteText = "Plan approved — implementing.";
        console.log(
          `[acp] planMode cleared session=${sessionId.slice(0, 8)} after exit_plan_mode approve`,
        );
      } else {
        noteText = "Plan rejected — continue planning.";
      }
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
      scope,
    });
    this.emitEvent(live.session, "session.updated", {
      status: live.session.status,
      planMode: live.session.planMode,
    });

    return live.session;
  }

  private finishClaudeHookApproval(
    claudeHook: ClaudeHookApproval,
    decision: "approve" | "reject",
    comment: string | undefined,
    scope: "once" | "always_session",
  ): DispatchSession {
    claudeHook.status = decision === "approve" ? "approved" : "rejected";
    claudeHook.comment = comment;
    const session = this.get(claudeHook.sessionId);
    if (!session) throw new Error("Session not found");
    // If the user chose "Approve always this session," remember the
    // signature so subsequent identical tool calls skip the phone.
    if (decision === "approve" && scope === "always_session") {
      const sig = claudeApprovalSignature(claudeHook.toolName, claudeHook.toolInput);
      const list = session.autoApproveSignatures ?? [];
      if (!list.includes(sig)) {
        session.autoApproveSignatures = [...list, sig];
      }
    }
    session.pendingApprovalId = undefined;
    session.pendingApproval = null;
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
    this.emitEvent(session, "approval.resolved", {
      approvalId: claudeHook.id,
      decision,
      comment,
      backend: "claude",
      scope,
    });
    this.live.get(claudeHook.sessionId)?.pendingApprovals.delete(claudeHook.id);
    return session;
  }

  async diff(sessionId: string): Promise<{ cwd: string; diff: string }> {
    const s = this.get(sessionId);
    if (!s) throw new Error("Session not found");
    const diff = await gitDiff(s.cwd);
    return { cwd: s.cwd, diff };
  }

  listFiles(sessionId: string) {
    const s = this.get(sessionId);
    if (!s) throw new Error("Session not found");
    return listSessionFiles(s, this.config);
  }

  readFile(sessionId: string, path: string) {
    const s = this.get(sessionId);
    if (!s) throw new Error("Session not found");
    return readSessionFile(s, this.config, path);
  }

  /** Merge extra workspace folders. Next Claude turn gets `--add-dir`; others see a prompt note. */
  addExtraDirs(sessionId: string, extraDirs: string[]): DispatchSession {
    const session = this.getMutableSession(sessionId);
    const added = normalizeExtraDirs(this.config, session.cwd, extraDirs);
    const existing = session.extraDirs ?? [];
    const merged = [...existing];
    for (const dir of added) {
      if (!merged.includes(dir)) merged.push(dir);
    }
    session.extraDirs = merged;
    session.updatedAt = now();
    const newly = merged.filter((d) => !existing.includes(d));
    if (newly.length) {
      session.transcript.push({
        id: randomUUID(),
        role: "system",
        text: `Added extra workspace folder${newly.length === 1 ? "" : "s"}:\n${newly.map((d) => `- ${d}`).join("\n")}`,
        at: now(),
      });
    }
    this.persist(session);
    this.emitEvent(session, "session.updated", { extraDirs: session.extraDirs });
    return session;
  }

  // ── internals ──────────────────────────────────────────────

  /** One Claude Code turn: stream-json + optional phone tool approvals. */
  private async claudeTurn(
    sessionId: string,
    prompt: string,
    images: PromptImage[] = [],
    opts?: { recordUser?: boolean },
  ): Promise<DispatchSession> {
    const session = this.get(sessionId);
    if (!session) throw new Error("Session not found");

    const extraDirs = ensureAttachmentDirs(this.config, session);
    const savedPaths = savePromptImagesForSession(this.config, session, images);
    const promptPaths = materializeImagesInCwd(session.cwd, savedPaths);
    let claudePrompt =
      promptPaths.length === 0
        ? prompt
        : `${prompt}\n\n[User attached screenshot file(s) for debugging — open/read these paths with your tools:]\n${promptPaths.map((p) => `- ${p}`).join("\n")}`;

    // Fresh Claude after profile transfer: inject prior transcript so the new account has context.
    if (session.transferHandoffPending || (!session.claudeSessionId && session.transcript.length > 1)) {
      if (session.transferHandoffPending) {
        claudePrompt = this.buildTransferHandoffPrompt(session, claudePrompt);
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
    this.persist(session);
    if (recordUser) this.emitEvent(session, "transcript", entry);
    this.emitEvent(session, "session.updated", { status: "running", backend: "claude" });

    const hostBase = `http://127.0.0.1:${this.config.bindPort}`;
    const profile = this.profileFor(session);
    if (profile) {
      await refreshAllMcpOAuth(this.config.dataDir, profile.id, profile.mcpServers).catch(() => undefined);
    }
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
      model: session.model,
      appendSystemPrompt: profile?.systemPrompt,
      extraDirs,
      toolAllowlist: profile?.toolAllowlist,
      mcpConfigPath: profile
        ? writeProfileMcpJson(this.config.dataDir, profile, mcpEnvFor(profile))
        : undefined,
    });
    this.cliRunners.set(sessionId, runner);

    let streamBuf = "";
    let thoughtBuf = "";
    runner.on("text", (chunk: string) => {
      streamBuf += chunk;
      this.emitEvent(session, "transcript", { role: "assistant", text: chunk, streaming: true });
    });
    runner.on("thought", (chunk: string) => {
      thoughtBuf += chunk;
      this.emitEvent(session, "thought", { role: "thought", text: chunk, streaming: true });
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
      this.persist(session);
      this.emitEvent(session, "usage", session.usage);
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
      this.persist(session);
      this.emitEvent(session, "transcript", assistantEntry);
      this.emitEvent(session, "session.updated", { status: "idle", backend: "claude" });
      this.maybeNotify("ClankerSpanker", `Claude ready: ${session.title}`);
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
        this.emitEvent(session, "transcript", note);
        this.emitEvent(session, "session.updated", {
          status: "failed",
          needsLogin: true,
          profileId: session.profileId,
          backend: "claude",
        });
      }
      this.persist(session);
      this.emitEvent(session, "session.failed", {
        error: session.error,
        needsLogin: isAuthFailureMessage(msg),
        profileId: session.profileId,
      });
      throw new Error(session.error);
    } finally {
      this.cliRunners.delete(sessionId);
    }
  }

  /**
   * One Antigravity CLI (`agy`) turn: headless -p + stream-json + conversation resume.
   * Phone tool-approval hooks are not available (agy soft-denies shell in headless unless
   * --dangerously-skip-permissions or settings allow rules). We default to skip-permissions
   * so Dispatch tasks can actually edit/run like Claude acceptEdits; tighten via profile env
   * ANTIGRAVITY_REQUIRE_PERMISSIONS=1 if desired.
   */
  private async antigravityTurn(
    sessionId: string,
    prompt: string,
    images: PromptImage[] = [],
    opts?: { recordUser?: boolean },
  ): Promise<DispatchSession> {
    const session = this.get(sessionId);
    if (!session) throw new Error("Session not found");

    const savedPaths = savePromptImagesForSession(this.config, session, images);
    const promptPaths = materializeImagesInCwd(session.cwd, savedPaths);
    let agentPrompt =
      extraDirsAgentNote(session.extraDirs) +
      (promptPaths.length === 0
        ? prompt
        : `${prompt}\n\n[User attached screenshot file(s) for debugging — open/read these paths with your tools:]\n${promptPaths.map((p) => `- ${p}`).join("\n")}`);

    if (session.transferHandoffPending || (!session.antigravityConversationId && session.transcript.length > 1)) {
      if (session.transferHandoffPending) {
        agentPrompt = this.buildTransferHandoffPrompt(session, agentPrompt);
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
    this.persist(session);
    if (recordUser) this.emitEvent(session, "transcript", entry);
    this.emitEvent(session, "session.updated", { status: "running", backend: "antigravity" });

    const profileEnv = this.profileEnvFor(session);
    const requirePerms = !antigravityAutoApproves(profileEnv);

    const profile = this.profileFor(session);
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
    this.cliRunners.set(sessionId, runner);

    let streamBuf = "";
    runner.on("text", (chunk: string) => {
      streamBuf += chunk;
      this.emitEvent(session, "transcript", { role: "assistant", text: chunk, streaming: true });
    });
    runner.on("system", (text: string) => {
      this.emitEvent(session, "session.updated", { diagnostic: text.slice(0, 200) });
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
      this.persist(session);
      this.emitEvent(session, "tool_call", record);
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
      this.persist(session);
      this.emitEvent(session, "transcript", assistantEntry);
      this.emitEvent(session, "session.updated", {
        status: "idle",
        backend: "antigravity",
        antigravityConversationId: session.antigravityConversationId,
      });
      this.maybeNotify("ClankerSpanker", `Antigravity ready: ${session.title}`);
      return session;
    } catch (err) {
      const e = err as { message?: string };
      session.status = "failed";
      session.error = (e.message ?? String(err)).slice(0, 2000);
      session.updatedAt = now();
      this.persist(session);
      this.emitEvent(session, "session.failed", { error: session.error });
      throw new Error(session.error);
    } finally {
      this.cliRunners.delete(sessionId);
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

  /** Like ensureLive, but creates a brand-new Grok ACP session when none exists (post-transfer). */
  private async ensureLiveOrCreate(sessionId: string): Promise<LiveSession> {
    const existing = this.live.get(sessionId);
    if (existing) return existing;

    const session = this.store.load(sessionId);
    if (!session) throw new Error("Session not found");
    if (session.grokSessionId) {
      return this.spawnAndLoad(session, session.grokSessionId);
    }

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

    await client.start();
    const newParams: Record<string, unknown> = {
      cwd: session.cwd,
      mcpServers: await this.acpMcpServersFor(session),
    };
    if (session.worktree) {
      newParams._meta = { ...(newParams._meta as object), worktree: true };
    }
    if (session.subagents === false) {
      newParams._meta = { ...(newParams._meta as object), noSubagents: true };
    }
    if (session.extraDirs?.length) {
      newParams._meta = { ...(newParams._meta as object), extraDirs: session.extraDirs };
    }
    const result = (await client.request("session/new", newParams)) as { sessionId?: string };
    session.grokSessionId = result.sessionId ?? randomUUID();
    session.status = "idle";
    session.updatedAt = now();
    this.persist(session);
    this.emitEvent(session, "session.updated", {
      grokSessionId: session.grokSessionId,
      status: "idle",
      createdAfterTransfer: true,
    });
    return live;
  }

  /** Summarize prior chat for the first turn after a profile transfer. */
  private buildTransferHandoffPrompt(session: DispatchSession, userMessage: string): string {
    const lines: string[] = [];
    for (const t of session.transcript ?? []) {
      if (t.role === "system" && t.text.startsWith("Transferred from")) continue;
      const role =
        t.role === "user" ? "User" : t.role === "assistant" ? "Assistant" : t.role === "thought" ? "Thought" : "System";
      const body = (t.text ?? "").trim();
      if (!body) continue;
      lines.push(`${role}: ${body.slice(0, 1500)}`);
    }
    // Cap handoff size so first prompts stay reasonable
    let excerpt = lines.join("\n\n");
    if (excerpt.length > 12_000) {
      excerpt = "…\n\n" + excerpt.slice(-12_000);
    }
    return (
      `You are continuing a ClankerSpanker session that was transferred to profile ` +
      `"${session.profileName ?? session.profileId}" (${session.backend ?? "agent"}).\n` +
      `Project cwd: ${session.cwd}\n` +
      `Pick up the work — do not restart completed steps unless the user asks.\n\n` +
      `----- PRIOR TRANSCRIPT -----\n${excerpt || "(empty)"}\n----- END TRANSCRIPT -----\n\n` +
      `User's next message:\n${userMessage}`
    );
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

  private async acpMcpServersFor(session: DispatchSession) {
    const profile = this.profileFor(session);
    if (!profile) return [];
    await refreshAllMcpOAuth(this.config.dataDir, profile.id, profile.mcpServers).catch(() => undefined);
    return toAcpMcpServers(
      profile.mcpServers,
      mcpEnvFor(profile),
      oauthHeaderMap(this.config.dataDir, profile.id, profile.mcpServers),
    );
  }

  private newAcpClient(session: DispatchSession): AcpClient {
    return new AcpClient(
      this.config.grokBinary,
      grokAgentModelArgs(session.model),
      this.profileEnvFor(session),
      {
        promptIdleTimeoutMs: this.config.promptIdleTimeoutMs,
        promptMaxMs: this.config.promptMaxMs,
      },
    );
  }

  /** True while a prompt is parked on the human (do not idle-fail). */
  private isHumanGateOpen(live: LiveSession): boolean {
    const st = live.session.status;
    if (st === "awaiting_approval" || st === "awaiting_question") return true;
    if (live.pendingApprovals.size > 0 || live.pendingQuestions.size > 0) return true;
    if (live.session.pendingApprovalId || live.session.pendingQuestionId) return true;
    return false;
  }

  /**
   * Bot runs are grouped under a human profile chip (NightMoose) but talk to
   * HTTP chat APIs. Remap grok-build → grok-4 and fold in any leftover
   * nightmoose-bot env keys.
   */
  private botBrainProfile(owner: import("../types.js").AgentProfile): import("../types.js").AgentProfile {
    const hidden = this.config.profiles.find(
      (p) => p.id === "nightmoose-bot" || p.backend === "bot",
    );
    // Keep the owner's backend so the hunter uses that chip's CLI login
    // (grok / claude / agy) — same credentials as Sessions.
    return {
      ...owner,
      env: { ...(hidden?.env ?? {}), ...(owner.env ?? {}) },
    };
  }

  private profileEnvFor(session: DispatchSession): NodeJS.ProcessEnv {
    try {
      const preferred =
        session.backend === "claude" || session.backend === "antigravity" || session.backend === "bot"
          ? session.backend
          : "grok";
      const profile = resolveProfile(this.config, session.profileId, preferred);
      const env = profileProcessEnv(profile, { dataDir: this.config.dataDir });
      // RFC-048: resume a Grok session in the home it was created in.
      if (preferred === "grok" && session.grokHome) env.GROK_HOME = session.grokHome;
      return env;
    } catch {
      return { ...process.env };
    }
  }

  /** Look up the full profile record for a session (nullable on unknown id). */
  private profileFor(session: DispatchSession): import("../types.js").AgentProfile | undefined {
    try {
      const preferred =
        session.backend === "claude" || session.backend === "antigravity" || session.backend === "bot"
          ? session.backend
          : "grok";
      return resolveProfile(this.config, session.profileId, preferred);
    } catch {
      return undefined;
    }
  }

  /**
   * RFC-021: snapshot the profile's weekly Grok credit % at session open so
   * later end_turn snapshots can compute a per-session delta. Grok backend
   * only. Never throws — a billing failure leaves start undefined and the
   * meter renders as "unknown" on clients.
   */
  private async snapshotSessionOpenCredits(session: DispatchSession): Promise<void> {
    if (!isGrokBackend(session.backend)) return;
    const profile = this.profileFor(session);
    if (!profile) return;
    const pct = await fetchGrokWeeklyCreditPct(profile, this.config.dataDir);
    applyOpenCreditSnapshot(session, pct, now());
  }

  /**
   * RFC-021: refresh the "last" snapshot after end_turn and recompute delta.
   * Skips the fetch when the last snapshot is younger than 30 s to protect
   * the billing endpoint on tool-heavy fast-turn bursts.
   */
  private async snapshotEndTurnCredits(session: DispatchSession): Promise<void> {
    if (!isGrokBackend(session.backend)) return;
    if (!shouldSnapshotEndTurnCredits(session, Date.now())) return;
    const profile = this.profileFor(session);
    if (!profile) return;
    const pct = await fetchGrokWeeklyCreditPct(profile, this.config.dataDir);
    applyEndTurnCreditSnapshot(session, pct, now());
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
        mcpServers: await this.acpMcpServersFor(session),
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

  /**
   * Scheduler / REST `/bots/:id/run` entry. Always uses the bot's standing job
   * as the prompt, even if the profile would otherwise be used via /dispatch.
   */
  async fireBot(bot: Bot, note?: string): Promise<DispatchSession> {
    resolveProfile(this.config, bot.profileId);
    const extra = note?.trim();
    const prompt = extra
      ? `This run's extra instruction (one-shot):\n${extra}\n\n---\nStanding job:\n${bot.job}`
      : bot.job;
    const firstLine = extra?.split("\n")[0]?.trim() ?? "";
    const title = firstLine ? `${bot.name}: ${firstLine.slice(0, 60)}` : `${bot.name} run`;
    return this.dispatch({
      prompt,
      projectId: bot.projectId,
      profileId: bot.profileId,
      title,
      botId: bot.id,
      maxTurns: bot.maxTurnsPerRun,
      botTools: bot.tools,
    });
  }

  hasActiveRun(botId: string): boolean {
    for (const s of this.list()) {
      if (s.botId === botId && BotScheduler.isActiveStatus(s.status)) return true;
    }
    for (const [sid, run] of this.botRuns) {
      if (run.cancelled) continue;
      const s = this.get(sid);
      if (s?.botId === botId) return true;
    }
    return false;
  }

  private async botTurn(
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
      this.persist(session);
      this.emitEvent(session, "transcript", entry);
    }

    const owner = this.profileFor(session);
    if (!owner) throw new Error("Bot session has no profile");
    const profile = this.botBrainProfile(owner);

    const abort = new AbortController();
    const run: BotRunState = { sessionId: session.id, cancelled: false, abort };
    this.botRuns.set(session.id, run);

    try {
      await runBotSession({
        session,
        profile,
        prompt,
        isFollowUp,
        maxTurns: maxTurns ?? 20,
        toolsAllowlist: botTools?.length ? botTools : owner.toolAllowlist,
        promptMaxMs: this.config.promptMaxMs,
        autoApproveKinds: (this.config.autoApproveKinds ?? []).map((k) => k.toLowerCase()),
        callbacks: {
          persist: (s) => this.persist(s),
          emit: (s, type, payload) => this.emitEvent(s, type, payload),
          isCancelled: () => run.cancelled,
          requestApproval: (s, approval) =>
            new Promise((resolve, reject) => {
              if (run.cancelled) {
                reject(new Error("cancelled"));
                return;
              }
              run.pending = { approvalId: approval.id, resolve, reject };
              this.maybeNotify("Bot needs approval", `${s.title}: ${approval.title}`);
            }),
        },
        signal: abort.signal,
      });
    } finally {
      this.botRuns.delete(session.id);
    }
  }

  private async runSession(session: DispatchSession, req: DispatchRequest): Promise<void> {
    const imgs = normalizeImages(req.images);
    if (session.backend === "claude") {
      await this.claudeTurn(session.id, session.prompt, imgs, { recordUser: false });
      return;
    }
    if (session.backend === "antigravity") {
      await this.antigravityTurn(session.id, session.prompt, imgs, { recordUser: false });
      return;
    }
    if (session.backend === "bot") {
      await this.botTurn(session, session.prompt, false, req.maxTurns, req.botTools);
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
        mcpServers: await this.acpMcpServersFor(session),
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
      if (session.extraDirs?.length) {
        newParams._meta = { ...(newParams._meta as object), extraDirs: session.extraDirs };
      }

      const result = (await client.request("session/new", newParams)) as {
        sessionId?: string;
      };
      session.grokSessionId = result.sessionId ?? randomUUID();
      session.status = "running";
      session.updatedAt = now();
      await this.snapshotSessionOpenCredits(session);
      this.persist(session);
      this.emitEvent(session, "session.updated", { grokSessionId: session.grokSessionId, status: "running" });

      const profile = this.profileFor(session);
      const promptText = composeGrokOpeningPrompt({
        prompt: session.prompt,
        planMode: session.planMode,
        extraDirs: session.extraDirs,
        systemPrompt: profile?.systemPrompt,
      });

      await this.promptTurn(live, promptText, imgs);
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

    // Persist attachments on disk (session dir + project dir if applicable)
    // and send ACP image content blocks below.
    savePromptImagesForSession(this.config, session, images);

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
      // Trust the persisted session — the in-memory LiveSession bookkeeping
      // maps drift out of sync (RFC-019 chased a phantom question that
      // stranded sessions on `running` forever).
      if (shouldFlipToIdleAfterTurn(live.session)) {
        // Idle = ready for another message (multi-turn). Not a terminal "Done".
        live.session.status = "idle";
        live.session.updatedAt = now();
        await this.snapshotEndTurnCredits(live.session);
        this.persist(live.session);
        this.emitEvent(live.session, "session.updated", {
          stopReason: result.stopReason,
          status: "idle",
          creditsUsedDeltaPct: live.session.creditsUsedDeltaPct,
          creditsUsedAt: live.session.creditsUsedAt,
        });
        this.maybeNotify("ClankerSpanker", `Your turn: ${live.session.title}`);
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
            ...toolOutputSummary(update.content, update.rawOutput),
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
            // RFC-040: keep a short tail of command output + exit code.
            if (update.content || update.rawOutput) {
              const summary = toolOutputSummary(existing.content, update.rawOutput);
              if (summary.outputPreview !== undefined) existing.outputPreview = summary.outputPreview;
              if (summary.exitCode !== undefined) existing.exitCode = summary.exitCode;
            }
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
    this.persist(live.session);

    this.emitEvent(live.session, "approval.needed", publicApproval);
    this.emitEvent(live.session, "session.updated", {
      status: "awaiting_approval",
      planExit: true,
      planMode: live.session.planMode,
    });
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
      // Clear soft pending if tool finished. Drain matching entries from
      // `live.pendingQuestions` too — leaving them behind used to keep
      // the end-of-turn block from flipping to idle (RFC-019).
      if (live.session.pendingQuestion?.toolCallId === record.toolCallId) {
        live.session.pendingQuestionId = undefined;
        live.session.pendingQuestion = null;
        if (live.session.status === "awaiting_question") live.session.status = "running";
        this.persist(live.session);
      }
      drainPendingQuestionsByToolCall(live.pendingQuestions, record.toolCallId);
      return;
    }
    const questions = normalizeQuestions(ri.questions);
    if (questions.length === 0) return;
    this.parkSoftQuestions(live, questions, record.toolCallId, record.title);
  }

  /**
   * Show a questionnaire in the UI before the `x.ai/ask_user_question` RPC
   * arrives. No rpcId — answering goes through the soft follow-up path unless
   * the real extension request replaces this first.
   */
  private parkSoftQuestions(
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
        this.parkSoftQuestions(live, maybeQs, toolCall.toolCallId, toolCall.title);
      }
      return;
    }

    const grokProfile = this.profileFor(live.session);
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
    if (this.config.autoApproveKinds.map((k) => k.toLowerCase()).includes(kind)) {
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
    this.persist(live.session);

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
    this.hydrated.set(session.id, session);
    this.store.save(session);
  }

  private emitEvent(session: DispatchSession, type: SessionEvent["type"], payload: unknown): void {
    const seq = this.nextSeq(session);
    const event: SessionEvent = {
      type,
      sessionId: session.id,
      at: now(),
      payload,
      seq,
    };
    session.events.push(event);
    // Keep event log bounded
    if (session.events.length > 500) {
      session.events = session.events.slice(-400);
    }
    this.emit("event", event);
  }

  private nextSeq(session: DispatchSession): number {
    let current = this.eventSeq.get(session.id);
    if (current === undefined) {
      // Initialize from the highest seq already persisted so replay stays
      // monotonic across host restarts.
      let max = 0;
      for (const e of session.events ?? []) {
        if (typeof e.seq === "number" && e.seq > max) max = e.seq;
      }
      current = max;
    }
    current += 1;
    this.eventSeq.set(session.id, current);
    return current;
  }

  /** Return events strictly after `sinceSeq`, oldest first. Used by
   *  `/sessions/:id/events?since=N` for client replay on reconnect. */
  getEventsSince(sessionId: string, sinceSeq: number): SessionEvent[] {
    const session = this.get(sessionId);
    if (!session) return [];
    const events = session.events ?? [];
    return events
      .filter((e) => typeof e.seq === "number" && e.seq > sinceSeq)
      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  }

  /** Server calls this once during setup to wire up the local-client check. */
  setLocalClientChecker(fn: () => boolean): void {
    this.hasLocalClientCheck = fn;
  }

  private maybeNotify(title: string, message: string): void {
    if (!(this.config.notifyDesktop ?? this.config.notifyMac)) return;
    // Skip the shell-based desktop notification when a local Mac client is
    // connected — it posts its own richer local notification (with action
    // buttons for approvals). Prevents the two-banner duplicate.
    if (this.hasLocalClientCheck?.()) return;
    notifyDesktop(title, message);
  }

  async shutdown(): Promise<void> {
    for (const run of this.botRuns.values()) {
      run.cancelled = true;
      run.abort.abort("cancelled");
      run.pending?.reject(new Error("shutdown"));
    }
    this.botRuns.clear();
    const stops = [...this.live.values()].map((l) => l.client.stop());
    await Promise.allSettled(stops);
    this.live.clear();
  }
}
