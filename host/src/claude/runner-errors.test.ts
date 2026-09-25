import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeRunner } from "./runner.js";

// RFC-053: a failing `claude` must say why, not just "exited with code 1".
const saved = process.env.CLAUDE_BINARY;
afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDE_BINARY;
  else process.env.CLAUDE_BINARY = saved;
});

function fakeClaude(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
  const bin = join(dir, "claude");
  writeFileSync(bin, `#!/bin/sh\n${script}\n`);
  chmodSync(bin, 0o755);
  process.env.CLAUDE_BINARY = bin;
  return dir;
}

function runner(cwd: string): ClaudeRunner {
  return new ClaudeRunner({
    cwd,
    prompt: "hi",
    dispatchSessionId: "s1",
    hostBaseUrl: "http://127.0.0.1:1",
    hostToken: "t",
    dataDir: cwd,
    requirePhoneApproval: false,
  });
}

describe("ClaudeRunner failure detail (RFC-053)", () => {
  it("includes stderr when the CLI exits non-zero", async () => {
    const dir = fakeClaude('echo "Error: Invalid MCP configuration: mcpServers.github: bad" >&2; exit 1');
    await expect(runner(dir).run()).rejects.toThrow(/code 1: .*Invalid MCP configuration/);
  });

  it("prefers Claude's own error result over stderr", async () => {
    const dir = fakeClaude(
      `echo '{"type":"result","is_error":true,"result":"Credit balance is too low"}'; echo "noise" >&2; exit 1`,
    );
    // An error result with text is reported as the reply today; the exit
    // code path is what we assert when there is no reply text.
    const r = runner(dir);
    const out = await r.run().catch((e: Error) => e.message);
    expect(String(typeof out === "string" ? out : out.text)).toMatch(/Credit balance is too low/);
  });

  it("keeps the plain message when there is nothing to add", async () => {
    const dir = fakeClaude("exit 3");
    await expect(runner(dir).run()).rejects.toThrow(/^Claude exited with code 3$/);
  });
});
