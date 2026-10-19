import { describe, expect, it } from "vitest";
import { runCommand } from "./exec.js";

describe("runCommand", () => {
  it("captures stdout and returns exit code 0", async () => {
    const r = await runCommand({ command: "echo hello" });
    expect(r.stdout.trim()).toBe("hello");
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
  });

  it("captures stderr separately", async () => {
    const r = await runCommand({ command: "echo err >&2" });
    expect(r.stderr.trim()).toBe("err");
    expect(r.exitCode).toBe(0);
  });

  it("returns nonzero exit code for failing commands", async () => {
    const r = await runCommand({ command: "exit 42" });
    expect(r.exitCode).toBe(42);
  });

  it("times out and returns exitCode -1", async () => {
    const r = await runCommand({ command: "sleep 10", timeoutMs: 100 });
    expect(r.exitCode).toBe(-1);
    expect(r.durationMs).toBeLessThan(2000);
  }, 5000);

  it("clamps timeoutMs to MAX_TIMEOUT_MS (does not throw)", async () => {
    const r = await runCommand({ command: "echo clamped", timeoutMs: 999_999_999 });
    expect(r.stdout.trim()).toBe("clamped");
    expect(r.exitCode).toBe(0);
  });

  it("records a non-zero durationMs", async () => {
    const r = await runCommand({ command: "echo timing" });
    expect(r.durationMs).toBeGreaterThan(0);
  });
});
