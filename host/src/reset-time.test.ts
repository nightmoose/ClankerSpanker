import { describe, expect, it } from "vitest";
import { formatRelativeReset, formatResetLine } from "./reset-time.js";

const NOW = Date.parse("2026-09-18T12:00:00.000Z");

function isoIn(ms: number): string {
  return new Date(NOW + ms).toISOString();
}

describe("formatRelativeReset", () => {
  it("returns null for missing / invalid input", () => {
    expect(formatRelativeReset(null, NOW)).toBeNull();
    expect(formatRelativeReset(undefined, NOW)).toBeNull();
    expect(formatRelativeReset("not-a-date", NOW)).toBeNull();
  });

  it("uses <1m for sub-minute deltas", () => {
    expect(formatRelativeReset(isoIn(30_000), NOW)).toBe("in <1m");
  });

  it("formats minute range without hours", () => {
    expect(formatRelativeReset(isoIn(42 * 60_000), NOW)).toBe("in 42m");
  });

  it("keeps minutes tail under 6 h", () => {
    const dt = 2 * 60 * 60_000 + 15 * 60_000;
    expect(formatRelativeReset(isoIn(dt), NOW)).toBe("in 2h 15m");
  });

  it("rounds to hours between 6 h and 24 h", () => {
    const dt = 7 * 60 * 60_000 + 45 * 60_000;
    expect(formatRelativeReset(isoIn(dt), NOW)).toBe("in 7h");
  });

  it("shows d + h between 1 d and 4 d", () => {
    const dt = 3 * 24 * 60 * 60_000 + 4 * 60 * 60_000;
    expect(formatRelativeReset(isoIn(dt), NOW)).toBe("in 3d 4h");
  });

  it("drops the h tail past 4 d", () => {
    const dt = 5 * 24 * 60 * 60_000 + 8 * 60 * 60_000;
    expect(formatRelativeReset(isoIn(dt), NOW)).toBe("in 5d");
  });

  it("falls back to absolute short date for far futures", () => {
    // 8 days ahead of NOW = 2026-09-26.
    const dt = 8 * 24 * 60 * 60_000;
    expect(formatRelativeReset(isoIn(dt), NOW)).toBe("Sep 26");
  });

  it("falls back to absolute for past times (stale timestamps)", () => {
    const dt = -3 * 60 * 60_000;
    // Absolute for the past — same day.
    expect(formatRelativeReset(isoIn(dt), NOW)).toBe("Sep 18");
  });
});

describe("formatResetLine", () => {
  it("collapses to a single weekly line when Grok reports both fields identical", () => {
    const at = isoIn(3 * 24 * 60 * 60_000);
    expect(
      formatResetLine({ fiveHourResetsAt: at, sevenDayResetsAt: at }, NOW),
    ).toBe("Weekly plan resets in 3d");
  });

  it("honors explicit collapse hint even when only weekly is set", () => {
    const at = isoIn(2 * 24 * 60 * 60_000);
    expect(
      formatResetLine({ sevenDayResetsAt: at, collapse: true }, NOW),
    ).toBe("Weekly plan resets in 2d");
  });

  it("renders both windows for Claude", () => {
    const five = isoIn(2 * 60 * 60_000 + 15 * 60_000);
    const seven = isoIn(3 * 24 * 60 * 60_000);
    expect(
      formatResetLine({ fiveHourResetsAt: five, sevenDayResetsAt: seven }, NOW),
    ).toBe("5h resets in 2h 15m · weekly resets in 3d");
  });

  it("weekly-only when Claude 5h is missing", () => {
    const seven = isoIn(4 * 24 * 60 * 60_000);
    expect(
      formatResetLine({ sevenDayResetsAt: seven }, NOW),
    ).toBe("Weekly plan resets in 4d");
  });

  it("5h-only fallback (rare)", () => {
    const five = isoIn(90 * 60_000);
    expect(
      formatResetLine({ fiveHourResetsAt: five }, NOW),
    ).toBe("5h window resets in 1h 30m");
  });

  it("returns null when nothing is set", () => {
    expect(formatResetLine({}, NOW)).toBeNull();
  });
});
