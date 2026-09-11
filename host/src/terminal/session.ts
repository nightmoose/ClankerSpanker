import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WebSocket } from "ws";
import {
  FrameParser,
  TYPE_ERR,
  TYPE_EXIT,
  TYPE_OUT,
  encodeInput,
  encodeResize,
} from "./frames.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const MAX_TERMINALS = 3;
export const IDLE_MS = 30 * 60 * 1000;

export type TerminalClientMessage =
  | { type: "in"; data?: string }
  | { type: "resize"; rows?: number; cols?: number }
  | { type: "ping" };

export type TerminalServerMessage =
  | { type: "out"; data: string }
  | { type: "exit"; code: number }
  | { type: "error"; message: string }
  | { type: "ready"; shell: string; cwd: string };

export function ptyBridgePath(): string {
  const candidates = [
    join(__dirname, "pty-bridge.py"),
    join(__dirname, "../../src/terminal/pty-bridge.py"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return candidates[0]!;
}

function pythonBin(): string {
  return process.env.CLANKER_PYTHON || process.env.PYTHON || "python3";
}

export function findPython3(): string | null {
  const bin = pythonBin();
  // PATH lookup happens at spawn time; we only special-case obvious missing.
  if (bin.includes("/") && !existsSync(bin)) return null;
  return bin;
}

interface LivePty {
  child: ChildProcessWithoutNullStreams;
  parser: FrameParser;
  idle: NodeJS.Timeout;
  lastInputAt: number;
}

export class TerminalHub {
  private live = new Map<WebSocket, LivePty>();

  get size(): number {
    return this.live.size;
  }

  attach(
    ws: WebSocket,
    opts?: { cols?: number; rows?: number; shell?: string; cwd?: string },
  ): void {
    if (this.live.size >= MAX_TERMINALS) {
      send(ws, { type: "error", message: `Too many host terminals (max ${MAX_TERMINALS})` });
      ws.close(4000, "busy");
      return;
    }
    const script = ptyBridgePath();
    if (!existsSync(script)) {
      send(ws, { type: "error", message: "Host terminal helper missing (pty-bridge.py)" });
      ws.close(1011, "no helper");
      return;
    }
    const py = findPython3();
    if (!py) {
      send(ws, { type: "error", message: "python3 is required for the host terminal" });
      ws.close(1011, "no python3");
      return;
    }

    const cols = clamp(opts?.cols ?? 80, 20, 512);
    const rows = clamp(opts?.rows ?? 24, 8, 512);
    const shell = opts?.shell || process.env.CLANKER_TERMINAL_SHELL || process.env.SHELL || "/bin/bash";
    const cwd = opts?.cwd || homedir();

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(py, ["-u", script], {
        cwd,
        env: {
          ...process.env,
          CLANKER_TERMINAL_SHELL: shell,
          CLANKER_TERMINAL_ROWS: String(rows),
          CLANKER_TERMINAL_COLS: String(cols),
          TERM: "xterm-256color",
          HOME: process.env.HOME || homedir(),
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      send(ws, {
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      ws.close(1011, "spawn failed");
      return;
    }

    const parser = new FrameParser();
    const session: LivePty = {
      child,
      parser,
      lastInputAt: Date.now(),
      idle: setTimeout(() => this.kill(ws, "idle"), IDLE_MS),
    };
    this.live.set(ws, session);

    send(ws, { type: "ready", shell, cwd });

    child.stdout.on("data", (chunk: Buffer) => {
      if (!this.live.has(ws)) return;
      let frames;
      try {
        frames = parser.push(chunk);
      } catch (err) {
        send(ws, { type: "error", message: err instanceof Error ? err.message : String(err) });
        this.kill(ws, "bad frame");
        return;
      }
      for (const frame of frames) {
        if (frame.type === TYPE_OUT) {
          send(ws, { type: "out", data: frame.payload.toString("utf8") });
        } else if (frame.type === TYPE_ERR) {
          send(ws, { type: "error", message: frame.payload.toString("utf8") });
        } else if (frame.type === TYPE_EXIT) {
          const code = frame.payload.length >= 4 ? frame.payload.readInt32BE(0) : 0;
          send(ws, { type: "exit", code });
          this.kill(ws, "exit");
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const t = chunk.toString("utf8").trim();
      if (t) console.warn("[terminal]", t.slice(0, 400));
    });
    child.on("exit", () => {
      if (!this.live.has(ws)) return;
      send(ws, { type: "exit", code: child.exitCode ?? 0 });
      this.kill(ws, "child-exit");
    });

    ws.on("message", (raw) => {
      const sessionNow = this.live.get(ws);
      if (!sessionNow) return;
      let msg: TerminalClientMessage;
      try {
        msg = JSON.parse(String(raw)) as TerminalClientMessage;
      } catch {
        return;
      }
      if (msg.type === "ping") return;
      if (msg.type === "resize") {
        const r = clamp(Number(msg.rows) || rows, 8, 512);
        const c = clamp(Number(msg.cols) || cols, 20, 512);
        try {
          sessionNow.child.stdin.write(encodeResize(r, c));
        } catch {
          /* closed */
        }
        return;
      }
      if (msg.type === "in") {
        const data = msg.data ?? "";
        if (!data) return;
        sessionNow.lastInputAt = Date.now();
        sessionNow.idle.refresh();
        try {
          sessionNow.child.stdin.write(encodeInput(data));
        } catch {
          /* closed */
        }
      }
    });
    ws.on("close", () => this.kill(ws, "ws-close"));
    ws.on("error", () => this.kill(ws, "ws-error"));
  }

  kill(ws: WebSocket, _reason: string): void {
    const session = this.live.get(ws);
    if (!session) return;
    this.live.delete(ws);
    clearTimeout(session.idle);
    try {
      session.child.stdin.end();
    } catch {
      /* */
    }
    try {
      session.child.kill("SIGHUP");
    } catch {
      /* */
    }
    setTimeout(() => {
      try {
        session.child.kill("SIGKILL");
      } catch {
        /* */
      }
    }, 800);
    if (ws.readyState === ws.OPEN) {
      try {
        ws.close();
      } catch {
        /* */
      }
    }
  }

  shutdown(): void {
    for (const ws of [...this.live.keys()]) this.kill(ws, "shutdown");
  }
}

function send(ws: WebSocket, msg: TerminalServerMessage): void {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    /* */
  }
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}
