import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import { findAgyBinary } from "../platform.js";
import { agentPathEnv } from "../platform.js";

export interface AntigravityRunnerOptions {
  cwd: string;
  /** Existing conversation_id from a prior headless run; omit to start fresh. */
  conversationId?: string;
  prompt: string;
  /** Optional model slug (e.g. gemini-3.5-flash-medium). */
  model?: string;
  /**
   * When true, pass --dangerously-skip-permissions (auto-approve tools).
   * Prefer false + workspace-scoped permissions in settings for safer runs.
   */
  skipPermissions: boolean;
  /** Profile-specific env (API keys, etc.). */
  profileEnv?: NodeJS.ProcessEnv;
  /** Override binary path; default searches PATH / install locations. */
  binary?: string;
  /** Print-mode timeout string for agy (default 30m for agent work). */
  printTimeout?: string;
}

/**
 * Runs one Antigravity CLI (`agy`) headless turn with stream-json output.
 *
 * @see https://antigravity.google/docs/cli/headless
 */
export class AntigravityRunner extends EventEmitter {
  private proc: ChildProcess | null = null;
  private fullText = "";
  private conversationId: string | undefined;
  private terminalError: string | undefined;

  constructor(private readonly opts: AntigravityRunnerOptions) {
    super();
    this.conversationId = opts.conversationId;
  }

  async run(): Promise<{ text: string; conversationId?: string }> {
    const bin = this.opts.binary?.trim() || findAgyBinary();
    const args = [
      "-p",
      this.opts.prompt,
      "--output-format",
      "stream-json",
      "--print-timeout",
      this.opts.printTimeout?.trim() || "30m",
    ];

    if (this.opts.conversationId) {
      args.push("--conversation", this.opts.conversationId);
    }

    const model = this.opts.model?.trim();
    if (model && model !== "antigravity" && model !== "agy" && model !== "gemini") {
      args.push("--model", model);
    }

    if (this.opts.skipPermissions) {
      args.push("--dangerously-skip-permissions");
    }

    this.proc = spawn(bin, args, {
      cwd: this.opts.cwd,
      env: {
        ...process.env,
        ...(this.opts.profileEnv ?? {}),
        PATH: agentPathEnv(),
        // Avoid interactive auth hang in headless
        CI: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const proc = this.proc;
    proc.stderr?.on("data", (buf: Buffer) => {
      const t = buf.toString("utf8").trim();
      if (t) this.emit("system", t.slice(0, 800));
    });

    if (!proc.stdout) throw new Error("Antigravity process has no stdout");
    const rl = createInterface({ input: proc.stdout });
    for await (const line of rl) {
      this.handleLine(line);
    }

    const code: number | null = await new Promise((resolve) => {
      proc.on("exit", (c) => resolve(c));
      if (proc.exitCode != null) resolve(proc.exitCode);
    });

    if (this.terminalError && !this.fullText.trim()) {
      this.emit("done", {
        text: "",
        conversationId: this.conversationId,
        error: this.terminalError,
      });
      throw new Error(this.terminalError);
    }

    if (code && code !== 0 && !this.fullText.trim()) {
      const err =
        this.terminalError ||
        `Antigravity (agy) exited with code ${code}. Is it installed and authenticated? Run: curl -fsSL https://antigravity.google/cli/install.sh | bash && agy`;
      this.emit("done", { text: "", conversationId: this.conversationId, error: err });
      throw new Error(err);
    }

    const result = { text: this.fullText.trim(), conversationId: this.conversationId };
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

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      this.fullText += trimmed + "\n";
      this.emit("text", trimmed + "\n");
      return;
    }

    // Capture conversation id from any event that carries it
    const cid =
      (msg.conversation_id as string | undefined) ||
      ((msg.init as { conversation_id?: string } | undefined)?.conversation_id) ||
      ((msg.step_update as { conversation_id?: string } | undefined)?.conversation_id) ||
      ((msg.result as { conversation_id?: string } | undefined)?.conversation_id);
    if (cid) this.conversationId = cid;

    const event = String(msg.event ?? msg.type ?? "");

    if (event === "init") {
      const init = msg.init as { conversation_id?: string } | undefined;
      if (init?.conversation_id) this.conversationId = init.conversation_id;
      this.emit("system", "Antigravity session started");
      return;
    }

    if (event === "step_update") {
      const step = (msg.step_update ?? msg) as {
        conversation_id?: string;
        state?: string;
        step_type?: string;
        tool_name?: string;
        text_delta?: string;
        tool_info?: {
          name?: string;
          parameters?: unknown;
          output?: unknown;
          error?: { message?: string };
        };
      };
      if (step.conversation_id) this.conversationId = step.conversation_id;

      if (step.text_delta) {
        this.fullText += step.text_delta;
        this.emit("text", step.text_delta);
      }

      if (step.step_type === "tool" || step.tool_name || step.tool_info) {
        const name = step.tool_name || step.tool_info?.name || "tool";
        const status =
          step.state === "DONE"
            ? step.tool_info?.error
              ? "failed"
              : "completed"
            : "pending";
        this.emit("tool", {
          name,
          id: undefined,
          input: step.tool_info?.parameters,
          status,
        });
      }
      return;
    }

    if (event === "result") {
      const result = (msg.result ?? msg) as {
        conversation_id?: string;
        status?: string;
        response?: string;
        error?: string;
      };
      if (result.conversation_id) this.conversationId = result.conversation_id;
      if (result.error) this.terminalError = String(result.error).slice(0, 2000);
      if (result.status && result.status !== "SUCCESS" && !result.response) {
        this.terminalError =
          this.terminalError || `Antigravity status: ${result.status}`;
      }
      if (typeof result.response === "string" && result.response.trim()) {
        // Prefer accumulated deltas; fill if stream missed text
        if (!this.fullText.trim()) {
          this.fullText = result.response;
          this.emit("text", result.response);
        } else if (!this.fullText.includes(result.response.slice(0, 40))) {
          // Final envelope differs from stream — use envelope as canonical
          this.fullText = result.response;
        }
      }
      return;
    }

    // Single-shot json envelope (if user/output-format misconfig still lands here)
    if (typeof msg.response === "string" && msg.response.trim()) {
      if (msg.conversation_id) this.conversationId = String(msg.conversation_id);
      if (!this.fullText.trim()) {
        this.fullText = String(msg.response);
        this.emit("text", String(msg.response));
      }
      if (msg.error) this.terminalError = String(msg.error).slice(0, 2000);
    }
  }
}
