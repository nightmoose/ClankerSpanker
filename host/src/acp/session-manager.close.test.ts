import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "./session-manager.js";
import type { DispatchSession, HostConfigFile } from "../types.js";

function testConfig(dataDir: string): HostConfigFile {
  return {
    hostToken: "t".repeat(32),
    bindHost: "127.0.0.1",
    bindPort: 8787,
    grokBinary: "/bin/echo",
    projects: [],
    allowCustomPaths: true,
    profiles: [{ id: "nightmoose", name: "NightMoose", backend: "grok", color: "#22C55E" }],
    autoApproveKinds: ["read", "search", "think", "fetch"],
    notifyDesktop: false,
    dataDir,
  };
}

function grokIdle(cwd: string, id = "sess-grok"): DispatchSession {
  const ts = new Date().toISOString();
  return {
    id,
    backend: "grok",
    grokSessionId: "grok-disk-1",
    title: "Ship it",
    prompt: "p",
    cwd,
    model: "grok-build",
    planMode: false,
    subagents: true,
    worktree: false,
    status: "idle",
    createdAt: ts,
    updatedAt: ts,
    transcript: [],
    toolCalls: [],
    events: [],
  };
}

describe("SessionManager close / archive / grok disk import", () => {
  let manager: SessionManager | undefined;

  afterEach(() => {
    manager?.stopApprovalSweeper();
    manager = undefined;
  });

  it("closeAsDone on an opened idle session archives the list overlay", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cs-close-"));
    manager = new SessionManager(testConfig(dataDir));
    const session = grokIdle("/Users/me/Projects/Foo");
    manager.store.save(session);
    expect(manager.get(session.id)?.archived).toBeFalsy();

    const closed = await manager.closeAsDone(session.id);
    expect(closed.archived).toBe(true);
    expect(closed.status).toBe("completed");
    const listed = manager.list().find((s) => s.id === session.id);
    expect(listed?.archived).toBe(true);
    expect(listed?.status).toBe("completed");
    expect(manager.store.load(session.id)?.archived).toBe(true);
  });

  it("setArchived on an opened idle session updates list(), not just disk", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cs-arch-"));
    manager = new SessionManager(testConfig(dataDir));
    const session = grokIdle("/Users/me/Projects/Foo");
    manager.store.save(session);
    manager.get(session.id);

    const archived = manager.setArchived(session.id, true);
    expect(archived.archived).toBe(true);
    expect(manager.list().find((s) => s.id === session.id)?.archived).toBe(true);
  });

  it("syncGrokDiskSessions does not import subagent worktree chats", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cs-sync-"));
    manager = new SessionManager(testConfig(dataDir));
    manager.listGrokDiskSessions = () => [
      {
        id: "helper-1",
        source: "grok",
        cwd: "/Users/me/.grok/worktrees/repo/subagent-01a0692c-baff-7701-b649-7bac996a8d97",
        title: "PR review helper",
      },
      {
        id: "real-1",
        source: "grok",
        cwd: "/Users/me/Projects/Foo",
        title: "Ship the login fix",
      },
    ];
    const result = manager.syncGrokDiskSessions();
    expect(result.imported).toBe(1);
    expect(manager.list().map((s) => s.grokSessionId)).toEqual(["real-1"]);
  });
});
