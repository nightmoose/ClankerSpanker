import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionManager,
  buildOrphanedApprovalResumePrompt,
  composeGrokOpeningPrompt,
  isSafeBashCommand,
  lastUserTextIs,
  materializeImagesInCwd,
} from "./session-manager.js";
import type { DispatchSession, HostConfigFile, PendingApproval } from "../types.js";

function testConfig(dataDir: string): HostConfigFile {
  return {
    hostToken: "t".repeat(32),
    bindHost: "127.0.0.1",
    bindPort: 8787,
    grokBinary: "/bin/echo",
    projects: [],
    allowCustomPaths: true,
    profiles: [{ id: "fullscore", name: "FullScore", backend: "claude", color: "#F97316" }],
    autoApproveKinds: ["read", "search", "think", "fetch"],
    notifyDesktop: false,
    dataDir,
  };
}

function claudeSession(cwd: string, id = "sess-claude"): DispatchSession {
  const ts = new Date().toISOString();
  return {
    id,
    backend: "claude",
    title: "ClankerSpanker Updates",
    prompt: "fix it",
    cwd,
    model: "claude",
    profileId: "fullscore",
    profileName: "FullScore",
    planMode: false,
    subagents: false,
    worktree: false,
    status: "awaiting_approval",
    createdAt: ts,
    updatedAt: ts,
    transcript: [],
    toolCalls: [],
    events: [],
  };
}

function parkedWrite(sessionId: string): PendingApproval {
  return {
    id: "orphan-write",
    sessionId,
    title: "Write: /tmp/foo.md",
    kind: "edit",
    rawInput: { file_path: "/tmp/foo.md", contents: "hi" },
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ],
    createdAt: new Date().toISOString(),
  };
}

describe("isSafeBashCommand", () => {
  it("allows read-only git and listing, rejects mutating or compound commands", () => {
    expect(isSafeBashCommand("git status")).toBe(true);
    expect(isSafeBashCommand("git diff")).toBe(true);
    expect(isSafeBashCommand("ls -la")).toBe(true);
    expect(isSafeBashCommand("git commit -am wip")).toBe(false);
    expect(isSafeBashCommand("git status && rm -rf /")).toBe(false);
    expect(isSafeBashCommand("npx tsc --noEmit")).toBe(false);
  });
});

describe("lastUserTextIs", () => {
  it("detects when dispatch already wrote the opening user bubble", () => {
    expect(lastUserTextIs({ transcript: [{ id: "1", role: "user", text: "hi", at: "" }] }, "hi")).toBe(true);
    expect(lastUserTextIs({ transcript: [{ id: "1", role: "user", text: "hi", at: "" }] }, "bye")).toBe(false);
    expect(lastUserTextIs({ transcript: [] }, "hi")).toBe(false);
  });
});

describe("composeGrokOpeningPrompt", () => {
  it("injects profile.systemPrompt once on a fresh session", () => {
    const text = composeGrokOpeningPrompt({
      prompt: "ship rfc-006",
      systemPrompt: "You are NightMoose.",
    });
    expect(text).toMatch(/^\[Profile instructions\]\nYou are NightMoose\.\n\nship rfc-006$/);
  });

  it("keeps plan-mode and extra-dirs notes under the persona", () => {
    const text = composeGrokOpeningPrompt({
      prompt: "plan the fix",
      planMode: true,
      extraDirs: ["/tmp/extra"],
      systemPrompt: "Stay terse.",
    });
    expect(text.startsWith("[Profile instructions]\nStay terse.\n\n")).toBe(true);
    expect(text).toContain("[Plan mode]");
    expect(text).toContain("/tmp/extra");
    expect(text).toContain("plan the fix");
  });
});

describe("buildOrphanedApprovalResumePrompt", () => {
  it("tells the resumed agent to perform the approved tool and not redo completed work", () => {
    const prompt = buildOrphanedApprovalResumePrompt({
      decision: "approve",
      title: "Write: /tmp/foo.md",
      rawInput: { file_path: "/tmp/foo.md" },
    });
    expect(prompt).toContain("APPROVED");
    expect(prompt).toContain("Write: /tmp/foo.md");
    expect(prompt).toContain("/tmp/foo.md");
    expect(prompt).toMatch(/do not re-ask/i);
    expect(prompt).toMatch(/Do not restart work/i);
    expect(prompt).not.toMatch(/dismissed/i);
  });
});

describe("SessionManager approvals", () => {
  let manager: SessionManager | undefined;

  afterEach(() => {
    manager?.stopApprovalSweeper();
    manager = undefined;
  });

  it("resolves a live Claude hook without dismissing the agent", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cs-appr-"));
    const cwd = mkdtempSync(join(tmpdir(), "cs-cwd-"));
    manager = new SessionManager(testConfig(dataDir));
    const session = claudeSession(cwd);
    session.status = "running";
    manager.store.save(session);

    const approval = manager.createClaudeApproval({
      sessionId: session.id,
      toolName: "Write",
      title: "Write: /tmp/foo.md",
      toolInput: { file_path: "/tmp/foo.md", contents: "hi" },
    });
    expect(approval.status).toBe("pending");
    expect(manager.get(session.id)?.status).toBe("awaiting_approval");

    const result = await manager.resolveApproval(session.id, approval.id, "approve");
    expect(result.status).toBe("running");
    expect(result.pendingApproval).toBeFalsy();
    expect(manager.getClaudeApproval(approval.id)?.status).toBe("approved");
    expect(result.transcript.map((t) => t.text).join("\n")).not.toMatch(/dismissed/i);
  });

  it("rejects Claude tools that are not on profile.toolAllowlist", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cs-appr-"));
    const cwd = mkdtempSync(join(tmpdir(), "cs-cwd-"));
    const cfg = testConfig(dataDir);
    cfg.profiles = [
      {
        id: "fullscore",
        name: "FullScore",
        backend: "claude",
        color: "#F97316",
        toolAllowlist: ["Read", "Grep"],
      },
    ];
    manager = new SessionManager(cfg);
    const session = claudeSession(cwd);
    session.status = "running";
    manager.store.save(session);

    const approval = manager.createClaudeApproval({
      sessionId: session.id,
      toolName: "Write",
      title: "Write: /tmp/foo.md",
      toolInput: { file_path: "/tmp/foo.md", contents: "hi" },
    });
    expect(approval.status).toBe("rejected");
    expect(manager.get(session.id)?.status).toBe("running");
    expect(manager.get(session.id)?.pendingApproval).toBeFalsy();
  });

  it("keeps a parked Claude approval when the in-flight turn persists again", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cs-appr-"));
    const cwd = mkdtempSync(join(tmpdir(), "cs-cwd-"));
    manager = new SessionManager(testConfig(dataDir));
    const session = claudeSession(cwd);
    session.status = "running";
    manager.store.save(session);

    // claudeTurn holds this object and persist()s it on every tool event.
    const held = manager.get(session.id)!;
    const approval = manager.createClaudeApproval({
      sessionId: session.id,
      toolName: "Write",
      title: "Write: MAINTENANCE_LOG.md",
      toolInput: { file_path: "MAINTENANCE_LOG.md", contents: "hi" },
    });
    expect(approval.status).toBe("pending");
    expect(held).toBe(manager.get(session.id));
    expect(held.pendingApproval?.id).toBe(approval.id);
    expect(held.status).toBe("awaiting_approval");

    held.toolCalls.push({
      toolCallId: "t1",
      title: "Write",
      kind: "edit",
      status: "pending",
      updatedAt: new Date().toISOString(),
    });
    manager.store.save(held);

    const disk = JSON.parse(
      readFileSync(join(dataDir, "sessions", `${session.id}.json`), "utf8"),
    ) as DispatchSession;
    expect(disk.pendingApproval?.id).toBe(approval.id);
    expect(disk.status).toBe("awaiting_approval");
    expect(manager.getPendingApproval(session.id)?.id).toBe(approval.id);
  });

  it("orphaned approve resumes the session instead of dismissing", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cs-appr-"));
    const cwd = mkdtempSync(join(tmpdir(), "cs-cwd-"));
    manager = new SessionManager(testConfig(dataDir));
    const session = claudeSession(cwd);
    const parked = parkedWrite(session.id);
    session.pendingApprovalId = parked.id;
    session.pendingApproval = parked;
    manager.store.save(session);

    const resumes: string[] = [];
    manager.resumeOrphanedSession = (_id, prompt) => {
      resumes.push(prompt);
    };

    const result = await manager.resolveApproval(session.id, parked.id, "approve");
    expect(resumes).toHaveLength(1);
    expect(resumes[0]).toContain("APPROVED");
    expect(resumes[0]).toContain("Write: /tmp/foo.md");
    expect(result.status).toBe("running");
    expect(result.pendingApproval).toBeFalsy();
    expect(result.pendingApprovalId).toBeFalsy();
    const last = result.transcript.at(-1)?.text ?? "";
    expect(last).toMatch(/resuming the agent/i);
    expect(last).not.toMatch(/dismissed/i);
    expect(last).not.toMatch(/Send a follow-up/i);
    expect(result.autoApproveSignatures?.some((s) => s.includes("foo.md"))).toBe(true);
  });

  it("orphaned reject dismisses without spawning a follow-up", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cs-appr-"));
    const cwd = mkdtempSync(join(tmpdir(), "cs-cwd-"));
    manager = new SessionManager(testConfig(dataDir));
    const session = claudeSession(cwd);
    const parked = parkedWrite(session.id);
    session.pendingApprovalId = parked.id;
    session.pendingApproval = parked;
    manager.store.save(session);

    const resumes: string[] = [];
    manager.resumeOrphanedSession = () => {
      resumes.push("called");
    };

    const result = await manager.resolveApproval(session.id, parked.id, "reject");
    expect(resumes).toHaveLength(0);
    expect(result.status).toBe("idle");
    expect(result.pendingApproval).toBeFalsy();
    expect(result.transcript.at(-1)?.text).toMatch(/Rejected/);
    expect(result.transcript.at(-1)?.text).toMatch(/dismissed/i);
  });

  it("auto-approves read-only bash without parking the session", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cs-appr-"));
    const cwd = mkdtempSync(join(tmpdir(), "cs-cwd-"));
    manager = new SessionManager(testConfig(dataDir));
    const session = claudeSession(cwd);
    session.status = "running";
    manager.store.save(session);

    const approval = manager.createClaudeApproval({
      sessionId: session.id,
      toolName: "Bash",
      title: "Bash: git status",
      toolInput: { command: "git status" },
    });
    expect(approval.status).toBe("approved");
    expect(manager.get(session.id)?.status).toBe("running");
    expect(manager.get(session.id)?.pendingApproval).toBeFalsy();
  });
});

describe("getToolCall", () => {
  it("returns stringified rawInput for the ellipsis endpoint", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cs-appr-"));
    const cwd = mkdtempSync(join(tmpdir(), "cs-cwd-"));
    const mgr = new SessionManager(testConfig(dataDir));
    const session = claudeSession(cwd);
    session.status = "idle";
    session.toolCalls = [
      {
        toolCallId: "tc-1",
        title: "Bash",
        kind: "execute",
        status: "completed",
        updatedAt: new Date().toISOString(),
        rawInput: { command: "ls -la" },
      },
    ];
    mgr.store.save(session);
    const detail = mgr.getToolCall(session.id, "tc-1");
    expect(detail?.title).toBe("Bash");
    expect(detail?.rawInputJson).toContain("ls -la");
    expect(mgr.getToolCall(session.id, "missing")).toBeNull();
    mgr.stopApprovalSweeper();
  });
});

describe("materializeImagesInCwd", () => {
  it("copies screenshots into the project cwd so Claude Read is not sandboxed", () => {
    const cwd = mkdtempSync(join(tmpdir(), "cs-img-cwd-"));
    const srcDir = mkdtempSync(join(tmpdir(), "cs-img-src-"));
    const src = join(srcDir, "shot.png");
    writeFileSync(src, "png-bytes");
    const dests = materializeImagesInCwd(cwd, [src]);
    expect(dests).toHaveLength(1);
    expect(dests[0]!.startsWith(join(cwd, ".clankerspanker-attachments"))).toBe(true);
    expect(readFileSync(dests[0]!, "utf8")).toBe("png-bytes");
    expect(existsSync(join(cwd, ".clankerspanker-attachments", ".gitignore"))).toBe(true);
  });
});
