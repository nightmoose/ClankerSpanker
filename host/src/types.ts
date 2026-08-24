/** Shared host API types (mirrored in the iOS models). */

export type SessionStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  /** Agent asked clarifying questions (ask_user_question). */
  | "awaiting_question"
  /** Turn finished; conversation still open for follow-ups. */
  | "idle"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * External-context resource attached to a project: docs URL, notes,
 * runbook link. Kept extensible via `kind` so we can add richer types later.
 */
export interface ProjectResource {
  id: string;
  kind: "url" | "note" | "doc";
  label: string;
  value: string;
  addedAt: string;
}

/**
 * Uploaded file (image, doc, whatever) stored under a project's directory.
 * Persists across sessions so any session in the project can reference it
 * for context. `fromSessionId` records the session that originally uploaded
 * it (e.g. a screenshot sent as a follow-up in one session, later reused).
 */
export interface ProjectAttachment {
  id: string;
  filename: string;
  originalName?: string;
  mimeType: string;
  sizeBytes: number;
  addedAt: string;
  fromSessionId?: string;
  note?: string;
}

export interface ProjectInfo {
  id: string;
  name: string;
  /**
   * All candidate working directories for sessions started under this
   * project (frontend + backend, monorepo + companion repo, etc.). Sessions
   * pick one at start time. Length ≥ 1 after normalizeProject().
   */
  paths: string[];
  /**
   * Legacy single-path field, always mirrors `paths[0]` after normalization.
   * Kept required on the wire so older clients that only read `path`
   * continue to work.
   */
  path: string;
  /** UI accent (hex string like "#73B8FF"), matches the profile color idiom. */
  color?: string;
  resources?: ProjectResource[];
  attachments?: ProjectAttachment[];
  /** Suggested default profile for new sessions in this project — not enforced. */
  defaultProfileId?: string;
  archived?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface DispatchRequest {
  prompt: string;
  /** Project id from host allowlist, or absolute path if allowCustomPaths. */
  projectId?: string;
  cwd?: string;
  title?: string;
  model?: string;
  planMode?: boolean;
  subagents?: boolean;
  worktree?: boolean;
  permissionMode?: "default" | "acceptEdits" | "dontAsk";
  /** Agent profile id (FullScore / Astro / NightMoose …). Required for multi-account Claude. */
  profileId?: string;
  /** When set, this dispatch is a scheduled/manual bot run. */
  botId?: string;
  /** Bot loop cap (default 20). */
  maxTurns?: number;
  /** Bot tool allowlist. */
  botTools?: string[];
  /** Optional screenshots on the opening turn (same shape as follow-up images). */
  images?: PromptImage[];
  /**
   * Extra workspace folders besides `cwd`. Claude/Antigravity get `--add-dir`;
   * Grok is told about them in-session. Validated like cwd (must exist; custom
   * paths honor allowCustomPaths).
   */
  extraDirs?: string[];
}

export type SessionBackend = "grok" | "claude" | "antigravity" | "bot";

/**
 * Concurrent agent identity. Multiple Claude profiles can run at once
 * (each with its own API key / config dir). Shown as colored nav segments on clients.
 */
export interface AgentProfile {
  id: string;
  /** Display name in the phone/browser nav, e.g. FullScore, Astro, NightMoose */
  name: string;
  backend: SessionBackend;
  /** Hex (#F97316) or simple name (orange, blue, purple, green, amber) */
  color: string;
  /**
   * Process env for this profile only (merged over process.env when spawning).
   * Typical: ANTHROPIC_API_KEY, optional CLAUDE_CONFIG_DIR for full isolation.
   * Antigravity: GEMINI_API_KEY / GOOGLE_API_KEY when not using keyring login.
   * Never returned to clients via API.
   */
  env?: Record<string, string>;
  /** Optional override of Claude home/config directory for full multi-login isolation. */
  claudeConfigDir?: string;
  /**
   * Optional path to Antigravity CLI settings dir (default ~/.gemini/antigravity-cli).
   * Reserved for multi-account isolation when the CLI grows support.
   */
  antigravityConfigDir?: string;
  /** Default model id when dispatching with this profile. */
  model?: string;
  /**
   * Optional persona / project-context text appended to the agent's system
   * prompt (Claude: `--append-system-prompt`). Keeps recurring instructions
   * out of every dispatch and shrinks the user prompt.
   */
  systemPrompt?: string;
  /**
   * Per-profile auto-approve allowlist. Each entry is a Claude approval
   * signature (see claudeApprovalSignature) that skips the phone gate for
   * this account. Example: `"claude:bash:git status"`, `"claude:read"`.
   * Broader than session-scoped auto-approve — persists across sessions.
   */
  toolAllowlist?: string[];
}

/** Safe profile for wire format (no secrets). */
export interface PublicAgentProfile {
  id: string;
  name: string;
  backend: SessionBackend;
  color: string;
  model?: string;
  /** True when a non-empty API key / env is configured for this profile. */
  hasCredentials: boolean;
  /** Persona / append-system-prompt configured for this profile (Claude only). */
  systemPrompt?: string;
  /** Auto-approve signatures for this profile (persist across sessions). */
  toolAllowlist?: string[];
  /**
   * Live quota / readiness. Populated by GET /profiles?usage=1 (Claude OAuth
   * 5h + weekly windows, Grok weekly credits, Gemini Cloud Code remainingFraction).
   */
  usage?: ProfileUsage;
}

/**
 * Per-profile capacity signal so clients can see who still has room to work.
 * Claude: Anthropic OAuth `/api/oauth/usage` (utilization = % used).
 */
export interface ProfileUsage {
  status: "ok" | "limited" | "unknown" | "error" | "api_key";
  /** 5-hour rolling window utilization 0–100 (Claude subscription). */
  fiveHourPercent?: number;
  fiveHourResetsAt?: string;
  /** 7-day window utilization 0–100. */
  sevenDayPercent?: number;
  sevenDayResetsAt?: string;
  sevenDayOpusPercent?: number;
  /** Short label for chips, e.g. "5h 12% · wk 2%". */
  label?: string;
  accountEmail?: string;
  /** False when quota is exhausted or credentials missing. */
  canWork?: boolean;
  error?: string;
  fetchedAt?: string;
}

/**
 * Cumulative token accounting for one Dispatch session. Sourced from the
 * agent's stream (Claude: `message.usage` on assistant chunks + `result`).
 * `cacheRead / cacheCreation` show how much of the prompt hit Anthropic's
 * prompt cache — non-zero values indicate the session is cache-friendly.
 */
export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Turn count contributing to the totals. */
  turns: number;
  updatedAt: string;
}

/**
 * A user-captured action item derived from a session — either the whole
 * message text ("Save as todo"), a picked sub-item from an auto-scan
 * ("Scan for todo"), or a free-typed entry. Stored on the session so the
 * source is always recoverable; also aggregated globally.
 */
export interface SessionTask {
  id: string;
  sourceSessionId: string;
  /** Transcript entry id this came from, if any. */
  sourceMessageId?: string;
  /** Project the source session belongs to (snapshotted at creation). */
  projectId?: string;
  text: string;
  status: "open" | "done";
  createdAt: string;
  updatedAt?: string;
  completedAt?: string;
}

/**
 * Free-form user note. Same source-linking model as SessionTask but no
 * open/done state — it's just a jot the user attaches to remember why a
 * message mattered.
 */
export interface SessionNote {
  id: string;
  sourceSessionId: string;
  sourceMessageId?: string;
  text: string;
  createdAt: string;
  updatedAt?: string;
}

/**
 * Autonomous hunter/actor worker. Persisted in ~/.grok-dispatch/bots.json
 * (not stuffed into config.json). Runs on the in-process `bot` backend.
 */
export interface Bot {
  id: string;
  name: string;
  enabled: boolean;
  /** Brain — profile backend must be "bot". */
  profileId: string;
  /** cwd, e.g. contractgate */
  projectId: string;
  /** Standing instructions sent as the user prompt on each fire. */
  job: string;
  /** "1h" | "6h" | "1d" (also Ns/Nm). */
  interval: string;
  /** Tool name allowlist. Empty / omitted = all v1 tools. */
  tools: string[];
  /** Hard cap on model→tool turns per run. Default 20. */
  maxTurnsPerRun: number;
  lastRunAt?: string;
  lastSessionId?: string;
}

export interface DispatchSession {
  id: string;
  /** Which agent process powers this Dispatch chat. Default grok. */
  backend?: SessionBackend;
  /** Set when this session was started by a Bot scheduler / manual /run. */
  botId?: string;
  /** Agent profile (account) this session runs under. */
  profileId?: string;
  /** Denormalized display name for list UI. */
  profileName?: string;
  /** Denormalized color for list UI. */
  profileColor?: string;
  grokSessionId?: string;
  /** Claude Code session UUID when backend=claude or attached from Claude history. */
  claudeSessionId?: string;
  /** Antigravity CLI conversation_id when backend=antigravity (for --conversation resume). */
  antigravityConversationId?: string;
  title: string;
  prompt: string;
  cwd: string;
  /** Extra workspace folders besides cwd (Claude/Antigravity `--add-dir`). */
  extraDirs?: string[];
  projectId?: string;
  model: string;
  planMode: boolean;
  subagents: boolean;
  worktree: boolean;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
  stopReason?: string;
  pendingApprovalId?: string;
  pendingQuestionId?: string;
  /**
   * Snapshot of the current approval for phone UI (also on live map).
   * Persisted so pending approvals survive host restarts and can be shown to
   * the user via REST after reconnect. The persisted copy never holds an rpcId
   * — a rehydrated approval is orphaned. Approving it auto-resumes the session
   * (see resolveApproval); rejecting it dismisses without spawning.
   */
  pendingApproval?: PendingApproval | null;
  /** Snapshot of the current questionnaire for phone UI (also on live map). */
  pendingQuestion?: PendingQuestion | null;
  /**
   * Session-scoped auto-approve allowlist. When the user resolves an approval
   * with `scope: "always_session"`, the derived signature is added here and
   * subsequent matching approvals skip the phone.
   */
  autoApproveSignatures?: string[];
  /**
   * User-captured action items surfaced from this session (typically from a
   * long-press "Save as todo" / "Scan for todo" on a transcript message).
   * Persisted with the session; also exposed globally via `GET /tasks`.
   */
  tasks?: SessionTask[];
  /**
   * Free-form user notes attached to this session (optionally linked to a
   * specific transcript message via `sourceMessageId`).
   */
  notes?: SessionNote[];
  transcript: TranscriptEntry[];
  toolCalls: ToolCallRecord[];
  plan?: PlanEntry[];
  events: SessionEvent[];
  /** Soft-hide from Active tab; still openable and restorable. */
  archived?: boolean;
  archivedAt?: string;
  /**
   * After a profile transfer, the next follow-up injects a transcript handoff
   * into the new agent session (Claude account / Grok cannot resume the old id).
   */
  transferHandoffPending?: boolean;
  /**
   * Cumulative token usage over the life of this session. Updated on every
   * turn that surfaces a `usage` block in the stream. Undefined until the
   * first turn completes with metrics.
   */
  usage?: SessionUsage;
}

export interface TranscriptEntry {
  id: string;
  role: "user" | "assistant" | "thought" | "system";
  text: string;
  at: string;
}

export interface ToolCallRecord {
  toolCallId: string;
  title: string;
  kind?: string;
  status: string;
  rawInput?: unknown;
  locations?: Array<{ path: string; line?: number }>;
  content?: unknown;
  updatedAt: string;
}

/** GET /sessions/:id/tool-calls/:toolCallId — full tool payload for the ellipsis sheet. */
export interface PublicToolCallDetail {
  toolCallId: string;
  title: string;
  kind?: string;
  status: string;
  updatedAt: string;
  locations?: Array<{ path: string; line?: number }>;
  rawInputJson: string | null;
  contentJson: string | null;
}

export interface PlanEntry {
  content: string;
  priority?: string;
  status?: string;
}

export interface ApprovalOption {
  optionId: string;
  name: string;
  kind: string;
}

export interface PendingApproval {
  id: string;
  sessionId: string;
  toolCallId?: string;
  title: string;
  kind?: string;
  rawInput?: unknown;
  locations?: Array<{ path: string; line?: number }>;
  options: ApprovalOption[];
  createdAt: string;
  /** ISO timestamp after which the sweeper auto-rejects this approval. */
  expiresAt?: string;
  /** Optional comment attached on reject/approve from phone */
  comment?: string;
}

export interface QuestionOption {
  label: string;
  description?: string;
  preview?: string;
}

export interface AgentQuestion {
  question: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

export interface PendingQuestion {
  id: string;
  sessionId: string;
  toolCallId?: string;
  title: string;
  questions: AgentQuestion[];
  createdAt: string;
  /** ISO timestamp after which the sweeper auto-skips this question. */
  expiresAt?: string;
  /** True when we hold a live ACP request id to respond to. */
  canRespondViaAcp?: boolean;
}

export interface AnswerQuestionsRequest {
  questionId?: string;
  /** One answer string per question (for multiSelect, join labels with ", "). */
  answers: string[];
  /** freeform extra notes */
  comment?: string;
  /** accepted | skip | chat */
  outcome?: "accepted" | "skip" | "chat";
}

export type SessionEventType =
  | "session.created"
  | "session.updated"
  | "session.completed"
  | "session.failed"
  | "transcript"
  | "thought"
  | "tool_call"
  | "tool_call_update"
  | "plan"
  | "approval.needed"
  | "approval.resolved"
  | "question.needed"
  | "question.answered"
  | "task.created"
  | "task.updated"
  | "task.deleted"
  | "note.created"
  | "note.updated"
  | "note.deleted"
  | "diff"
  | "usage"
  | "error";

export interface SessionEvent {
  type: SessionEventType;
  sessionId: string;
  at: string;
  payload: unknown;
  /**
   * Monotonic per-session sequence number. Clients pass their highest seen seq
   * via `GET /sessions/:id/events?since=N` on reconnect so replay recovers any
   * events that fired during a WebSocket gap.
   */
  seq?: number;
}

export interface ApproveRequest {
  approvalId: string;
  optionId?: string;
  comment?: string;
  /**
   * "once" (default) approves this one call. "always_session" also adds a
   * signature to the session's autoApproveSignatures so subsequent matching
   * approvals are auto-resolved without pinging the phone.
   */
  scope?: "once" | "always_session";
}

export interface RejectRequest {
  approvalId: string;
  optionId?: string;
  comment?: string;
}

/** Screenshot / photo attached to a follow-up prompt (base64, no data: URL prefix). */
export interface PromptImage {
  mimeType: string;
  data: string;
  name?: string;
}

export interface PromptFollowUpRequest {
  prompt: string;
  /** Optional screenshots for UI/app debugging (ACP image blocks / Claude file paths). */
  images?: PromptImage[];
}

/** Move a Dispatch session to another agent profile (FullScore → Personal, Claude → Grok, …). */
export interface TransferProfileRequest {
  profileId: string;
}

/**
 * Reincarnate: archive the old chat and start a fresh session in the same project
 * with a compact transcript summary as the opening prompt.
 */
export interface ReincarnateRequest {
  /** Optional profile override; defaults to the source session's profile. */
  profileId?: string;
  /** Optional title for the new session. */
  title?: string;
  /** Extra kickoff note appended after the summary. */
  note?: string;
}

/**
 * Review recent work: spawn a *separate* critique session from an existing chat's
 * history (+ optional git diff). Does **not** archive, transfer, or take over the source.
 */
export interface ReviewWorkRequest {
  /** Profile that performs the review; defaults to the source session's profile. */
  profileId?: string;
  /** Optional title for the review session. */
  title?: string;
  /** Optional focus note (e.g. "focus on security", "tests only"). */
  note?: string;
  /**
   * Include `git diff` / status from the session cwd (default true).
   * Helps the reviewer see what was actually changed on disk.
   */
  includeDiff?: boolean;
}

/** Attach / resume an existing Grok Build session from ~/.grok/sessions. */
export interface AttachRequest {
  /** Native Grok session UUID (from disk or TUI). */
  grokSessionId: string;
  cwd: string;
  title?: string;
  model?: string;
  /** Optional first message after attach. */
  prompt?: string;
  profileId?: string;
}

/**
 * Open a Claude Code session from ~/.claude/projects.
 * - continue-with-grok: hand context to a new Grok session (full Dispatch UX)
 * - resume-claude: keep using Claude headlessly via `claude -p --resume`
 */
export interface AttachClaudeRequest {
  claudeSessionId: string;
  cwd: string;
  title?: string;
  mode?: "continue-with-grok" | "resume-claude";
  /** Optional first message after open. */
  prompt?: string;
  transcriptPath?: string;
  /** Which Claude account profile to use for resume / handoff. */
  profileId?: string;
}

export interface HostConfigFile {
  hostToken: string;
  bindHost: string;
  bindPort: number;
  grokBinary: string;
  projects: ProjectInfo[];
  allowCustomPaths: boolean;
  /** Concurrent agent accounts — each is a colored nav segment on clients. */
  profiles: AgentProfile[];
  /** Tool kinds that auto-approve without client (default: read/search/think/fetch). */
  autoApproveKinds: string[];
  /**
   * Desktop OS notifications when a session needs attention.
   * Prefer `notifyDesktop`. `notifyMac` is accepted as a legacy alias when loading config.
   */
  notifyDesktop: boolean;
  /** @deprecated Use notifyDesktop */
  notifyMac?: boolean;
  dataDir: string;
  /**
   * Idle hang detection for open `session/prompt` turns (ms of no ACP activity).
   * Default 15 minutes. Frozen while awaiting phone approval/answers. `0` disables.
   */
  promptIdleTimeoutMs?: number;
  /**
   * Absolute ceiling for a single `session/prompt` (ms). Default 6 hours. `0` disables.
   * This is NOT the old 120s wall clock — only an orphan safety net.
   */
  promptMaxMs?: number;
}

export interface PublicSessionSummary {
  id: string;
  grokSessionId?: string;
  title: string;
  prompt: string;
  cwd: string;
  projectId?: string;
  model: string;
  planMode: boolean;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
  pendingApprovalId?: string;
  toolCallCount: number;
  transcriptPreview?: string;
  /** ACP process currently held open on the host for multi-turn. */
  isLive?: boolean;
  archived?: boolean;
  archivedAt?: string;
  backend?: SessionBackend;
  botId?: string;
  profileId?: string;
  profileName?: string;
  profileColor?: string;
  claudeSessionId?: string;
  antigravityConversationId?: string;
}

export interface SessionFileEntry {
  path: string;
  kind: "file" | "folder" | "attachment";
  title?: string;
  updatedAt?: string;
}

export interface SessionFileContent {
  path: string;
  name: string;
  mimeType: string;
  size: number;
  encoding: "utf8" | "base64";
  text?: string;
  data?: string;
  truncated?: boolean;
  binary?: boolean;
}

export interface PublicSessionDetail extends PublicSessionSummary {
  extraDirs?: string[];
  subagents: boolean;
  worktree: boolean;
  stopReason?: string;
  transcript: TranscriptEntry[];
  toolCalls: ToolCallRecord[];
  plan?: PlanEntry[];
  pendingApproval?: PendingApproval | null;
  pendingQuestion?: PendingQuestion | null;
  tasks?: SessionTask[];
  notes?: SessionNote[];
  usage?: SessionUsage;
}
