import { exec } from "node:child_process";
import { runCommandSandboxed } from "./sandbox.js";

export interface ExecRequest {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  /** RFC-070. Only the boolean true leaves the host path. */
  sandbox?: boolean;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 100_000;

export async function runCommand(req: ExecRequest): Promise<ExecResult> {
  if (req.sandbox === true) return runCommandSandboxed(req);
  const timeoutMs = Math.min(req.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const start = Date.now();

  return new Promise((resolve) => {
    exec(
      req.command,
      {
        cwd: req.cwd,
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES * 2,
        shell: process.env.SHELL ?? "/bin/bash",
      },
      (err, rawOut, rawErr) => {
        const durationMs = Date.now() - start;
        const stdout = rawOut.slice(0, MAX_OUTPUT_BYTES);
        const stderr = rawErr.slice(0, MAX_OUTPUT_BYTES);
        const exitCode = (() => {
          if (!err) return 0;
          if (err.killed) return -1;
          if (typeof err.code === "number") return err.code;
          return 1;
        })();
        resolve({ stdout, stderr, exitCode, durationMs });
      },
    );
  });
}
