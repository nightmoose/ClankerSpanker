import { describe, expect, it } from "vitest";
import {
  claudeKeychainService,
  clampPct,
  profileUsageFromAgyModels,
  profileUsageFromOAuth,
} from "./usage.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

describe("claudeKeychainService", () => {
  it("uses default service without config dir", () => {
    expect(claudeKeychainService(undefined)).toBe("Claude Code-credentials");
    expect(claudeKeychainService("")).toBe("Claude Code-credentials");
  });

  it("hashes CLAUDE_CONFIG_DIR like Claude Code", () => {
    const dir = join(homedir(), ".claude-work");
    const expected =
      "Claude Code-credentials-" +
      createHash("sha256").update(dir).digest("hex").slice(0, 8);
    expect(claudeKeychainService(dir)).toBe(expected);
    expect(claudeKeychainService(dir + "/")).toBe(expected);
  });
});

describe("clampPct", () => {
  it("passes through 0–100 integers", () => {
    expect(clampPct(0)).toBe(0);
    expect(clampPct(4)).toBe(4);
    expect(clampPct(100)).toBe(100);
  });

  it("scales open-unit fractions in (0,1)", () => {
    expect(clampPct(0.07)).toBeCloseTo(7);
    expect(clampPct(0.53)).toBeCloseTo(53);
  });

  it("rejects non-numbers", () => {
    expect(clampPct(undefined)).toBeNull();
    expect(clampPct("12")).toBeNull();
    expect(clampPct(NaN)).toBeNull();
  });
});

describe("profileUsageFromOAuth", () => {
  it("maps five_hour / seven_day windows", () => {
    const u = profileUsageFromOAuth(
      {
        five_hour: { utilization: 12, resets_at: "2026-08-09T20:00:00Z" },
        seven_day: { utilization: 34, resets_at: "2026-08-12T20:00:00Z" },
        seven_day_opus: { utilization: 0 },
      },
      "a@example.com",
      "2026-08-09T12:00:00.000Z",
    );
    expect(u.status).toBe("ok");
    expect(u.canWork).toBe(true);
    expect(u.fiveHourPercent).toBe(12);
    expect(u.sevenDayPercent).toBe(34);
    expect(u.label).toBe("5h 12% · wk 34%");
    expect(u.accountEmail).toBe("a@example.com");
  });

  it("marks limited at ≥95% used", () => {
    const u = profileUsageFromOAuth(
      {
        five_hour: { utilization: 96 },
        seven_day: { utilization: 10 },
      },
      undefined,
      "2026-08-09T12:00:00.000Z",
    );
    expect(u.status).toBe("limited");
    expect(u.canWork).toBe(false);
  });

  it("falls back to limits[] when window fields missing", () => {
    const u = profileUsageFromOAuth(
      {
        limits: [
          { kind: "session", percent: 8, is_active: true },
          { kind: "weekly_all", percent: 3, is_active: false },
        ],
      },
      undefined,
      "2026-08-09T12:00:00.000Z",
    );
    expect(u.fiveHourPercent).toBe(8);
    expect(u.sevenDayPercent).toBe(3);
    expect(u.label).toBe("5h 8% · wk 3%");
  });
});

describe("profileUsageFromAgyModels", () => {
  it("maps remainingFraction to used percent and skips tab/chat models", () => {
    const u = profileUsageFromAgyModels(
      {
        "gemini-3-flash": { quotaInfo: { remainingFraction: 0.9642176, resetTime: "2026-08-27T21:34:19Z" } },
        "tab_flash_lite_preview": { quotaInfo: { remainingFraction: 1 } },
        "claude-sonnet-4-6": { quotaInfo: { remainingFraction: 1, resetTime: "2026-08-28T16:28:36Z" } },
      },
      { planName: "free", fetchedAt: "2026-08-21T12:00:00.000Z" },
    );
    expect(u.status).toBe("ok");
    expect(u.canWork).toBe(true);
    expect(u.fiveHourPercent).toBeCloseTo(3.578, 2);
    expect(u.label).toBe("4% · free");
    expect(u.fiveHourResetsAt).toBe("2026-08-27T21:34:19Z");
  });

  it("marks exhausted models as 100% used", () => {
    const u = profileUsageFromAgyModels(
      {
        "gemini-3-flash": { quotaInfo: { remainingFraction: 0, isExhausted: true } },
      },
      { fetchedAt: "2026-08-21T12:00:00.000Z" },
    );
    expect(u.status).toBe("limited");
    expect(u.canWork).toBe(false);
    expect(u.fiveHourPercent).toBe(100);
  });
});
