import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BotStore, normalizeBot } from "./bot/store.js";
import { runCommand } from "./exec.js";
import { SessionStore } from "./sessions/store.js";
import {
  LINUX_UNSHARE_ARGS,
  explicitChildEnv,
  hostConfigRoot,
  sandboxRequested,
  seatbeltProfile,
} from "./sandbox.js";
import type { DispatchSession } from "./types.js";

describe("sandbox flag", () => {
  it("is on only for boolean true", () => {
    expect(sandboxRequested(true)).toBe(true);
    expect(sandboxRequested(false)).toBe(false);
    expect(sandboxRequested(undefined)).toBe(false);
    expect(sandboxRequested("true")).toBe(false);
    expect(sandboxRequested(1)).toBe(false);
  });

  it("keeps profile overrides and drops the host token and ambient host env", () => {
    const previous = process.env.CS_SANDBOX_HOST_ONLY;
    process.env.CS_SANDBOX_HOST_ONLY = "ambient-marker";
    try {
      const env = explicitChildEnv({
        CS_SANDBOX_HOST_ONLY: "ambient-marker",
        ANTHROPIC_API_KEY: "sk-test",
        CLAUDE_DISPATCH_TOKEN: "host-token",
        PROFILE_ONLY: "yes",
      });
      expect(env.CS_SANDBOX_HOST_ONLY).toBeUndefined();
      expect(env.CLAUDE_DISPATCH_TOKEN).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBe("sk-test");
      expect(env.PROFILE_ONLY).toBe("yes");
    } finally {
      if (previous === undefined) delete process.env.CS_SANDBOX_HOST_ONLY;
      else process.env.CS_SANDBOX_HOST_ONLY = previous;
    }
  });

  it("does not put --net on the linux jail", () => {
    expect(LINUX_UNSHARE_ARGS).not.toContain("--net");
    expect(LINUX_UNSHARE_ARGS).toContain("--user");
    expect(LINUX_UNSHARE_ARGS).toContain("--mount");
  });

  it("denies the host config directory in the macOS profile", () => {
    const profile = seatbeltProfile({
      cwd: "/work/job",
      extraDirs: ["/work/extra"],
      readOnlyDirs: ["/opt/claude-config"],
      secret: "/Users/me/.grok-dispatch",
    });
    expect(profile).toContain("(deny default)");
    expect(profile).toContain("(allow network*)");
    expect(profile).toContain('"/work/job"');
    expect(profile).toContain('"/Users/me/.grok-dispatch"');
    expect(profile.lastIndexOf("(deny file-read*")).toBeGreaterThan(profile.indexOf('"/work/job"'));
  });
});

describe("sandbox persistence", () => {
  it("keeps sandbox true on a bot and drops every other value", () => {
    expect(normalizeBot({
      name: "hunter",
      profileId: "p",
      projectId: "proj",
      job: "look",
      sandbox: true,
    })?.sandbox).toBe(true);
    expect(normalizeBot({
      name: "hunter",
      profileId: "p",
      projectId: "proj",
      job: "look",
      sandbox: false,
    })?.sandbox).toBeUndefined();
    const dir = mkdtempSync(join(tmpdir(), "cs-bots-"));
    try {
      const store = new BotStore(dir);
      const created = store.create({
        name: "hunter",
        profileId: "p",
        projectId: "proj",
        job: "look",
        sandbox: true,
      });
      expect(created.sandbox).toBe(true);
      const off = store.update(created.id, { sandbox: false });
      expect(off.sandbox).toBeUndefined();
      expect(store.get(created.id)?.sandbox).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("puts sandbox on session summaries only when the job opted in", () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-sess-"));
    const store = new SessionStore(dir);
    const base = {
      id: "s1",
      title: "t",
      prompt: "p",
      cwd: "/work",
      model: "m",
      planMode: false,
      subagents: false,
      worktree: false,
      status: "idle" as const,
      createdAt: "t",
      updatedAt: "t",
      transcript: [],
      toolCalls: [],
      events: [],
    } satisfies DispatchSession;
    expect(store.toSummary(base).sandbox).toBeUndefined();
    expect(store.toListItem(base).sandbox).toBeUndefined();
    expect(store.toSummary({ ...base, sandbox: true }).sandbox).toBe(true);
    expect(store.toListItem({ ...base, sandbox: true }).sandbox).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("sandboxed command", () => {
  const linux = process.platform === "linux";

  it("jails the workspace on linux and fails closed elsewhere", async () => {
    const parent = mkdtempSync(join(tmpdir(), "cs-jail-"));
    const cwd = join(parent, "work");
    mkdirSync(cwd);
    writeFileSync(join(cwd, "note.txt"), "note-visible\n");
    writeFileSync(join(parent, "secret.txt"), "hidden-secret\n");
    const previousKey = process.env.ANTHROPIC_API_KEY;
    const previousHost = process.env.CS_SANDBOX_HOST_ONLY;
    process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";
    process.env.CS_SANDBOX_HOST_ONLY = "ambient-marker";
    try {
      if (!linux) {
        await expect(runCommand({ command: "echo hi", cwd, sandbox: true })).rejects.toThrow(/unsandboxed/);
        return;
      }
      const secret = join(parent, "secret.txt");
      const r = await runCommand({
        command: [
          "cat note.txt",
          "echo jailed > wrote.txt",
          `cat ${JSON.stringify(secret)} >/dev/null 2>&1`,
          "echo SECRET:$?",
          "echo HOME_LS:$(ls /home | tr '\\n' ',')",
          "echo x > /usr/cs-ro-probe 2>/dev/null",
          "echo RO:$?",
          'echo KEY:${ANTHROPIC_API_KEY-unset}',
          'echo HOST:${CS_SANDBOX_HOST_ONLY-unset}',
        ].join("\n"),
        cwd,
        sandbox: true,
      });
      expect(r.stdout).toContain("note-visible");
      expect(r.stdout).not.toContain("hidden-secret");
      expect(r.stdout).toContain("SECRET:1");
      expect(r.stdout).toContain("HOME_LS:sandbox");
      expect(r.stdout).toContain("RO:1");
      expect(r.stdout).toContain("KEY:unset");
      expect(r.stdout).toContain("HOST:unset");
      expect(readFileSync(join(cwd, "wrote.txt"), "utf8")).toContain("jailed");
      expect(readFileSync(secret, "utf8")).toBe("hidden-secret\n");
      expect(existsSync("/usr/cs-ro-probe")).toBe(false);
    } finally {
      if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousKey;
      if (previousHost === undefined) delete process.env.CS_SANDBOX_HOST_ONLY;
      else process.env.CS_SANDBOX_HOST_ONLY = previousHost;
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("does not jail when sandbox is the string true", async () => {
    const parent = mkdtempSync(join(tmpdir(), "cs-jail-off-"));
    const cwd = join(parent, "work");
    mkdirSync(cwd);
    writeFileSync(join(parent, "secret.txt"), "hidden-secret\n");
    try {
      const r = await runCommand({
        command: `cat ${JSON.stringify(join(parent, "secret.txt"))}`,
        cwd,
        sandbox: "true" as unknown as boolean,
      });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("hidden-secret");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("refuses to mount the host config directory", async () => {
    const root = hostConfigRoot();
    mkdirSync(root, { recursive: true });
    const cwd = join(root, "job");
    mkdirSync(cwd, { recursive: true });
    await expect(runCommand({ command: "echo hi", cwd, sandbox: true })).rejects.toThrow(/host config/);
  });

  it("kills a sandboxed command that exceeds its timeout", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cs-jail-timeout-"));
    try {
      if (process.platform !== "linux") {
        await expect(runCommand({ command: "sleep 30", cwd, sandbox: true, timeoutMs: 500 })).rejects.toThrow(
          /unsandboxed/,
        );
        return;
      }
      const r = await runCommand({ command: "sleep 30", cwd, sandbox: true, timeoutMs: 500 });
      expect(r.exitCode).toBe(-1);
      expect(r.durationMs).toBeLessThan(4000);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
