import { afterEach, describe, expect, it, vi } from "vitest";
import { DEMO_NOTICE, DemoReadOnlyError, demoApi, demoSessionIds } from "./demo.js";

// RFC-067: the read-only demo answers the routes the UI reads, in the
// gateway's shapes, and never touches the network.

afterEach(() => vi.restoreAllMocks());

describe("demo data", () => {
  it("lists sessions in the shape GET /sessions returns", async () => {
    const r = await demoApi("/sessions");
    expect(r.sessions.length).toBeGreaterThanOrEqual(3);
    expect(r.archivedSessions.length).toBeGreaterThanOrEqual(1);
    expect(r.diskSessions.length).toBeGreaterThan(0);
    expect(r.claudeSessions.length).toBeGreaterThan(0);
    for (const s of [...r.sessions, ...r.archivedSessions]) {
      expect(s).toMatchObject({ id: expect.any(String), title: expect.any(String), status: expect.any(String) });
      // The list is summaries; transcripts come from GET /sessions/:id.
      expect(s.transcript).toBeUndefined();
    }
  });

  it("covers Grok and Claude, an approval, and a question", async () => {
    const { sessions } = await demoApi("/sessions");
    expect(new Set(sessions.map((s) => s.backend))).toEqual(new Set(["grok", "claude"]));
    expect(sessions.map((s) => s.status)).toEqual(expect.arrayContaining(["awaiting_approval", "awaiting_question", "running"]));
  });

  it("has a detail for every listed session", async () => {
    for (const id of demoSessionIds()) {
      const d = await demoApi(`/sessions/${id}`);
      expect(d.id).toBe(id);
      expect(Array.isArray(d.transcript)).toBe(true);
      expect(Array.isArray(d.toolCalls)).toBe(true);
    }
  });

  it("shows an approval card with a diff and tool rows with output", async () => {
    const d = await demoApi("/sessions/demo-checkout");
    expect(d.pendingApproval.preview).toMatchObject({ type: "diff", oldText: expect.any(String), newText: expect.any(String) });
    expect(d.toolCalls.some((t) => t.exitCode === 1 && t.outputPreview)).toBe(true);
  });

  it("returns profiles as a remote, non-admin caller sees them", async () => {
    const r = await demoApi("/profiles?admin=1");
    expect(r.admin).toBe(false);
    expect(r.adminProfiles).toEqual([]);
    expect(r.profiles.map((p) => p.backend)).toEqual(expect.arrayContaining(["grok", "claude"]));
    for (const p of r.profiles) expect(p.env).toBeUndefined();
  });

  it("returns projects, an empty MCP catalog, and no bots", async () => {
    expect((await demoApi("/projects")).projects.length).toBeGreaterThan(0);
    expect(await demoApi("/mcp/catalog")).toEqual({ servers: [], assignments: {} });
    expect(await demoApi("/bots")).toEqual({ bots: [] });
  });

  it("hands out copies, so the UI cannot change the canned data", async () => {
    const a = await demoApi("/sessions/demo-checkout");
    a.title = "changed";
    a.transcript.length = 0;
    const b = await demoApi("/sessions/demo-checkout");
    expect(b.title).toBe("Fix the flaky checkout test");
    expect(b.transcript.length).toBeGreaterThan(0);
  });
});

describe("demo is read-only and offline", () => {
  it("refuses every write with a notice that says what the gateway would do", async () => {
    for (const [path, words] of [
      ["/sessions/demo-checkout/approve", "Approve"],
      ["/sessions/demo-checkout/reject", "Reject"],
      ["/sessions/demo-migration/answer-questions", "answers"],
      ["/sessions/demo-deps/prompt", "message"],
      ["/dispatch", "starts an agent"],
      ["/profiles", ""],
    ]) {
      const err = await demoApi(path, { method: "POST", body: "{}" }).catch((e) => e);
      expect(err).toBeInstanceOf(DemoReadOnlyError);
      expect(err.message.startsWith(DEMO_NOTICE)).toBe(true);
      expect(err.message).toContain(words);
    }
  });

  it("refuses token, ticket, and host routes even as GET", async () => {
    for (const path of ["/ws/ticket", "/auth/validate", "/host/update", "/connect.json", "/push/status"]) {
      await expect(demoApi(path)).rejects.toBeInstanceOf(DemoReadOnlyError);
    }
  });

  it("errors on an unknown session instead of inventing one", async () => {
    await expect(demoApi("/sessions/nope")).rejects.toThrow(/No such session/);
  });

  it("never calls fetch or opens a WebSocket", async () => {
    const fetchSpy = vi.fn();
    const wsSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("WebSocket", wsSpy);
    try {
      await demoApi("/sessions");
      for (const id of demoSessionIds()) await demoApi(`/sessions/${id}`);
      await demoApi("/profiles?admin=1");
      await demoApi("/sessions/demo-checkout/approve", { method: "POST" }).catch(() => {});
    } finally {
      vi.unstubAllGlobals();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(wsSpy).not.toHaveBeenCalled();
  });
});
