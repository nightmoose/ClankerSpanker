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
}

export type SessionBackend = "grok" | "claude";

export interface DispatchSession {
  id: string;
  /** Which agent process powers this Dispatch chat. Default grok. */
  backend?: SessionBackend;
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

export interface PromptFollowUpRequest {
  prompt: string;
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
}

export interface HostConfigFile {
  hostToken: string;
  bindHost: string;
  bindPort: number;
  grokBinary: string;
  projects: ProjectInfo[];
  allowCustomPaths: boolean;
  /** Tool kinds that auto-approve without phone (default: read/search/think/fetch). */
  autoApproveKinds: string[];
  notifyMac: boolean;
  dataDir: string;
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
