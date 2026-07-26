import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { findClaudeBinary } from "../sessions/reader.js";
import { agentPathEnv } from "../platform.js";

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
}

export interface ClaudeRunnerEvents {
  text: (chunk: string) => void;
  tool: (info: { name: string; id?: string; input?: unknown; status: string }) => void;
  system: (text: string) => void;
  done: (info: { text: string; sessionId?: string; error?: string }) => void;
}

/**
 * Runs one Claude Code headless turn with stream-json + optional phone approval hooks.
 */
export class ClaudeRunner extends EventEmitter {
  private proc: ChildProcess | null = null;
  private fullText = "";
  private claudeSessionId: string | undefined;

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

    if (this.opts.requirePhoneApproval) {
      // default mode + hook gate for write/execute tools
      args.push("--permission-mode", "default");
      args.push("--settings", settingsPath);
    } else {
      args.push("--permission-mode", "acceptEdits");
    }

    this.proc = spawn(claudeBin, args, {
      cwd: this.opts.cwd,
      env: {
        ...process.env,
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
    const settings = {
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

    if (type === "assistant" || type === "stream_event") {
      const text = extractAssistantText(msg);
      if (text) {
        this.fullText += text;
        this.emit("text", text);
      }
      const tool = extractToolUse(msg);
      if (tool) this.emit("tool", { ...tool, status: "pending" });
      return;
    }

    if (type === "content_block_delta" || type === "content_block_start") {
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
    }
  }
}

function extractAssistantText(msg: Record<string, unknown>): string {
  const message = (msg.message ?? msg) as {
    role?: string;
    content?: unknown;
    delta?: { text?: string; partial_json?: string };
  };
  if (message.delta?.text) return message.delta.text;
  return contentToText(message.content) ?? contentToText(msg.content) ?? "";
}

function extractDeltaText(msg: Record<string, unknown>): string {
  const delta = msg.delta as { text?: string; type?: string } | undefined;
  if (delta?.text) return delta.text;
  return "";
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
  }
  const t = parts.join("");
  return t || undefined;
}

/** Node hook: blocks Edit/Bash until ClankerSpanker host + phone approve. */
const APPROVAL_HOOK_SOURCE = `#!/usr/bin/env node
import { readFileSync } from "fs";

const sessionId = process.env.CLAUDE_DISPATCH_SESSION_ID;
const host = (process.env.CLAUDE_DISPATCH_HOST || "http://127.0.0.1:8787").replace(/\\/$/, "");
const token = process.env.CLAUDE_DISPATCH_TOKEN || "";

function out(obj) {
  process.stdout.write(JSON.stringify(obj));
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
    out({ decision: "allow", reason: "read-only" });
    process.exit(0);
  }

  if (!sessionId || !token) {
    out({ decision: "deny", reason: "ClankerSpanker hook missing session/token env" });
    process.exit(2);
  }

  try {
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
      out({ decision: "deny", reason: "approval create failed: " + t.slice(0, 200) });
      process.exit(2);
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
        out({ decision: "allow", reason: st.comment || "approved on phone" });
        process.exit(0);
      }
      if (st.status === "rejected") {
        out({ decision: "deny", reason: st.comment || "rejected on phone" });
        process.exit(2);
      }
    }
    out({ decision: "deny", reason: "approval timed out (10m)" });
    process.exit(2);
  } catch (e) {
    out({ decision: "deny", reason: "hook error: " + (e && e.message ? e.message : e) });
    process.exit(2);
  }
}

main();
`;
