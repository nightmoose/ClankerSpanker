import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { handleGrokAgentMessage } from "./acp/runners/grok-events.js";
import type { LiveSession } from "./acp/session-helpers.js";
import type { TurnContext } from "./acp/runners/context.js";
import { SessionManager } from "./acp/session-manager.js";
import { buildAntigravityArgs } from "./antigravity/runner.js";
import { runBotSession } from "./bot/runner.js";
import { claudeToolRestrictArgs } from "./claude/runner.js";
import type { ChatProvider, ChatResponse } from "./bot/protocol.js";
import type { AgentProfile, DispatchSession, HostConfigFile } from "./types.js";

/**
 * RFC-006 follow-up. No CLI is spawned. Grok, Claude, and Bot refuse Write.
 * Antigravity has no tool flag; the host instruction is what this can check.
 */
const ALLOW = ["Read", "Grep"];

function liveFor(session: DispatchSession, allowlist: string[]) {
  const ctx: TurnContext = {
    config: { dataDir: "/tmp/cs-fake-data", promptMaxMs: 1000, autoApproveKinds: [] } as never,
    cliRunners: new Map(),
    botRuns: new Map(),
    get: (id) => (id === session.id ? session : null),
    persist: () => undefined,
    emitEvent: () => undefined,
    maybeNotify: () => undefined,
    profileFor: () =>
      ({
        id: "p",
        name: "P",
        backend: "grok",
        color: "#fff",
        toolAllowlist: allowlist,
      }) as AgentProfile,
    profileEnvFor: () => ({}),
    buildTransferHandoffPrompt: (_s, m) => m,
    botBrainProfile: (owner) => owner,
  };
  const responses: Array<{ id: number | string; result?: unknown }> = [];
  const live = {
    session,
    client: {
      respond: (id: number | string, result: unknown) => responses.push({ id, result }),
      respondError: () => undefined,
    },
    pendingApprovals: new Map(),
    pendingQuestions: new Map(),
    assistantBuffer: "",
    thoughtBuffer: "",
  } as unknown as LiveSession;
  return { ctx, live, responses };
}

function grokSession(): DispatchSession {
  const now = new Date().toISOString();
  return {
    id: "s1",
    backend: "grok",
    profileId: "p",
    title: "t",
    prompt: "p",
    cwd: "/tmp",
    model: "m",
    planMode: false,
    subagents: false,
    worktree: false,
    status: "idle",
    createdAt: now,
    updatedAt: now,
    transcript: [],
    toolCalls: [],
    events: [],
  };
}

describe("toolAllowlist Read, Grep cannot fire Write (RFC-006)", () => {
  let manager: SessionManager | undefined;

  afterEach(() => {
    manager?.stopApprovalSweeper();
    manager = undefined;
  });

  it("rejects a Grok Write permission and still accepts Read", async () => {
    const session = grokSession();
    const { ctx, live, responses } = liveFor(session, ALLOW);

    await handleGrokAgentMessage(ctx, live, {
      id: 1,
      method: "session/request_permission",
      params: { toolCall: { toolCallId: "w1", title: "Write", kind: "edit" } },
    });
    await handleGrokAgentMessage(ctx, live, {
      id: 2,
      method: "session/request_permission",
      params: { toolCall: { toolCallId: "r1", title: "Read", kind: "read" } },
    });

    expect(responses).toEqual([
      { id: 1, result: { outcome: { outcome: "selected", optionId: "reject-once" } } },
    ]);
    expect(live.pendingApprovals.size).toBe(1);
    expect([...live.pendingApprovals.values()][0]?.title).toBe("Read");
  });

  it("omits Write from Claude --tools and rejects the Write hook", () => {
    expect(claudeToolRestrictArgs(ALLOW)).toEqual(["--tools", "Read,Grep"]);

    const dataDir = mkdtempSync(join(tmpdir(), "cs-allow-"));
    const cwd = mkdtempSync(join(tmpdir(), "cs-allow-cwd-"));
    const cfg: HostConfigFile = {
      hostToken: "t".repeat(32),
      bindHost: "127.0.0.1",
      bindPort: 8787,
      grokBinary: "/bin/echo",
      projects: [],
      allowCustomPaths: true,
      profiles: [
        {
          id: "fullscore",
          name: "FullScore",
          backend: "claude",
          color: "#F97316",
          toolAllowlist: ALLOW,
        },
      ],
      autoApproveKinds: ["read", "search", "think", "fetch"],
      notifyDesktop: false,
      dataDir,
    };
    manager = new SessionManager(cfg);
    const now = new Date().toISOString();
    const session: DispatchSession = {
      id: "sess-claude",
      backend: "claude",
      title: "allowlist",
      prompt: "fix it",
      cwd,
      model: "claude",
      profileId: "fullscore",
      profileName: "FullScore",
      planMode: false,
      subagents: false,
      worktree: false,
      status: "running",
      createdAt: now,
      updatedAt: now,
      transcript: [],
      toolCalls: [],
      events: [],
    };
    manager.store.save(session);

    const approval = manager.createClaudeApproval({
      sessionId: session.id,
      toolName: "Write",
      title: "Write: /tmp/foo.md",
      toolInput: { file_path: "/tmp/foo.md", contents: "hi" },
    });
    expect(approval.status).toBe("rejected");
    expect(manager.get(session.id)?.pendingApproval).toBeFalsy();
  });

  it("tells a fresh Antigravity turn to use only Read and Grep", () => {
    const args = buildAntigravityArgs({
      prompt: "ship the note",
      skipPermissions: false,
      toolAllowlist: ALLOW,
    });
    expect(args[1]).toContain("you may only use: Read, Grep");
    expect(args[1]).toContain("Do not attempt other tools");
    expect(args[1]).not.toContain("Write");
    expect(args).not.toContain("--tools");
  });

  it("does not offer or run Bot write_file", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cs-allow-bot-"));
    const now = new Date().toISOString();
    const session: DispatchSession = {
      id: "sess-bot",
      backend: "bot",
      title: "allowlist",
      prompt: "write a file",
      cwd,
      model: "grok-4",
      planMode: false,
      subagents: false,
      worktree: false,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      transcript: [],
      toolCalls: [],
      events: [],
    };
    const profile: AgentProfile = {
      id: "b",
      name: "B",
      backend: "bot",
      color: "#fff",
      toolAllowlist: ALLOW,
    };
    let offered: string[] = [];
    let step = 0;
    const provider: ChatProvider = {
      kind: "openai-compat",
      async chat(_messages, tools): Promise<ChatResponse> {
        offered = tools.map((t) => t.name);
        step += 1;
        if (step === 1) {
          return {
            text: "",
            toolCalls: [
              {
                id: "t1",
                name: "write_file",
                arguments: JSON.stringify({ path: ".bot-outbox/nope.md", content: "nope" }),
              },
            ],
          };
        }
        return { text: "stopped", toolCalls: [] };
      },
    };

    await runBotSession({
      session,
      profile,
      prompt: "write a file",
      isFollowUp: false,
      toolsAllowlist: ALLOW,
      autoApproveKinds: ["read", "search", "think", "fetch", "edit"],
      provider,
      callbacks: {
        persist() {},
        emit() {},
        isCancelled: () => false,
        requestApproval: async () => ({ decision: "approve" }),
      },
      signal: new AbortController().signal,
    });

    expect(offered).toEqual(["read_file", "grep"]);
    expect(existsSync(join(cwd, ".bot-outbox", "nope.md"))).toBe(false);
    expect(session.toolCalls.find((t) => t.title === "write_file")?.status).toBe("failed");
  });
});
