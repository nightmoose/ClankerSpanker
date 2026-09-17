/**
 * RFC-021 pure helpers for the per-session Grok credit meter.
 *
 * Snapshots come from `/v1/billing?format=credits` at session open and after
 * each `end_turn`; delta ≈ share of the weekly plan this session has burned.
 * Classifier drives the client badge color.
 */
import type { DispatchSession, SessionMeterConfig } from "./types.js";

/** Cool-down between end-of-turn snapshots so tool-heavy bursts don't hammer billing. */
export const END_TURN_SNAPSHOT_COOLDOWN_MS = 30_000;

export type MeterTier = "unknown" | "green" | "amber" | "red";

const DEFAULT_WARN_PCT = 5;
const DEFAULT_AMBER_PCT = 10;

export function computeCreditDelta(
  start: number | undefined | null,
  last: number | undefined | null,
): number | undefined {
  if (start == null || last == null) return undefined;
  if (!Number.isFinite(start) || !Number.isFinite(last)) return undefined;
  const raw = last - start;
  // Negative = billing period rolled over mid-session. Treat as zero rather
  // than a red herring; caller can reset the baseline on next open.
  if (raw < 0) return 0;
  return Math.max(0, Math.min(100, raw));
}

export function classifyCreditDelta(
  delta: number | undefined | null,
  config?: SessionMeterConfig,
): MeterTier {
  if (delta == null || !Number.isFinite(delta)) return "unknown";
  const warn = normalisedThreshold(config?.warnPct, DEFAULT_WARN_PCT);
  const amber = normalisedThreshold(config?.amberPct, DEFAULT_AMBER_PCT);
  if (delta >= amber) return "red";
  if (delta >= warn) return "amber";
  return "green";
}

function normalisedThreshold(n: unknown, fallback: number): number {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return fallback;
  return n;
}

/**
 * Anchor a session's opening credit snapshot. Called after `session/new`
 * completes for Grok backends. No-op if the fetch failed (pct === null).
 */
export function applyOpenCreditSnapshot(
  session: DispatchSession,
  pct: number | null,
  at: string,
): void {
  if (pct == null || !Number.isFinite(pct)) return;
  session.creditsUsedStartPct = pct;
  session.creditsUsedLastPct = pct;
  session.creditsUsedDeltaPct = 0;
  session.creditsUsedAt = at;
}

/**
 * Update the "last" snapshot after `end_turn` and recompute delta. If the
 * open snapshot never landed (predates the RFC / billing was down at open),
 * anchor the baseline here so subsequent turns show growth rather than a
 * permanent zero.
 */
export function applyEndTurnCreditSnapshot(
  session: DispatchSession,
  pct: number | null,
  at: string,
): void {
  if (pct == null || !Number.isFinite(pct)) return;
  session.creditsUsedLastPct = pct;
  if (session.creditsUsedStartPct == null) {
    session.creditsUsedStartPct = pct;
  }
  session.creditsUsedDeltaPct = computeCreditDelta(
    session.creditsUsedStartPct,
    pct,
  );
  session.creditsUsedAt = at;
}

/**
 * True when it's OK to hit `/v1/billing` again. Protects the endpoint from
 * tool-heavy fast-turn bursts where end_turn events fire seconds apart.
 */
export function shouldSnapshotEndTurnCredits(
  session: DispatchSession,
  nowMs: number,
  cooldownMs: number = END_TURN_SNAPSHOT_COOLDOWN_MS,
): boolean {
  if (!session.creditsUsedAt) return true;
  const age = nowMs - Date.parse(session.creditsUsedAt);
  if (!Number.isFinite(age) || age < 0) return true;
  return age >= cooldownMs;
}
