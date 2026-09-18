/**
 * RFC-022 pure formatter for the profile-chip reset-time tooltip.
 *
 * Buckets:
 *   < 1 min             → "in <1m"
 *   < 60 min            → "in 42m"
 *   < 6 h               → "in 2h 15m"
 *   < 24 h              → "in 4h"
 *   < 7 d               → "in 3d 4h" (drops the hours tail past 4d)
 *   ≥ 7 d or in the past → absolute short date, e.g. "Sep 24"
 */

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

export function formatRelativeReset(iso: string | null | undefined, nowMs: number): string | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return null;
  const diff = ts - nowMs;

  // Past or ≥ 7 d → absolute date
  if (diff <= 0 || diff >= WEEK_MS) return absoluteShort(ts);

  if (diff < MIN_MS) return "in <1m";
  if (diff < HOUR_MS) {
    const m = Math.floor(diff / MIN_MS);
    return `in ${m}m`;
  }
  if (diff < 6 * HOUR_MS) {
    const h = Math.floor(diff / HOUR_MS);
    const m = Math.floor((diff % HOUR_MS) / MIN_MS);
    return m > 0 ? `in ${h}h ${m}m` : `in ${h}h`;
  }
  if (diff < DAY_MS) {
    const h = Math.floor(diff / HOUR_MS);
    return `in ${h}h`;
  }
  // < 7 d
  const d = Math.floor(diff / DAY_MS);
  if (d >= 4) return `in ${d}d`;
  const h = Math.floor((diff % DAY_MS) / HOUR_MS);
  return h > 0 ? `in ${d}d ${h}h` : `in ${d}d`;
}

function absoluteShort(ts: number): string {
  const d = new Date(ts);
  const month = d.toLocaleString("en-US", { month: "short" });
  return `${month} ${d.getDate()}`;
}

/**
 * Build the tooltip lines from a profile's `ProfileUsage`. Returns `null`
 * when no reset info is available (status-only cases handled by the caller).
 */
export interface ResetInputs {
  fiveHourResetsAt?: string | null;
  sevenDayResetsAt?: string | null;
  /** True when the two ISO strings collapse to the same period (Grok). */
  collapse?: boolean;
}

export function formatResetLine(inputs: ResetInputs, nowMs: number): string | null {
  const five = formatRelativeReset(inputs.fiveHourResetsAt, nowMs);
  const seven = formatRelativeReset(inputs.sevenDayResetsAt, nowMs);

  // Grok — both fields point at the same billing period end. Show once.
  const same =
    inputs.collapse === true ||
    (!!inputs.fiveHourResetsAt &&
      !!inputs.sevenDayResetsAt &&
      inputs.fiveHourResetsAt === inputs.sevenDayResetsAt);

  if (same && seven) return `Weekly plan resets ${seven}`;
  if (five && seven) return `5h resets ${five} · weekly resets ${seven}`;
  if (seven) return `Weekly plan resets ${seven}`;
  if (five) return `5h window resets ${five}`;
  return null;
}
