import { describe, expect, it } from "vitest";
import type { SessionEvent } from "../types.js";
import { attentionBadgeCount, handleSessionPush } from "./push.js";
import type { HostConfigFile } from "../types.js";

describe("attentionBadgeCount", () => {
  it("counts awaiting approval and question, including archived-shaped rows", () => {
    expect(
      attentionBadgeCount([
        { status: "awaiting_approval" },
        { status: "awaiting_question" },
        { status: "running" },
        { status: "idle" },
      ]),
    ).toBe(2);
  });

  it("is zero when nothing needs the operator", () => {
    expect(attentionBadgeCount([{ status: "idle" }, { status: "completed" }])).toBe(0);
  });
});

describe("handleSessionPush", () => {
  const config = {
    hostToken: "t",
    bindHost: "127.0.0.1",
    bindPort: 8787,
    grokBinary: "grok",
    projects: [],
    allowCustomPaths: true,
    profiles: [],
    autoApproveKinds: [],
    notifyDesktop: false,
    dataDir: "/tmp/cs-push-unconfigured",
  } as HostConfigFile;

  const event = (type: SessionEvent["type"]): SessionEvent => ({
    type,
    sessionId: "sess-1",
    at: new Date().toISOString(),
    payload: { id: "apr-1", title: "Edit foo" },
    seq: 1,
  });

  it("no-ops when APNs is not configured", async () => {
    const out = await handleSessionPush(
      config,
      [{ id: "sess-1", status: "running", title: "Foo" }],
      event("approval.needed"),
    );
    expect(out).toMatchObject({ sent: 0, skipped: "unconfigured" });
  });

  it("ignores transcript events", async () => {
    const out = await handleSessionPush(config, [], event("transcript"));
    expect(out).toMatchObject({ sent: 0, skipped: "event" });
  });
});
