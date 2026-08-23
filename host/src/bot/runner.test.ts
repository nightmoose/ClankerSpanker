import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBotSession } from "./runner.js";
import type { ChatProvider, ChatResponse } from "./protocol.js";
import type { AgentProfile, DispatchSession, PendingApproval, SessionEvent } from "../types.js";

function fakeProvider(script: ChatResponse[]): ChatProvider {
  let i = 0;
  return {
    kind: "openai-compat",
    async chat(): Promise<ChatResponse> {
      return script[Math.min(i++, script.length - 1)]!;
    },
  };
}

function session(cwd: string): DispatchSession {
  const now = new Date().toISOString();
  return {
    id: "sess-bot",
    backend: "bot",
    title: "Hunter",
    prompt: "hunt",
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
}

describe("runBotSession", () => {
  it("writes propose_outbound to the outbox without pausing for approval", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cs-bot-run-"));
    mkdirSync(join(cwd, ".bot-outbox"));
    const s = session(cwd);
    const approvals: PendingApproval[] = [];
    const profile: AgentProfile = { id: "b", name: "B", backend: "bot", color: "#fff" };
    await runBotSession({
      session: s,
      profile,
      prompt: "draft one email",
      isFollowUp: false,
      autoApproveKinds: ["read", "search", "think", "fetch"],
      provider: fakeProvider([
        {
          text: "",
          toolCalls: [
            {
              id: "t1",
              name: "propose_outbound",
              arguments: JSON.stringify({
                channel: "email",
                to: "ada@example.com",
                body: "Hi",
                reason: "lead",
              }),
            },
          ],
        },
        { text: "Drafted.", toolCalls: [] },
      ]),
      callbacks: {
        persist() {},
        emit() {},
        isCancelled: () => false,
        requestApproval: async (_sess, approval) => {
          approvals.push(approval);
          return { decision: "approve" };
        },
      },
      signal: new AbortController().signal,
    });
    expect(approvals).toHaveLength(0);
    expect(s.status).toBe("idle");
    expect(s.pendingApproval).toBeFalsy();
    const mdName = readdirSync(join(cwd, ".bot-outbox")).find((f) => f.endsWith(".md"));
    expect(mdName).toBeTruthy();
    const files = readFileSync(join(cwd, ".bot-outbox", mdName!), "utf8");
    expect(files).toContain("sent: false");
    expect(files).toContain("status: draft");
  });

  it("auto-runs write_file into .bot-outbox without approval", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cs-bot-run-"));
    mkdirSync(join(cwd, ".bot-outbox"));
    const s = session(cwd);
    const approvals: PendingApproval[] = [];
    const profile: AgentProfile = { id: "b", name: "B", backend: "bot", color: "#fff" };
    await runBotSession({
      session: s,
      profile,
      prompt: "write a brief",
      isFollowUp: false,
      autoApproveKinds: ["read", "search", "think", "fetch"],
      provider: fakeProvider([
        {
          text: "",
          toolCalls: [
            {
              id: "t1",
              name: "write_file",
              arguments: JSON.stringify({
                path: ".bot-outbox/brief.md",
                content: "brief",
              }),
            },
          ],
        },
        { text: "Wrote.", toolCalls: [] },
      ]),
      callbacks: {
        persist() {},
        emit() {},
        isCancelled: () => false,
        requestApproval: async (_sess, approval) => {
          approvals.push(approval);
          return { decision: "approve" };
        },
      },
      signal: new AbortController().signal,
    });
    expect(approvals).toHaveLength(0);
    expect(readFileSync(join(cwd, ".bot-outbox/brief.md"), "utf8")).toBe("brief");
  });

  it("treats malformed tool JSON as a tool error, not a host crash", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cs-bot-run-"));
    const s = session(cwd);
    const profile: AgentProfile = { id: "b", name: "B", backend: "bot", color: "#fff" };
    await runBotSession({
      session: s,
      profile,
      prompt: "hunt",
      isFollowUp: false,
      autoApproveKinds: ["read", "search", "think", "fetch"],
      provider: fakeProvider([
        { text: "", toolCalls: [{ id: "t1", name: "web_search", arguments: "NOT JSON {" }] },
        { text: "recovered", toolCalls: [] },
      ]),
      callbacks: {
        persist() {},
        emit() {},
        isCancelled: () => false,
        requestApproval: async () => ({ decision: "approve" }),
      },
      signal: new AbortController().signal,
    });
    expect(s.status).toBe("idle");
    expect(s.transcript.some((t) => t.text === "recovered")).toBe(true);
  });
});
