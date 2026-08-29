import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { findClaudeBinary } from "../sessions/reader.js";
import { agentPathEnv } from "../platform.js";
import { isClaudeModelSentinel } from "../profiles.js";

export interface ClaudeRunnerOptions {
  cwd: string;
  /** Existing Claude session to resume; omit to start fresh. */
  resumeSessionId?: string;
  prompt: string;
  /** Dispatch session id — used by the approval hook. */
  dispatchSessionId: string;
  hostBaseUrl: string;
  hostToken: string;
  dataDir: string;
  /** When true, Edit/Write/Bash wait for phone via PreToolUse hook. */
  requirePhoneApproval: boolean;
  /** Profile-specific env (ANTHROPIC_API_KEY, CLAUDE_CONFIG_DIR, …) for multi-account. */
  profileEnv?: NodeJS.ProcessEnv;
  /**
   * Claude model slug (e.g. "claude-sonnet-4-6", "claude-opus-4-7"). Sentinels
   * "claude" / "default" / "" skip `--model` and let the CLI choose its own
   * default — avoids pinning stale slugs from old profile configs.
   */
  model?: string;
  /**
   * Persona / project-context text passed via `--append-system-prompt`. Applied
   * on every turn, so it must be static across the session (per-profile config,
   * not per-message).
   */
  appendSystemPrompt?: string;
  /**
   * Extra directories Claude may Read (session/project attachment stores).
   * Passed as `--add-dir` and `permissions.additionalDirectories`.
   */
  extraDirs?: string[];
  /**
   * Pre-flight tool names (`--tools`). Empty/omit leaves the CLI default set.
   * Claude's `--allowedTools` is a permission allow, not availability — we
   * use `--tools` so a list of `Read,Grep` cannot fire `Write`.
   */
  toolAllowlist?: string[];
}

export interface ClaudeUsageDelta {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface ClaudeRunnerEvents {
  text: (chunk: string) => void;
  /** Extended-thinking output — Claude's reasoning traces, separate from the reply. */
  thought: (chunk: string) => void;
  tool: (info: { name: string; id?: string; input?: unknown; status: string }) => void;
  system: (text: string) => void;
  /** Cumulative token usage for this turn (emitted at end of turn). */
  usage: (delta: ClaudeUsageDelta) => void;
  done: (info: { text: string; sessionId?: string; error?: string }) => void;
}

/**
 * Runs one Claude Code headless turn with stream-json + optional phone approval hooks.
 */
export class ClaudeRunner extends EventEmitter {
  private proc: ChildProcess | null = null;
  private fullText = "";
  private claudeSessionId: string | undefined;
  private turnUsage: ClaudeUsageDelta = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };

  constructor(private readonly opts: ClaudeRunnerOptions) {
    super();
    this.claudeSessionId = opts.resumeSessionId;
  }

  async run(): Promise<{ text: string; sessionId?: string }> {
    const claudeBin = findClaudeBinary();
    const settingsPath = this.writeSettings();
    const args = [
      "-p",
      this.opts.prompt,
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
    ];

    if (this.opts.resumeSessionId) {
      args.push("--resume", this.opts.resumeSessionId);
    }

    // Pin the model when the profile/request specifies one. Sentinels
    // ("claude" / "default") skip this so the CLI's own default applies —
    // otherwise old profile configs would pin stale slugs forever.
    const model = this.opts.model?.trim();
    if (model && !isClaudeModelSentinel(model)) {
      args.push("--model", model);
    }

    // Persona / project context injected once per turn.
    const persona = this.opts.appendSystemPrompt?.trim();
    if (persona) {
      args.push("--append-system-prompt", persona);
    }

    args.push(...claudeToolRestrictArgs(this.opts.toolAllowlist));

    if (this.opts.requirePhoneApproval) {
      // default mode + hook gate for write/execute tools
      args.push("--permission-mode", "default");
      args.push("--settings", settingsPath);
    } else {
      args.push("--permission-mode", "acceptEdits");
    }

    for (const dir of extraDirsForClaude(this.opts.extraDirs)) {
      args.push("--add-dir", dir);
    }

    this.proc = spawn(claudeBin, args, {
      cwd: this.opts.cwd,
      env: {
        ...process.env,
        ...(this.opts.profileEnv ?? {}),
        PATH: agentPathEnv(),
        CLAUDE_DISPATCH_SESSION_ID: this.opts.dispatchSessionId,
        CLAUDE_DISPATCH_HOST: this.opts.hostBaseUrl,
        CLAUDE_DISPATCH_TOKEN: this.opts.hostToken,
        // Avoid interactive prompts
        CI: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const proc = this.proc;
    proc.stderr?.on("data", (buf: Buffer) => {
      const t = buf.toString("utf8").trim();
      if (t) this.emit("system", t.slice(0, 500));
    });

    if (!proc.stdout) throw new Error("Claude process has no stdout");
    const rl = createInterface({ input: proc.stdout });
    for await (const line of rl) {
      this.handleLine(line);
    }

    const code: number | null = await new Promise((resolve) => {
      proc.on("exit", (c) => resolve(c));
      if (proc.exitCode != null) resolve(proc.exitCode);
    });

    if (code && code !== 0 && !this.fullText.trim()) {
      const err = `Claude exited with code ${code}`;
      this.emit("done", { text: "", sessionId: this.claudeSessionId, error: err });
      throw new Error(err);
    }

    // Emit final usage before `done` so listeners can persist it in the same
    // event loop cycle they mark the session idle.
    if (
      this.turnUsage.inputTokens > 0 ||
      this.turnUsage.outputTokens > 0 ||
      this.turnUsage.cacheReadTokens > 0 ||
      this.turnUsage.cacheCreationTokens > 0
    ) {
      this.emit("usage", { ...this.turnUsage });
    }

    const result = { text: this.fullText.trim(), sessionId: this.claudeSessionId };
    this.emit("done", result);
    return result;
  }

  stop(): void {
    try {
      this.proc?.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }

  private writeSettings(): string {
    const dir = join(this.opts.dataDir, "claude-hooks");
    mkdirSync(dir, { recursive: true });
    const hookPath = join(dir, "pretool-approval.mjs");
    writeFileSync(hookPath, APPROVAL_HOOK_SOURCE, "utf8");
    chmodSync(hookPath, 0o755);

    const settingsPath = join(dir, `settings-${this.opts.dispatchSessionId}.json`);
    const settings = buildClaudeHookSettings(hookPath, extraDirsForClaude(this.opts.extraDirs));
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
    return settingsPath;
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // plain text fallback
      this.fullText += trimmed + "\n";
      this.emit("text", trimmed + "\n");
      return;
    }

    const type = String(msg.type ?? "");

    // Capture session id when present
    const sid =
      (msg.session_id as string | undefined) ||
      (msg.sessionId as string | undefined) ||
      ((msg.message as { session_id?: string } | undefined)?.session_id);
    if (sid) this.claudeSessionId = sid;

    // Token accounting rides on assistant / result frames.
    this.accumulateUsage(msg);

    if (type === "assistant" || type === "stream_event") {
      const text = extractAssistantText(msg);
      if (text) {
        this.fullText += text;
        this.emit("text", text);
      }
      const thought = extractThinkingText(msg);
      if (thought) this.emit("thought", thought);
      const tool = extractToolUse(msg);
      if (tool) this.emit("tool", { ...tool, status: "pending" });
      return;
    }

    if (type === "content_block_delta" || type === "content_block_start") {
      // `content_block_delta` carries a `delta.type` discriminator — thinking
      // deltas MUST NOT be folded into the assistant reply text or the phone
      // will show the model's reasoning as the answer.
      const delta = msg.delta as { text?: string; type?: string; thinking?: string } | undefined;
      const deltaType = delta?.type ?? "";
      if (deltaType === "thinking_delta") {
        const thinking = delta?.thinking ?? delta?.text ?? "";
        if (thinking) this.emit("thought", thinking);
        return;
      }
      // `content_block_start` for a thinking block sometimes carries seed text.
      if (type === "content_block_start") {
        const block = msg.content_block as { type?: string; thinking?: string } | undefined;
        if (block?.type === "thinking" && block.thinking) {
          this.emit("thought", block.thinking);
          return;
        }
      }
      const text = extractDeltaText(msg);
      if (text) {
        this.fullText += text;
        this.emit("text", text);
      }
      return;
    }

    if (type === "tool_use" || type === "tool_call") {
      this.emit("tool", {
        name: String(msg.name ?? msg.toolName ?? "tool"),
        id: msg.id as string | undefined,
        input: msg.input ?? msg.toolInput,
        status: "pending",
      });
      return;
    }

    if (type === "tool_result" || type === "tool_call_result") {
      this.emit("tool", {
        name: String(msg.name ?? "tool"),
        id: (msg.tool_use_id as string) ?? (msg.id as string),
        status: "completed",
      });
      return;
    }

    if (type === "result") {
      const resultText =
        typeof msg.result === "string"
          ? msg.result
          : extractAssistantText(msg) || this.fullText;
      if (resultText && !this.fullText.includes(resultText.slice(0, 40))) {
        this.fullText = resultText;
      }
      if (msg.session_id) this.claudeSessionId = String(msg.session_id);
      return;
    }

    // message wrapper
    if (msg.message && typeof msg.message === "object") {
      const text = extractAssistantText(msg);
      if (text) {
        this.fullText += text;
        this.emit("text", text);
      }
      const thought = extractThinkingText(msg);
      if (thought) this.emit("thought", thought);
    }
  }

  /** Pull an Anthropic-shape `usage` block off the message and add to the running turn total. */
  private accumulateUsage(msg: Record<string, unknown>): void {
    const usage = extractUsage(msg);
    if (!usage) return;
    // The stream re-sends the same usage numbers as it grows — accept the
    // maximum seen for each field so we don't double-count partial frames.
    this.turnUsage.inputTokens = Math.max(this.turnUsage.inputTokens, usage.inputTokens);
    this.turnUsage.outputTokens = Math.max(this.turnUsage.outputTokens, usage.outputTokens);
    this.turnUsage.cacheReadTokens = Math.max(
      this.turnUsage.cacheReadTokens,
      usage.cacheReadTokens,
    );
    this.turnUsage.cacheCreationTokens = Math.max(
      this.turnUsage.cacheCreationTokens,
      usage.cacheCreationTokens,
    );
  }

  /** Total tokens observed on this turn — read by run() before the `done` emit. */
  get usage(): ClaudeUsageDelta {
    return { ...this.turnUsage };
  }
}

function extractAssistantText(msg: Record<string, unknown>): string {
  const message = (msg.message ?? msg) as {
    role?: string;
    content?: unknown;
    delta?: { text?: string; type?: string; partial_json?: string };
  };
  // `text_delta` = reply chunk; `thinking_delta` = extended-thinking chunk.
  // Only fold text_delta into the reply — thinking is emitted separately.
  if (message.delta?.text && message.delta?.type !== "thinking_delta") {
    return message.delta.text;
  }
  return contentToText(message.content) ?? contentToText(msg.content) ?? "";
}

/** Pull extended-thinking text out of an assistant/message frame (non-streaming path). */
function extractThinkingText(msg: Record<string, unknown>): string {
  const message = (msg.message ?? msg) as { content?: unknown };
  return thinkingFromContent(message.content) ?? thinkingFromContent(msg.content) ?? "";
}

function thinkingFromContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const c of content) {
    if (c && typeof c === "object" && (c as { type?: string }).type === "thinking") {
      const t = c as { thinking?: string; text?: string };
      const body = t.thinking ?? t.text ?? "";
      if (body) parts.push(String(body));
    }
  }
  const joined = parts.join("");
  return joined || undefined;
}

function extractDeltaText(msg: Record<string, unknown>): string {
  const delta = msg.delta as { text?: string; type?: string } | undefined;
  if (delta?.type === "thinking_delta") return "";
  if (delta?.text) return delta.text;
  return "";
}

/**
 * Pull an Anthropic usage envelope off an assistant/result frame.
 * Fields per SSE / result: input_tokens, output_tokens,
 * cache_read_input_tokens, cache_creation_input_tokens.
 */
function extractUsage(msg: Record<string, unknown>): ClaudeUsageDelta | null {
  const candidates: unknown[] = [
    (msg.message as { usage?: unknown } | undefined)?.usage,
    msg.usage,
    (msg.result as { usage?: unknown } | undefined)?.usage,
  ];
  for (const raw of candidates) {
    if (!raw || typeof raw !== "object") continue;
    const u = raw as Record<string, unknown>;
    const inputTokens = numberField(u, "input_tokens", "inputTokens");
    const outputTokens = numberField(u, "output_tokens", "outputTokens");
    const cacheReadTokens = numberField(u, "cache_read_input_tokens", "cacheReadInputTokens");
    const cacheCreationTokens = numberField(
      u,
      "cache_creation_input_tokens",
      "cacheCreationInputTokens",
    );
    if (
      inputTokens > 0 ||
      outputTokens > 0 ||
      cacheReadTokens > 0 ||
      cacheCreationTokens > 0
    ) {
      return { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens };
    }
  }
  return null;
}

function numberField(obj: Record<string, unknown>, ...keys: string[]): number {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  }
  return 0;
}

function extractToolUse(msg: Record<string, unknown>): { name: string; id?: string; input?: unknown } | null {
  const message = msg.message as { content?: unknown } | undefined;
  const content = message?.content ?? msg.content;
  if (!Array.isArray(content)) return null;
  for (const c of content) {
    if (c && typeof c === "object" && (c as { type?: string }).type === "tool_use") {
      const t = c as { name?: string; id?: string; input?: unknown };
      return { name: t.name ?? "tool", id: t.id, input: t.input };
    }
  }
  return null;
}

function contentToText(content: unknown): string | undefined {
  if (typeof content === "string" && content.trim()) return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const c of content) {
    if (typeof c === "string") parts.push(c);
    else if (c && typeof c === "object" && (c as { type?: string }).type === "text") {
      parts.push(String((c as { text?: string }).text ?? ""));
    }
    // "thinking" blocks are intentionally skipped — they surface via extractThinkingText.
  }
  const t = parts.join("");
  return t || undefined;
}

/**
 * Claude Code PreToolUse decision payload (current format).
 *
 * Claude Code only reads `hookSpecificOutput.permissionDecision` for PreToolUse.
 * Flat `{ decision, reason }` is silently discarded — the tool then falls through
 * to the native permission system, which in headless `-p` + `default` mode yields
 * "haven't granted it yet" even after the phone taps Approve.
 *
 * See: https://code.claude.com/docs/en/hooks (PreToolUse decision control)
 * and anthropics/claude-code#48760.
 */
export function buildPreToolUseDecision(
  decision: "allow" | "deny" | "ask" | "defer",
  reason: string,
): {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "allow" | "deny" | "ask" | "defer";
    permissionDecisionReason: string;
  };
} {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  };
}

/**
 * Node hook: blocks Edit/Bash until ClankerSpanker host + phone approve.
 * Must emit hookSpecificOutput.permissionDecision (not flat decision/reason).
 */
/** `--tools Read,Grep` so a pre-flight allowlist actually removes other tools. */
export function claudeToolRestrictArgs(allowlist?: string[]): string[] {
  const tools = (allowlist ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
  if (!tools.length) return [];
  return ["--tools", tools.join(",")];
}

/** Directories that actually exist, for `--add-dir` / settings. */
export function extraDirsForClaude(dirs?: string[]): string[] {
  if (!dirs?.length) return [];
  const out: string[] = [];
  for (const dir of dirs) {
    if (dir && existsSync(dir) && !out.includes(dir)) out.push(dir);
  }
  return out;
}

/** Settings.json body: PreToolUse hook + optional extra-dir Read grants. */
export function buildClaudeHookSettings(hookPath: string, extraDirs: string[] = []): Record<string, unknown> {
  const settings: Record<string, unknown> = {
    hooks: {
      PreToolUse: [
        {
          matcher: "Edit|Write|MultiEdit|NotebookEdit|Bash|Delete",
          hooks: [
            {
              type: "command",
              command: `node ${JSON.stringify(hookPath)}`,
              timeout: 600,
            },
          ],
        },
      ],
    },
  };
  if (extraDirs.length) {
    settings.permissions = {
      additionalDirectories: extraDirs,
      allow: extraDirs.map((d) => `Read(${d}/**)`),
    };
  }
  return settings;
}

export const APPROVAL_HOOK_SOURCE = `#!/usr/bin/env node
import { readFileSync } from "fs";

const sessionId = process.env.CLAUDE_DISPATCH_SESSION_ID;
const host = (process.env.CLAUDE_DISPATCH_HOST || "http://127.0.0.1:8787").replace(/\\/$/, "");
const token = process.env.CLAUDE_DISPATCH_TOKEN || "";

/**
 * PreToolUse only honors hookSpecificOutput.permissionDecision.
 * Flat {decision, reason} is ignored → "haven't granted it yet" in headless.
 */
function decide(decision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason || "",
    },
  }));
}

function log(msg) {
  try { process.stderr.write("[clankerspanker-hook] " + msg + "\\n"); } catch { /* ignore */ }
}

async function main() {
  let input = "";
  try {
    input = readFileSync(0, "utf8");
  } catch {
    input = "";
  }
  let payload = {};
  try { payload = JSON.parse(input || "{}"); } catch { payload = {}; }

  const toolName = payload.tool_name || payload.toolName || payload.tool || "Tool";
  const toolInput = payload.tool_input || payload.toolInput || payload.input || {};
  const title = typeof toolInput === "object" && toolInput.file_path
    ? toolName + ": " + toolInput.file_path
    : typeof toolInput === "object" && toolInput.command
      ? toolName + ": " + String(toolInput.command).slice(0, 80)
      : String(toolName);

  // Safe tools auto-allow if hook was matched incorrectly
  const safe = /^(Read|Grep|Glob|LS|NotebookRead)$/i.test(String(toolName));
  if (safe) {
    decide("allow", "read-only");
    process.exit(0);
  }

  if (!sessionId || !token) {
    log("missing CLAUDE_DISPATCH_SESSION_ID or CLAUDE_DISPATCH_TOKEN");
    decide("deny", "ClankerSpanker hook missing session/token env");
    process.exit(0);
  }

  try {
    log("requesting approval for " + title);
    const createRes = await fetch(host + "/internal/claude-approval", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
      },
      body: JSON.stringify({
        sessionId,
        toolName,
        title,
        toolInput,
      }),
    });
    if (!createRes.ok) {
      const t = await createRes.text();
      log("create failed: " + t.slice(0, 200));
      decide("deny", "approval create failed: " + t.slice(0, 200));
      process.exit(0);
    }
    const { approvalId } = await createRes.json();
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      const poll = await fetch(host + "/internal/claude-approval/" + approvalId, {
        headers: { Authorization: "Bearer " + token },
      });
      if (!poll.ok) continue;
      const st = await poll.json();
      if (st.status === "approved") {
        log("approved " + approvalId);
        decide("allow", st.comment || "approved on phone");
        process.exit(0);
      }
      if (st.status === "rejected") {
        log("rejected " + approvalId);
        decide("deny", st.comment || "rejected on phone");
        process.exit(0);
      }
    }
    log("timed out waiting for approval");
    decide("deny", "approval timed out (10m)");
    process.exit(0);
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    log("error: " + msg);
    decide("deny", "hook error: " + msg);
    process.exit(0);
  }
}

main();
`;
