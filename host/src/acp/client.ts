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

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

/**
 * Thin JSON-RPC client over `grok agent stdio`.
 * Emits:
 *  - "notification" for agent→client methods (session/update, session/request_permission, …)
 *  - "exit" when the process ends
 *  - "stderr" for log lines
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
      if (trimmed) this.emit("stderr", trimmed);
    });

    this.proc.on("exit", (code, signal) => {
      this.closed = true;
      const detail = this.stderrBuf.trim().split("\n").slice(-6).join(" | ");
      const msg = detail
        ? `ACP process exited (code=${code}, signal=${signal}): ${detail}`
        : `ACP process exited (code=${code}, signal=${signal})`;
      for (const [, p] of this.pending) {
        p.reject(new Error(msg));
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
        name: "grok-dispatch-host",
        title: "Grok Dispatch Host",
        version: "0.1.0",
      },
    });
  }

  async request(method: string, params?: unknown, timeoutMs = 120_000): Promise<unknown> {
    if (!this.proc || this.closed) throw new Error("ACP client not running");
    const id = this.nextId++;
    const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    const payload = JSON.stringify(msg) + "\n";

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`ACP request timed out after ${timeoutMs}ms: ${method}`));
        }
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.proc!.stdin.write(payload, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
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
  }

  respondError(id: number | string, code: number, message: string): void {
    if (!this.proc || this.closed) return;
    const msg = { jsonrpc: "2.0", id, error: { code, message } };
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    this.closed = true;
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

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

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
          const detail = err.data != null ? `: ${typeof err.data === "string" ? err.data : JSON.stringify(err.data)}` : "";
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
