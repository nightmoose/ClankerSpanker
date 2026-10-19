import { describe, expect, it, vi } from "vitest";
import { SealedInputManager } from "./sealed-input.js";

function makeManager(opts: { withEvents?: boolean } = {}) {
  const writes: Array<{ projectId: string; slot: string; value: string }> = [];
  const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  const mgr = new SealedInputManager({
    writeSecret: (projectId, slot, value) => {
      writes.push({ projectId, slot, value });
    },
    onEvent: opts.withEvents
      ? (kind, payload) => {
          events.push({ kind, payload });
        }
      : undefined,
  });
  return { mgr, writes, events };
}

describe("SealedInputManager", () => {
  it("request → submit writes the secret and resolves ok", async () => {
    const { mgr, writes } = makeManager();
    const { id, done } = mgr.request({
      sessionId: "s1",
      projectId: "p1",
      slot: "project.database_connection",
      purpose: "run SQL",
    });
    expect(mgr.get(id)).toBeDefined();
    const submitted = mgr.submit(id, "postgres://u:pw@h/db");
    expect(submitted).toBe(true);
    const result = await done;
    expect(result).toEqual({ ok: true, slot: "project.database_connection" });
    expect(writes).toEqual([
      { projectId: "p1", slot: "project.database_connection", value: "postgres://u:pw@h/db" },
    ]);
    expect(mgr.get(id)).toBeUndefined();
  });

  it("cancel resolves with ok:false and does not write", async () => {
    const { mgr, writes } = makeManager();
    const { id, done } = mgr.request({
      sessionId: "s1",
      projectId: "p1",
      slot: "s",
      purpose: "x",
    });
    expect(mgr.cancel(id)).toBe(true);
    const result = await done;
    expect(result).toEqual({ ok: false });
    expect(writes).toEqual([]);
  });

  it("submit after cancel returns false", () => {
    const { mgr } = makeManager();
    const { id } = mgr.request({
      sessionId: "s1",
      projectId: "p1",
      slot: "s",
      purpose: "x",
    });
    mgr.cancel(id);
    expect(mgr.submit(id, "late")).toBe(false);
  });

  it("submit on unknown id returns false", () => {
    const { mgr } = makeManager();
    expect(mgr.submit("nope", "x")).toBe(false);
  });

  it("ttl triggers auto-cancel with outcome:expired", async () => {
    vi.useFakeTimers();
    try {
      const { mgr, events } = makeManager({ withEvents: true });
      const { done } = mgr.request({
        sessionId: "s1",
        projectId: "p1",
        slot: "s",
        purpose: "x",
        ttlMs: 1000,
      });
      vi.advanceTimersByTime(1500);
      const result = await done;
      expect(result).toEqual({ ok: false });
      const resolved = events.find((e) => e.kind === "secret.resolved");
      expect(resolved?.payload.outcome).toBe("expired");
    } finally {
      vi.useRealTimers();
    }
  });

  it("event payloads never carry the value", () => {
    const { mgr, events } = makeManager({ withEvents: true });
    const { id } = mgr.request({
      sessionId: "s1",
      projectId: "p1",
      slot: "project.database_connection",
      purpose: "test",
    });
    mgr.submit(id, "topsecret-password");
    for (const e of events) {
      expect(JSON.stringify(e.payload)).not.toContain("topsecret-password");
    }
  });

  it("cancelForSession drops every open request for that session", async () => {
    const { mgr } = makeManager();
    const a = mgr.request({ sessionId: "s1", projectId: "p1", slot: "x", purpose: "" });
    const b = mgr.request({ sessionId: "s1", projectId: "p1", slot: "y", purpose: "" });
    const c = mgr.request({ sessionId: "s2", projectId: "p1", slot: "x", purpose: "" });
    const n = mgr.cancelForSession("s1");
    expect(n).toBe(2);
    expect(await a.done).toEqual({ ok: false });
    expect(await b.done).toEqual({ ok: false });
    expect(mgr.get(c.id)).toBeDefined();
  });

  it("listForSession reports only that session's open requests", () => {
    const { mgr } = makeManager();
    mgr.request({ sessionId: "s1", projectId: "p1", slot: "x", purpose: "" });
    mgr.request({ sessionId: "s2", projectId: "p1", slot: "y", purpose: "" });
    expect(mgr.listForSession("s1")).toHaveLength(1);
    expect(mgr.listForSession("s3")).toHaveLength(0);
  });
});
