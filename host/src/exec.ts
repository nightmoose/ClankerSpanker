import { exec } from "node:child_process";

export interface ExecRequest {
  command: string;
  cwd?: string;
  timeoutMs?: number;
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
