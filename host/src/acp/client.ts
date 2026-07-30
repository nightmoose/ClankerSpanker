import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { EventEmitter } from "node:events";
import { agentPathEnv } from "../platform.js";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

/** Options for outbound ACP JSON-RPC calls. */
export type AcpRequestOptions = {
  /**
   * Absolute wall-clock timeout for the whole request.
   * `0` disables the wall clock (used for long-lived `session/prompt`).
   * When omitted, a method-aware default is used.
   */
  timeoutMs?: number;
  /**
   * Fail if no ACP activity is observed for this long while the request is open.
   * `0` disables idle detection. Activity = any inbound line (response, update, request).
   */
  idleTimeoutMs?: number;
  /**
   * When true, the idle clock is frozen (e.g. waiting for phone approval / answers).
   * Polled when the idle timer fires; if paused, the idle window restarts.
   */
  isIdlePaused?: () => boolean;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  method: string;
  wallTimer?: ReturnType<typeof setTimeout>;
  idleTimer?: ReturnType<typeof setTimeout>;
  idleTimeoutMs: number;
  isIdlePaused?: () => boolean;
  startedAt: number;
  lastActivityAt: number;
};

const DEFAULT_HARD_TIMEOUT_MS = 120_000;
const DEFAULT_PROMPT_IDLE_MS = 15 * 60_000;
const DEFAULT_PROMPT_MAX_MS = 6 * 60 * 60_000;

function defaultTimeoutFor(method: string): number {
  switch (method) {
    case "initialize":
      return 30_000;
    case "session/new":
    case "session/load":
    case "session/cancel":
      return 60_000;
    case "session/prompt":
      // Long agent turns (tools, plan mode, human gates) must not share a 2‑minute wall clock.
      return 0;
    default:
      return DEFAULT_HARD_TIMEOUT_MS;
  }
}

function defaultIdleTimeoutFor(method: string): number {
  if (method === "session/prompt") return DEFAULT_PROMPT_IDLE_MS;
  return 0;
}

/**
 * Thin JSON-RPC client over `grok agent stdio`.
 * Emits:
 *  - "notification" for agent→client methods (session/update, session/request_permission, …)
 *  - "exit" when the process ends
 *  - "stderr" for log lines
 *  - "activity" when any ACP traffic is observed (useful for hang diagnostics)
 */
export class AcpClient extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private rl: Interface | null = null;
  private nextId = 1;
  private pending = new Map<number | string, Pending>();
  private closed = false;
  private stderrBuf = "";

  /**
   * @param agentArgs flags for `grok agent` BEFORE the subcommand,
   *   e.g. `["--model", "grok-build"]` → `grok agent --model grok-build stdio`
   *   (NOT after `stdio` — clap rejects that with exit code 2)
   */
  constructor(
    private readonly grokBinary: string,
    private readonly agentArgs: string[] = [],
    private readonly extraEnv: NodeJS.ProcessEnv = {},
    private readonly defaults: {
      promptIdleTimeoutMs?: number;
      promptMaxMs?: number;
    } = {},
  ) {
    super();
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  get lastStderr(): string {
    return this.stderrBuf;
  }

  async start(): Promise<void> {
    if (this.proc) return;

    // Correct: grok agent [OPTIONS] stdio
    const args = ["agent", ...this.agentArgs, "stdio"];
    console.log(`[acp] spawn ${this.grokBinary} ${args.join(" ")}`);
    this.proc = spawn(this.grokBinary, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ...this.extraEnv,
        // Agent binaries + common install locations for tools Grok may shell out to
        PATH: agentPathEnv(),
      },
    });

    this.rl = createInterface({ input: this.proc.stdout });
    this.rl.on("line", (line) => this.onLine(line));

    this.proc.stderr.on("data", (buf: Buffer) => {
      const text = buf.toString("utf8");
      this.stderrBuf = (this.stderrBuf + text).slice(-8000);
      const trimmed = text.trim();
      if (trimmed) {
        this.emit("stderr", trimmed);
        // Treat stderr heartbeats as activity so quiet-but-alive agents don't idle-fail.
        this.touchActivity();
      }
    });

    this.proc.on("exit", (code, signal) => {
      this.closed = true;
      const detail = this.stderrBuf.trim().split("\n").slice(-6).join(" | ");
      const friendly = friendlyExitError(code, signal, detail);
      for (const [, p] of this.pending) {
        this.clearPendingTimers(p);
        p.reject(new Error(friendly));
      }
      this.pending.clear();
      this.emit("exit", { code, signal, stderr: this.stderrBuf });
    });

    // form must be an object (ElicitationFormCapabilities), not a boolean —
    // `form: true` makes initialize fail with Invalid params and every session dies.
    await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: false },
        terminal: false,
        elicitation: { form: {} },
      },
      clientInfo: {
        name: "clankerspanker-host",
        title: "ClankerSpanker Host",
        version: "0.5.3",
      },
    });
  }

  /**
   * Send a JSON-RPC request and wait for the matching response.
   *
   * For `session/prompt`, the default is **no wall-clock completion timeout**
   * plus a long idle timeout that resets on any ACP activity and freezes while
   * `isIdlePaused()` is true (approval / question gates).
   */
  async request(
    method: string,
    params?: unknown,
    options: AcpRequestOptions | number = {},
  ): Promise<unknown> {
    if (!this.proc || this.closed) throw new Error("ACP client not running");

    // Back-compat: third arg used to be a bare timeoutMs number.
    const opts: AcpRequestOptions =
      typeof options === "number" ? { timeoutMs: options } : options ?? {};

    const idleDefault =
      method === "session/prompt"
        ? (this.defaults.promptIdleTimeoutMs ?? DEFAULT_PROMPT_IDLE_MS)
        : defaultIdleTimeoutFor(method);

    let timeoutMs = opts.timeoutMs ?? defaultTimeoutFor(method);
    if (method === "session/prompt" && opts.timeoutMs === undefined) {
      // Optional absolute ceiling for orphaned prompts (default 6h).
      const max = this.defaults.promptMaxMs ?? DEFAULT_PROMPT_MAX_MS;
      timeoutMs = max > 0 ? max : 0;
    }

    const idleTimeoutMs = opts.idleTimeoutMs ?? idleDefault;
    const id = this.nextId++;
    const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    const payload = JSON.stringify(msg) + "\n";
    const startedAt = Date.now();

    if (method === "session/prompt") {
      console.log(
        `[acp] session/prompt start id=${id} wallMs=${timeoutMs || "none"} idleMs=${idleTimeoutMs || "none"}`,
      );
    }

    return new Promise((resolve, reject) => {
      const pending: Pending = {
        resolve: (v) => {
          this.clearPendingTimers(pending);
          if (method === "session/prompt") {
            console.log(
              `[acp] session/prompt end id=${id} ok elapsedMs=${Date.now() - startedAt}`,
            );
          }
          resolve(v);
        },
        reject: (e) => {
          this.clearPendingTimers(pending);
          if (method === "session/prompt") {
            console.log(
              `[acp] session/prompt end id=${id} err elapsedMs=${Date.now() - startedAt}: ${e.message}`,
            );
          }
          reject(e);
        },
        method,
        idleTimeoutMs,
        isIdlePaused: opts.isIdlePaused,
        startedAt,
        lastActivityAt: startedAt,
      };

      if (timeoutMs > 0) {
        pending.wallTimer = setTimeout(() => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          pending.reject(
            new Error(
              `ACP request timed out after ${timeoutMs}ms: ${method} (absolute ceiling)`,
            ),
          );
        }, timeoutMs);
      }

      if (idleTimeoutMs > 0) {
        this.armIdleTimer(id, pending);
      }

      this.pending.set(id, pending);
      this.proc!.stdin.write(payload, (err) => {
        if (err) {
          this.pending.delete(id);
          pending.reject(err);
        }
      });
    });
  }

  /** Mark activity on open requests (resets idle clocks). */
  touchActivity(): void {
    const now = Date.now();
    for (const [id, p] of this.pending) {
      p.lastActivityAt = now;
      if (p.idleTimeoutMs > 0) {
        this.armIdleTimer(id, p);
      }
    }
    this.emit("activity");
  }

  notify(method: string, params?: unknown): void {
    if (!this.proc || this.closed) return;
    const msg = { jsonrpc: "2.0", method, params };
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  /** Respond to an inbound request from the agent (e.g. session/request_permission). */
  respond(id: number | string, result: unknown): void {
    if (!this.proc || this.closed) return;
    const msg: JsonRpcResponse = { jsonrpc: "2.0", id, result };
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
    this.touchActivity();
  }

  respondError(id: number | string, code: number, message: string): void {
    if (!this.proc || this.closed) return;
    const msg = { jsonrpc: "2.0", id, error: { code, message } };
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
    this.touchActivity();
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      this.clearPendingTimers(p);
    }
    this.pending.clear();
    try {
      this.proc.stdin.end();
    } catch {
      /* ignore */
    }
    this.proc.kill("SIGTERM");
    // Force kill after grace period
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          this.proc?.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        resolve();
      }, 3000);
      this.proc?.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
    this.proc = null;
    this.rl?.close();
    this.rl = null;
  }

  private armIdleTimer(id: number | string, pending: Pending): void {
    if (pending.idleTimer) clearTimeout(pending.idleTimer);
    if (pending.idleTimeoutMs <= 0) return;

    pending.idleTimer = setTimeout(() => {
      if (!this.pending.has(id)) return;

      // Freeze idle clock while human is expected to act.
      if (pending.isIdlePaused?.()) {
        pending.lastActivityAt = Date.now();
        this.armIdleTimer(id, pending);
        return;
      }

      const silentFor = Date.now() - pending.lastActivityAt;
      if (silentFor < pending.idleTimeoutMs - 50) {
        // Activity landed between schedule and fire — re-arm remainder.
        this.armIdleTimer(id, pending);
        return;
      }

      this.pending.delete(id);
      pending.reject(
        new Error(
          `Agent went silent for ${Math.round(pending.idleTimeoutMs / 60000)}m during ${pending.method} ` +
            `(no ACP activity). The turn was still open — this is a hang, not a normal completion.`,
        ),
      );
    }, pending.idleTimeoutMs);
  }

  private clearPendingTimers(p: Pending): void {
    if (p.wallTimer) clearTimeout(p.wallTimer);
    if (p.idleTimer) clearTimeout(p.idleTimer);
    p.wallTimer = undefined;
    p.idleTimer = undefined;
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    // Any stdout line counts as activity for open prompts.
    this.touchActivity();

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      this.emit("stderr", `Non-JSON ACP line: ${trimmed.slice(0, 200)}`);
      return;
    }

    // Response to our request (must not include method — agent requests also have id)
    if (
      "id" in msg &&
      msg.id !== null &&
      msg.id !== undefined &&
      !("method" in msg) &&
      ("result" in msg || "error" in msg)
    ) {
      const id = msg.id as number | string;
      const pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        if (msg.error) {
          const err = msg.error as { message?: string; data?: unknown };
          const detail =
            err.data != null
              ? `: ${typeof err.data === "string" ? err.data : JSON.stringify(err.data)}`
              : "";
          pending.reject(new Error(`${err.message ?? "ACP error"}${detail}`));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    // Inbound request or notification from agent
    if (typeof msg.method === "string") {
      this.emit("notification", {
        id: msg.id as number | string | undefined,
        method: msg.method,
        params: msg.params,
      });
    }
  }
}

/** Map process exit + stderr into a phone-readable error. */
function friendlyExitError(
  code: number | null,
  signal: NodeJS.Signals | null,
  detail: string,
): string {
  const lower = detail.toLowerCase();
  if (
    lower.includes("authorizationrequired") ||
    lower.includes("auth(authorizationrequired)") ||
    (lower.includes("auth") && lower.includes("required"))
  ) {
    return (
      `Grok on the Mac is not authenticated (AuthorizationRequired). ` +
      `On the host machine run: grok login   then retry this session. ` +
      `(ACP exit code=${code}, signal=${signal})`
    );
  }
  if (detail) {
    return `ACP process exited (code=${code}, signal=${signal}): ${detail}`;
  }
  return `ACP process exited (code=${code}, signal=${signal})`;
}
