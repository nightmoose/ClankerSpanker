import { describe, expect, it } from "vitest";
import type { DispatchSession } from "../../types.js";
import type { LiveSession } from "../session-helpers.js";
import { fakeContext, fakeSession } from "./fake-context.test.js";
import { flushAssistant, handleGrokAgentMessage, mergeGrokAssistantChunk } from "./grok-events.js";

function fakeLive(session: DispatchSession) {
  const responses: Array<{ id: number | string; result?: unknown; error?: { code: number; message: string } }> = [];
  const live = {
    session,
    client: {
      respond: (id: number | string, result: unknown) => responses.push({ id, result }),
      respondError: (id: number | string, code: number, message: string) =>
        responses.push({ id, error: { code, message } }),
    },
    pendingApprovals: new Map(),
    pendingQuestions: new Map(),
    assistantBuffer: "",
    thoughtBuffer: "",
  } as unknown as LiveSession;
  return { live, responses };
}

const update = (u: Record<string, unknown>) => ({ method: "session/update", params: { update: u } });

describe("handleGrokAgentMessage (RFC-055)", () => {
  it("streams message chunks and flushes them into the transcript on a tool call", async () => {
    const s = fakeSession({ backend: "grok" } as Partial<DispatchSession>);
    const { ctx, events } = fakeContext(s);
    const { live } = fakeLive(s);

    await handleGrokAgentMessage(ctx, live, update({ sessionUpdate: "agent_message_chunk", content: { text: "Hel" } }));
    await handleGrokAgentMessage(ctx, live, update({ sessionUpdate: "agent_message_chunk", content: { text: "lo" } }));
    expect(live.assistantBuffer).toBe("Hello");

    await handleGrokAgentMessage(
      ctx,
      live,
      update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read calc.py", kind: "read" }),
    );
    expect(s.transcript.map((t) => t.text)).toEqual(["Hello"]);
    expect(live.assistantBuffer).toBe("");
    expect(s.toolCalls).toHaveLength(1);
    expect(events.map((e) => e.type)).toEqual(["transcript", "transcript", "transcript", "tool_call"]);
  });

  it("merges tool_call_update into the record and surfaces diffs", async () => {
    const s = fakeSession();
    const { ctx, events } = fakeContext(s);
    const { live } = fakeLive(s);
    await handleGrokAgentMessage(ctx, live, update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Edit" }));
    await handleGrokAgentMessage(
      ctx,
      live,
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
        content: [{ type: "diff", path: "calc.py", oldText: "a - b", newText: "a + b" }],
      }),
    );
    expect(s.toolCalls[0].status).toBe("completed");
    expect(events.filter((e) => e.type === "diff")).toHaveLength(1);
  });

  it("parks an edit permission for the phone and notifies", async () => {
    const s = fakeSession();
    const { ctx, events, notifications } = fakeContext(s);
    const { live, responses } = fakeLive(s);
    await handleGrokAgentMessage(ctx, live, {
      id: 7,
      method: "session/request_permission",
      params: { toolCall: { toolCallId: "t2", title: "Edit calc.py", kind: "edit" } },
    });
    expect(responses).toEqual([]);
    expect(s.status).toBe("awaiting_approval");
    expect(live.pendingApprovals.size).toBe(1);
    expect(s.pendingApproval).not.toHaveProperty("rpcId");
    expect(events.map((e) => e.type)).toContain("approval.needed");
    expect(notifications).toEqual(["Approval needed"]);
  });

  it("auto-approves configured safe kinds without parking", async () => {
    const s = fakeSession();
    const { ctx } = fakeContext(s);
    (ctx.config as { autoApproveKinds: string[] }).autoApproveKinds = ["read"];
    const { live, responses } = fakeLive(s);
    await handleGrokAgentMessage(ctx, live, {
      id: 8,
      method: "session/request_permission",
      params: { toolCall: { title: "Read", kind: "read" } },
    });
    expect(responses).toEqual([{ id: 8, result: { outcome: { outcome: "selected", optionId: "allow-once" } } }]);
    expect(live.pendingApprovals.size).toBe(0);
  });

  it("rejects tools outside the profile allowlist", async () => {
    const s = fakeSession();
    const { ctx } = fakeContext(s, { toolAllowlist: ["Read"] });
    const { live, responses } = fakeLive(s);
    await handleGrokAgentMessage(ctx, live, {
      id: 9,
      method: "session/request_permission",
      params: { toolCall: { title: "Bash", kind: "execute" } },
    });
    expect(responses).toEqual([{ id: 9, result: { outcome: { outcome: "selected", optionId: "reject-once" } } }]);
  });

  it("parks x.ai/ask_user_question (underscore prefix too) as a respondable question", async () => {
    const s = fakeSession();
    const { ctx } = fakeContext(s);
    const { live } = fakeLive(s);
    await handleGrokAgentMessage(ctx, live, {
      id: 10,
      method: "_x.ai/ask_user_question",
      params: { questions: [{ question: "Which file?", options: [{ label: "calc.py" }] }] },
    });
    expect(s.status).toBe("awaiting_question");
    expect(s.pendingQuestion?.canRespondViaAcp).toBe(true);
    expect(s.pendingQuestion).not.toHaveProperty("rpcId");
  });

  it("parks exit_plan_mode as an approval with default options", async () => {
    const s = fakeSession();
    const { ctx, notifications } = fakeContext(s);
    const { live } = fakeLive(s);
    await handleGrokAgentMessage(ctx, live, { id: 11, method: "x.ai/exit_plan_mode", params: {} });
    expect(s.status).toBe("awaiting_approval");
    expect(s.pendingApproval?.options.map((o) => o.optionId)).toEqual(["accept", "reject"]);
    expect(notifications).toEqual(["Plan ready for approval"]);
  });

  it("refuses client fs and unknown requests instead of hanging the agent", async () => {
    const s = fakeSession();
    const { ctx } = fakeContext(s);
    const { live, responses } = fakeLive(s);
    await handleGrokAgentMessage(ctx, live, { id: 12, method: "fs/write_text_file", params: {} });
    await handleGrokAgentMessage(ctx, live, { id: 13, method: "x.ai/something_new", params: {} });
    await handleGrokAgentMessage(ctx, live, { method: "x.ai/notification_only", params: {} });
    expect(responses.map((r) => [r.id, r.error?.code])).toEqual([
      [12, -32000],
      [13, -32601],
    ]);
  });
});

describe("flushAssistant", () => {
  it("drops whitespace-only buffers without a transcript entry", () => {
    const s = fakeSession();
    const { ctx, events } = fakeContext(s);
    const { live } = fakeLive(s);
    live.assistantBuffer = "  \n";
    flushAssistant(ctx, live);
    expect(s.transcript).toEqual([]);
    expect(events).toEqual([]);
    expect(live.assistantBuffer).toBe("");
  });
});

const FULL =
  "There is one new doc, and it is an **overview only**. Closing paragraph stays on the first bubble.";
const SLICE = "new doc, and it is an **overview only**.";

describe("duplicate Grok assistant bubbles (RFC-017)", () => {
  it("does not persist a mid-sentence slice replayed after the tool-call flush", async () => {
    const s = fakeSession({ backend: "grok" } as Partial<DispatchSession>);
    const { ctx, events } = fakeContext(s);
    const { live } = fakeLive(s);

    await handleGrokAgentMessage(ctx, live, update({ sessionUpdate: "agent_message_chunk", content: { text: FULL } }));
    await handleGrokAgentMessage(
      ctx,
      live,
      update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read docs/rfcs/017-grok-dupe.md", kind: "read" }),
    );
    await handleGrokAgentMessage(ctx, live, update({ sessionUpdate: "agent_message_chunk", content: { text: SLICE } }));
    flushAssistant(ctx, live);

    expect(s.transcript.map((t) => t.text)).toEqual([FULL]);
    expect(live.assistantBuffer).toBe("");
    expect(events.filter((e) => e.type === "transcript").map((e) => (e.payload as { text?: string }).text)).toEqual([
      FULL,
      FULL,
    ]);
  });

  it("still persists a later sentence that is not a slice of the flushed text", async () => {
    const first = "I'll read the doc.";
    const second = "The doc is an overview only, with a short closing note.";
    const s = fakeSession({ backend: "grok" } as Partial<DispatchSession>);
    const { ctx } = fakeContext(s);
    const { live } = fakeLive(s);

    await handleGrokAgentMessage(ctx, live, update({ sessionUpdate: "agent_message_chunk", content: { text: first } }));
    await handleGrokAgentMessage(
      ctx,
      live,
      update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read README.md", kind: "read" }),
    );
    await handleGrokAgentMessage(ctx, live, update({ sessionUpdate: "agent_message_chunk", content: { text: second } }));
    flushAssistant(ctx, live);

    expect(s.transcript.map((t) => t.text)).toEqual([first, second]);
  });

  it("drops a replay that arrives as small pieces and only matches once they are joined", async () => {
    const s = fakeSession({ backend: "grok" } as Partial<DispatchSession>);
    const { ctx } = fakeContext(s);
    const { live } = fakeLive(s);

    await handleGrokAgentMessage(ctx, live, update({ sessionUpdate: "agent_message_chunk", content: { text: FULL } }));
    await handleGrokAgentMessage(
      ctx,
      live,
      update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read README.md", kind: "read" }),
    );
    await handleGrokAgentMessage(
      ctx,
      live,
      update({ sessionUpdate: "agent_message_chunk", content: { text: "new doc, and it " } }),
    );
    await handleGrokAgentMessage(
      ctx,
      live,
      update({ sessionUpdate: "agent_message_chunk", content: { text: "is an **overview only**." } }),
    );
    flushAssistant(ctx, live);

    expect(s.transcript.map((t) => t.text)).toEqual([FULL]);
    expect(live.assistantBuffer).toBe("");
  });

  it("composes a sliding window into one buffer without repeating the overlap", () => {
    expect(mergeGrokAssistantChunk("There is one new doc, ", "new doc, and it is an **overview only**.", "")).toEqual({
      buffer: "There is one new doc, and it is an **overview only**.",
      delta: "and it is an **overview only**.",
    });
  });

  it("treats a cumulative snapshot as the same message", () => {
    expect(mergeGrokAssistantChunk("There is one", "There is one new doc", "")).toEqual({
      buffer: "There is one new doc",
      delta: " new doc",
    });
  });

  it("keeps a short follow-up that happens to occur inside the previous text", () => {
    expect(mergeGrokAssistantChunk("", "Yes.", "There is one new doc. Yes. Done.")).toEqual({
      buffer: "Yes.",
      delta: "Yes.",
    });
  });
});
