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

export interface ProjectInfo {
  id: string;
  name: string;
  path: string;
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
}

export type SessionBackend = "grok" | "claude";

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
   * Never returned to clients via API.
   */
  env?: Record<string, string>;
  /** Optional override of Claude home/config directory for full multi-login isolation. */
  claudeConfigDir?: string;
  /** Default model id when dispatching with this profile. */
  model?: string;
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
}

export interface DispatchSession {
  id: string;
  /** Which agent process powers this Dispatch chat. Default grok. */
  backend?: SessionBackend;
  /** Agent profile (account) this session runs under. */
  profileId?: string;
  /** Denormalized display name for list UI. */
  profileName?: string;
  /** Denormalized color for list UI. */
  profileColor?: string;
  grokSessionId?: string;
  /** Claude Code session UUID when backend=claude or attached from Claude history. */
  claudeSessionId?: string;
  title: string;
  prompt: string;
  cwd: string;
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
  /** Snapshot of the current questionnaire for phone UI (also on live map). */
  pendingQuestion?: PendingQuestion | null;
  transcript: TranscriptEntry[];
  toolCalls: ToolCallRecord[];
  plan?: PlanEntry[];
  events: SessionEvent[];
  /** Soft-hide from Active tab; still openable and restorable. */
  archived?: boolean;
  archivedAt?: string;
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
  /** True when we hold a live ACP request id to respond to. */
  canRespondViaAcp?: boolean;
}

export interface AnswerQuestionsRequest {
  questionId?: string;
  /** One answer string per question (for multiSelect, join labels with " | "). */
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
  | "diff"
  | "usage"
  | "error";

export interface SessionEvent {
  type: SessionEventType;
  sessionId: string;
  at: string;
  payload: unknown;
}

export interface ApproveRequest {
  approvalId: string;
  optionId?: string;
  comment?: string;
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
  profileId?: string;
  profileName?: string;
  profileColor?: string;
  claudeSessionId?: string;
}

export interface PublicSessionDetail extends PublicSessionSummary {
  subagents: boolean;
  worktree: boolean;
  stopReason?: string;
  transcript: TranscriptEntry[];
  toolCalls: ToolCallRecord[];
  plan?: PlanEntry[];
  pendingApproval?: PendingApproval | null;
  pendingQuestion?: PendingQuestion | null;
}
