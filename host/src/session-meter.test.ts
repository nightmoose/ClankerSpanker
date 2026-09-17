import { describe, expect, it } from "vitest";
import {
  END_TURN_SNAPSHOT_COOLDOWN_MS,
  applyEndTurnCreditSnapshot,
  applyOpenCreditSnapshot,
  classifyCreditDelta,
  computeCreditDelta,
  shouldSnapshotEndTurnCredits,
} from "./session-meter.js";
import type { DispatchSession } from "./types.js";

function sess(overrides: Partial<DispatchSession> = {}): DispatchSession {
  const ts = "2026-09-17T18:00:00.000Z";
  return {
    id: "s",
    backend: "grok",
    title: "t",
    prompt: "",
    cwd: "/tmp",
    model: "grok-2",
    planMode: false,
    subagents: false,
    worktree: false,
    status: "running",
    createdAt: ts,
    updatedAt: ts,
    transcript: [],
    toolCalls: [],
    events: [],
    ...overrides,
  };
}

describe("computeCreditDelta", () => {
  it("returns undefined when either snapshot is missing", () => {
    expect(computeCreditDelta(undefined, 5)).toBeUndefined();
    expect(computeCreditDelta(3, undefined)).toBeUndefined();
    expect(computeCreditDelta(null, null)).toBeUndefined();
  });

  it("returns the positive delta for normal growth", () => {
    expect(computeCreditDelta(3, 5.5)).toBe(2.5);
  });

  it("clamps negative delta to 0 (billing period rolled over mid-session)", () => {
    expect(computeCreditDelta(40, 2)).toBe(0);
  });

  it("clamps to 100 upper bound", () => {
    expect(computeCreditDelta(0, 250)).toBe(100);
  });

  it("returns undefined for non-finite inputs", () => {
    expect(computeCreditDelta(Number.NaN, 5)).toBeUndefined();
    expect(computeCreditDelta(3, Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});

describe("classifyCreditDelta", () => {
  it("returns unknown for null/undefined/NaN", () => {
    expect(classifyCreditDelta(undefined)).toBe("unknown");
    expect(classifyCreditDelta(null)).toBe("unknown");
    expect(classifyCreditDelta(Number.NaN)).toBe("unknown");
  });

  it("uses RFC defaults (green < 5, amber >= 5, red >= 10)", () => {
    expect(classifyCreditDelta(0)).toBe("green");
    expect(classifyCreditDelta(4.9)).toBe("green");
    expect(classifyCreditDelta(5)).toBe("amber");
    expect(classifyCreditDelta(9.99)).toBe("amber");
    expect(classifyCreditDelta(10)).toBe("red");
    expect(classifyCreditDelta(42)).toBe("red");
  });

  it("respects operator overrides", () => {
    expect(classifyCreditDelta(1.5, { warnPct: 1, amberPct: 3 })).toBe("amber");
    expect(classifyCreditDelta(5, { warnPct: 1, amberPct: 3 })).toBe("red");
  });

  it("falls back to defaults for bogus thresholds", () => {
    expect(classifyCreditDelta(6, { warnPct: -1, amberPct: Number.NaN })).toBe("amber");
  });
});

describe("applyOpenCreditSnapshot", () => {
  it("anchors start/last/delta when a valid pct arrives", () => {
    const s = sess();
    applyOpenCreditSnapshot(s, 3.5, "2026-09-17T18:00:00.000Z");
    expect(s.creditsUsedStartPct).toBe(3.5);
    expect(s.creditsUsedLastPct).toBe(3.5);
    expect(s.creditsUsedDeltaPct).toBe(0);
    expect(s.creditsUsedAt).toBe("2026-09-17T18:00:00.000Z");
  });

  it("no-ops on null pct (billing failure)", () => {
    const s = sess();
    applyOpenCreditSnapshot(s, null, "2026-09-17T18:00:00.000Z");
    expect(s.creditsUsedStartPct).toBeUndefined();
    expect(s.creditsUsedDeltaPct).toBeUndefined();
    expect(s.creditsUsedAt).toBeUndefined();
  });

  it("no-ops on non-finite pct", () => {
    const s = sess();
    applyOpenCreditSnapshot(s, Number.NaN, "2026-09-17T18:00:00.000Z");
    expect(s.creditsUsedStartPct).toBeUndefined();
  });
});

describe("applyEndTurnCreditSnapshot", () => {
  it("computes delta from an existing baseline", () => {
    const s = sess({
      creditsUsedStartPct: 2,
      creditsUsedLastPct: 2,
      creditsUsedDeltaPct: 0,
    });
    applyEndTurnCreditSnapshot(s, 4.75, "2026-09-17T18:05:00.000Z");
    expect(s.creditsUsedLastPct).toBe(4.75);
    expect(s.creditsUsedDeltaPct).toBe(2.75);
    expect(s.creditsUsedStartPct).toBe(2);
    expect(s.creditsUsedAt).toBe("2026-09-17T18:05:00.000Z");
  });

  it("anchors a missing baseline so subsequent turns show growth", () => {
    const s = sess();
    applyEndTurnCreditSnapshot(s, 8, "2026-09-17T18:05:00.000Z");
    expect(s.creditsUsedStartPct).toBe(8);
    expect(s.creditsUsedLastPct).toBe(8);
    expect(s.creditsUsedDeltaPct).toBe(0);
  });

  it("no-ops on null (leaves the previous delta visible)", () => {
    const s = sess({
      creditsUsedStartPct: 2,
      creditsUsedLastPct: 5,
      creditsUsedDeltaPct: 3,
      creditsUsedAt: "2026-09-17T18:03:00.000Z",
    });
    applyEndTurnCreditSnapshot(s, null, "2026-09-17T18:06:00.000Z");
    expect(s.creditsUsedDeltaPct).toBe(3);
    expect(s.creditsUsedAt).toBe("2026-09-17T18:03:00.000Z");
  });
});

describe("shouldSnapshotEndTurnCredits", () => {
  const at = "2026-09-17T18:00:00.000Z";
  const nowMs = Date.parse(at);

  it("allows the first snapshot when no prior at", () => {
    expect(shouldSnapshotEndTurnCredits(sess(), nowMs)).toBe(true);
  });

  it("blocks a snapshot inside the 30s cool-down", () => {
    const s = sess({ creditsUsedAt: at });
    expect(shouldSnapshotEndTurnCredits(s, nowMs + 5_000)).toBe(false);
  });

  it("allows a snapshot once the cool-down elapses", () => {
    const s = sess({ creditsUsedAt: at });
    expect(shouldSnapshotEndTurnCredits(s, nowMs + END_TURN_SNAPSHOT_COOLDOWN_MS)).toBe(true);
  });

  it("allows a snapshot when the clock skewed backwards", () => {
    const s = sess({ creditsUsedAt: at });
    expect(shouldSnapshotEndTurnCredits(s, nowMs - 60_000)).toBe(true);
  });
});
