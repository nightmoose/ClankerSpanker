// Extracted from session-manager.ts (RFC-051 phase A). Behavior unchanged.
import { basename } from "node:path";
import type { DispatchSession, PendingApproval, PendingQuestion, TranscriptEntry } from "../types.js";
import { extraDirsAgentNote } from "../sessions/files.js";
import { wrapWithProfileSystemPrompt } from "../profiles.js";
import { AcpClient } from "./client.js";

export function now(): string {
  return new Date().toISOString();
}

/** Default TTL for a pending approval / question before the sweeper auto-fails it. */
export const DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60_000;
/** How often the sweeper walks live sessions looking for expired items. */
export const APPROVAL_SWEEP_INTERVAL_MS = 60_000;

export function expiresInIso(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

/**
 * Bash commands considered read-only / non-mutating. Matched against the
 * FIRST TOKEN of the command (after any leading env-var assignments like
 * `FOO=bar bash-cmd ...`). Anything matched here is auto-approved without
 * asking the phone. Curated conservatively — any command that could mutate
 * disk state, network state, or run arbitrary subshells is intentionally
 * excluded.
 */
export const SAFE_BASH_COMMANDS: ReadonlySet<string> = new Set([
  // Files / listing / reading
  "ls", "pwd", "cat", "head", "tail", "wc", "file", "stat", "du", "df",
  "less", "more", "readlink", "realpath", "basename", "dirname",
  // Text search
  "grep", "rg", "ack", "ag", "fgrep", "egrep",
  // File search
  "find", "fd", "locate",
  // Git (read-only subcommands only — see SAFE_GIT_SUBCOMMANDS below)
  "git",
  // Environment / system probes
  "which", "whereis", "type", "command", "env", "printenv",
  "date", "uptime", "uname", "arch", "hostname", "id", "whoami",
  "groups", "tty", "sw_vers",
  // Process / status
  "ps", "top", "jobs",
  // Simple text pipes
  "echo", "printf", "true", "false", "yes", "test",
  "sort", "uniq", "cut", "paste", "tr", "sed", "awk", "column", "tee",
  "diff", "cmp", "md5", "shasum", "sha256sum", "md5sum",
  // Node/Python/Ruby version probes (safe — no side effects)
  "node", "npm", "npx", "yarn", "pnpm",
  "python", "python3", "pip", "pip3",
  "ruby", "gem",
  "go",
  "swift", "xcodebuild",
  // Above language runtimes are ONLY safe with --version / --help style
  // args; the full check below narrows to those.
]);

/**
 * Read-only git subcommands. `git <subcommand>` must be one of these to be
 * auto-approved. `git commit`, `git push`, `git pull`, `git checkout`, etc. are
 * gated because they mutate state.
 */
export const SAFE_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "status", "diff", "log", "show", "blame", "branch", "remote",
  "config", "rev-parse", "describe", "shortlog", "reflog", "stash",
  "ls-files", "ls-tree", "cat-file", "grep", "help", "--version", "version",
]);

/**
 * Commands like `node --version` are safe; `node script.js` may not be
 * (it runs arbitrary user code). Narrow the language runtimes to
 * version/help args only.
 */
export const RUNTIME_VERSION_ONLY: ReadonlySet<string> = new Set([
  "node", "npm", "npx", "yarn", "pnpm",
  "python", "python3", "pip", "pip3",
  "ruby", "gem", "go", "swift", "xcodebuild",
]);

/**
 * Return true if the given bash `command` string is safe to auto-approve.
 * We tokenize by whitespace (ignoring leading VAR=value env assignments)
 * and inspect the head. For git, require a read-only subcommand. For
 * language runtimes, require --version / -v / --help.
 */
export function isSafeBashCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  // Reject compound commands and shell metacharacters — even if the first
  // piece is safe, we don't want to greenlight ` && rm -rf /`.
  if (/[;&|`$><]/.test(trimmed)) return false;
  if (trimmed.includes("$(") || trimmed.includes("`")) return false;

  // Skip leading env-var assignments (FOO=bar CMD=...).
  const tokens = trimmed.split(/\s+/);
  let i = 0;
  while (i < tokens.length && /^[A-Z_][A-Z0-9_]*=/.test(tokens[i]!)) i++;
  if (i >= tokens.length) return false;

  const head = tokens[i]!;
  const rest = tokens.slice(i + 1);

  if (!SAFE_BASH_COMMANDS.has(head)) return false;

  if (head === "git") {
    const sub = rest.find((t) => !t.startsWith("-"));
    if (!sub || !SAFE_GIT_SUBCOMMANDS.has(sub)) return false;
    return true;
  }
  if (RUNTIME_VERSION_ONLY.has(head)) {
    // Only allow bare invocation or --version/-v/--help style
    if (rest.length === 0) return true;
    return rest.every((t) => /^(-v|--version|-V|--help|-h)$/.test(t));
  }
  return true;
}

/**
 * Derive a stable signature for a Claude approval used by the
 * "Always this session" allowlist. Key format: `claude:<tool>:<primary-arg>`.
 * `Edit`, `Write` → file_path; `Bash` → the full command; others → tool name.
 */
export function claudeApprovalSignature(toolName: string, toolInput: unknown): string {
  const input = (toolInput ?? {}) as Record<string, unknown>;
  const t = toolName.toLowerCase();
  if (t === "bash") {
    const cmd = String(input.command ?? "").trim();
    return `claude:bash:${cmd}`;
  }
  if (t === "edit" || t === "write" || t === "multiedit" || t === "notebookedit") {
    const p = String(input.file_path ?? input.path ?? "").trim();
    return `claude:${t}:${p}`;
  }
  if (t === "delete") {
    const p = String(input.file_path ?? input.path ?? "").trim();
    return `claude:delete:${p}`;
  }
  return `claude:${t}`;
}

/**
 * Signature for a Grok ACP session/request_permission approval. Uses
 * `<kind>:<title>` — narrower than kind alone, so approving "Edit file X" won't
 * silently greenlight "Edit file Y".
 */
export function grokApprovalSignature(kind: string | undefined, title: string): string {
  return `grok:${(kind ?? "other").toLowerCase()}:${title.trim()}`;
}

/**
 * Continuation prompt used when the user resolves an approval after the agent
 * process is gone (host restart). Tapping Approve must resume work, not park
 * the session as "your turn" and wait for a manual follow-up.
 */
export function buildOrphanedApprovalResumePrompt(opts: {
  decision: "approve" | "reject";
  title: string;
  rawInput?: unknown;
  comment?: string;
}): string {
  let input = "";
  if (opts.rawInput !== undefined) {
    try {
      input = `\nTool input:\n${JSON.stringify(opts.rawInput, null, 2).slice(0, 2000)}`;
    } catch {
      input = `\nTool input: ${String(opts.rawInput).slice(0, 500)}`;
    }
  }
  const comment = opts.comment?.trim() ? `\nUser comment: ${opts.comment.trim()}` : "";
  if (opts.decision === "approve") {
    return (
      `[Host continuation] The previous turn was interrupted (host restarted) while waiting for permission to run:\n` +
      `${opts.title}${input}${comment}\n\n` +
      `The user APPROVED this action. Continue the original task from where you left off. ` +
      `Perform this approved action now — do not re-ask for permission for this specific action. ` +
      `Do not restart work that already completed.`
    );
  }
  return (
    `[Host continuation] The previous turn was interrupted while waiting for permission to run:\n` +
    `${opts.title}${input}${comment}\n\n` +
    `The user REJECTED this action. Do not perform it. Continue only if you can another way, otherwise explain what's blocked.`
  );
}

export function toolNameFromParkedApproval(approval: PendingApproval): string {
  const fromTitle = approval.title.split(":")[0]?.trim();
  if (fromTitle) return fromTitle;
  return approval.kind === "execute" ? "Bash" : "Write";
}

/**
 * Does the incoming approval signature satisfy any entry in a profile-scoped
 * allowlist? Rules:
 *   - Exact match: `"claude:bash:git status"` matches only that command.
 *   - Prefix match: `"claude:bash"` matches every bash invocation.
 *   - Trailing `/*` on an edit/write/multiedit/etc. entry matches a
 *     directory: `"claude:edit:/repo/tests/*"` covers any edit under tests/.
 */
export function matchesProfileAllowlist(sig: string, allowlist: readonly string[]): boolean {
  for (const raw of allowlist) {
    const entry = raw.trim();
    if (!entry) continue;
    if (entry === sig) return true;
    if (entry.endsWith("/*")) {
      const stem = entry.slice(0, -2);
      if (sig === stem || sig.startsWith(stem + "/")) return true;
      continue;
    }
    // Bare-tool prefix (`claude:bash`) matches every specific arg.
    const colonCount = (entry.match(/:/g) ?? []).length;
    if (colonCount === 1 && (sig === entry || sig.startsWith(entry + ":"))) return true;
  }
  return false;
}

export function botTaggedTitle(title: string): string {
  const t = title.trim();
  if (/^<bot>/i.test(t)) return t;
  return `<bot> ${t}`;
}

export function shortTitle(prompt: string, explicit?: string): string {
  if (explicit?.trim()) return explicit.trim().slice(0, 80);
  const line = prompt.trim().split(/\n/)[0] ?? "Untitled task";
  return line.length > 72 ? line.slice(0, 69) + "…" : line;
}

/** True when the opening-turn user bubble is already on the session (dispatch wrote it). */
export function lastUserTextIs(session: { transcript?: TranscriptEntry[] }, text: string): boolean {
  const last = session.transcript?.at(-1);
  return last?.role === "user" && last.text === text;
}

/**
 * After `session/prompt` returns for a Grok turn, decide whether the session
 * should flip to `idle`. Reads only the *persisted* session — the in-memory
 * LiveSession bookkeeping maps used to be the source of truth here, but they
 * drifted (see RFC-019) and stranded sessions on `running` forever when a
 * cleared `AskUserQuestion` left a phantom entry behind.
 *
 * Returns `false` for terminal states (`cancelled` / `failed`), for states
 * that are legitimately waiting on the user (`awaiting_approval` /
 * `awaiting_question`), and for any session that still carries a persisted
 * `pendingApproval` or `pendingQuestion`. Everything else flips.
 */
export function shouldFlipToIdleAfterTurn(
  session: Pick<DispatchSession, "status" | "pendingApproval" | "pendingQuestion">,
): boolean {
  const s = session.status;
  if (s === "cancelled" || s === "failed") return false;
  if (s === "awaiting_approval" || s === "awaiting_question") return false;
  if (session.pendingApproval != null) return false;
  if (session.pendingQuestion != null) return false;
  return true;
}

/**
 * Remove every entry in a `pendingQuestions` map that belongs to a given
 * `toolCallId`. Used when the underlying `AskUserQuestion` tool call
 * finishes so the LiveSession bookkeeping doesn't lie to
 * `shouldFlipToIdleAfterTurn` (RFC-019).
 *
 * Returns the count of drained entries so callers can log / assert.
 */
export function drainPendingQuestionsByToolCall(
  map: Map<string, PendingQuestion & { rpcId?: number | string }>,
  toolCallId: string | undefined,
): number {
  if (!toolCallId) return 0;
  let drained = 0;
  for (const [qid, q] of map) {
    if (q.toolCallId === toolCallId) {
      map.delete(qid);
      drained += 1;
    }
  }
  return drained;
}

/**
 * First-turn Grok ACP prompt. Profile instructions are injected here (ACP has
 * no systemPrompt field) and skipped on resume / follow-up.
 */
export function composeGrokOpeningPrompt(opts: {
  prompt: string;
  planMode?: boolean;
  extraDirs?: string[];
  systemPrompt?: string;
}): string {
  let promptText = opts.prompt;
  if (opts.planMode) {
    promptText =
      `[Plan mode] Explore the codebase and write a concrete implementation plan before making any file edits. ` +
      `Present the plan for approval before implementing.\n\n${opts.prompt}`;
  }
  promptText = extraDirsAgentNote(opts.extraDirs) + promptText;
  return wrapWithProfileSystemPrompt(promptText, opts.systemPrompt, { fresh: true });
}

export interface LiveSession {
  session: DispatchSession;
  client: AcpClient;
  pendingApprovals: Map<string, PendingApproval & { rpcId?: number | string; source?: "grok" | "claude" }>;
  pendingQuestions: Map<string, PendingQuestion & { rpcId?: number | string }>;
  assistantBuffer: string;
  thoughtBuffer: string;
}

export interface ClaudeHookApproval {
  id: string;
  sessionId: string;
  status: "pending" | "approved" | "rejected";
  title: string;
  toolName: string;
  toolInput?: unknown;
  comment?: string;
  createdAt: string;
}

export interface BotRunState {
  sessionId: string;
  cancelled: boolean;
  abort: AbortController;
  pending?: {
    approvalId: string;
    resolve: (d: { decision: "approve" | "reject"; comment?: string }) => void;
    reject: (err: Error) => void;
  };
}

/**
 * Manages dispatched sessions: Grok (ACP) + Claude Code (stream-json + phone hooks).
 */
