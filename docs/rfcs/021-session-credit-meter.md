# RFC-021 — Per-session Grok credit meter

**Status:** Accepted
**Date:** 2026-09-17
**Branch:** nightly-maintenance-2026-09-17-rfc021-session-credit-meter
**Severity:** P2 — no functional break, but Alex hit 40% of the weekly
Grok plan in <24h on 2026-09-17 because two NightMoose sessions ran
26–30h each; no in-app signal told him the individual chats had
gotten expensive.

---

## Problem

Long-lived Grok sessions accumulate context; every turn re-sends the
full transcript + tool outputs, so credit burn scales quadratically
with session length. Today the only surface for this cost is the
profile-wide chip in `/app/` (RFC-013), which sums every session on
that profile. Nothing tells the operator *which* chat is expensive.

Concrete evidence, 2026-09-17:

- `~/.grok-dispatch/sessions/bab5fa06-*.json` — "ContractGate and
  NeverBlink.AI", NightMoose Grok, 2026-09-16T14:16 → 2026-09-17T16:08
  (~26h continuous rolling context).
- `~/.grok-dispatch/sessions/964f78b1-*.json` — "ClankerSpanker
  Updates (reincarnated)", NightMoose Grok, 2026-09-16T12:55 →
  2026-09-17T18:26 (~30h; reincarnated once at hour 1, then left
  open for 29 more hours).
- Reincarnation exists (`session-manager.ts:2114`) but the operator
  has no signal telling them *when* it starts paying off. Reincarnate
  itself costs ~3k input tokens; doing it on a daily timer would be
  wasteful when a session is cheap.

The RFC-020 usage chip (Grok `creditUsagePercent` via
`cli-chat-proxy.grok.com/v1/billing?format=credits`) is the
authoritative Grok-side signal. We already poll it in `usage.ts`.
Snapshot it per session and the meter falls out.

## Non-goals

- **Auto-reincarnation.** Reincarnation summarises the transcript;
  a stale summary is worse than a heavy transcript for the *next*
  turn. Suggest, do not act. Same policy as RFC-020's manual
  "Apply catalog defaults".
- **Claude / Antigravity / Bot per-session meter.** Anthropic's
  `/oauth/usage` is per-account not per-session; Antigravity
  `quotaInfo` is per-model. Grok is the only backend where the
  per-turn delta is meaningful.
- **Historical backfill.** Existing sessions do not get a starting
  snapshot retroactively; their meter reads `unknown` until the next
  turn establishes a baseline.
- **Cross-session budget tracking.** Weekly plan % is still the
  profile chip. This RFC is per-session only.

## Fix

1. **Per-session snapshots** in `DispatchSession` (`host/src/types.ts`):

   ```ts
   creditsUsedStartPct?: number;   // weekly % at session open
   creditsUsedLastPct?: number;    // weekly % after last end_turn
   creditsUsedDeltaPct?: number;   // = last - start
   creditsUsedAt?: string;         // ISO of last snapshot
   ```

   Grok backend only. Undefined for other backends and for sessions
   that predate this RFC.

2. **Fetcher** (`usage.ts::fetchGrokWeeklyCreditPct`): thin wrapper
   around `/v1/billing?format=credits` that returns `number | null`.
   Never throws; a billing failure keeps the meter unknown rather
   than blocking a session.

3. **Snapshot at open** (`session-manager.ts::runSession`, Grok
   branch, right after `session/new` returns): call the fetcher,
   apply `applyOpenCreditSnapshot(session, pct, now())` from
   `session-meter.ts`. If the fetch fails, leave undefined.

4. **Snapshot at end_turn** (`session-manager.ts::promptTurn`, inside
   `shouldFlipToIdleAfterTurn`): same fetch guarded by
   `shouldSnapshotEndTurnCredits` (30 s cool-down); apply
   `applyEndTurnCreditSnapshot`. Persist + emit `session.updated`
   with the new delta + `creditsUsedAt`.

5. **Public session shape**: `PublicSessionSummary.creditsUsedDeltaPct`
   + `creditsUsedAt` (Swift + TS mirrored). `SessionStore.toSummary`
   copies them off `DispatchSession`. `shared/openapi.yaml` has no
   schemas section; the `/sessions` summary was annotated.

6. **Threshold classifier** (`session-meter.ts::classifyCreditDelta`):
   pure `MeterTier` classifier. Clients use RFC defaults (green < 5%,
   amber ≥ 5%, red ≥ 10%). `HostConfigFile.sessionMeter` wiring was
   dropped as dead code — no consumer today. Follow-up if operators
   ever want overrides.

7. **Client UI** (parity across all four clients):
   - `/app/` session tile: `wk +N%` badge next to the status pill
     (`host/web/app.js::creditBadge`, `host/web/styles.css`).
   - Electron sidebar row: same badge
     (`desktop/renderer/app.js::creditBadge`).
   - Mac session row: badge next to `LIVE`
     (`MacCommandCenter.swift::MacSessionRow`).
   - iOS dashboard row: badge in the meta HStack
     (`Views/Dashboard/SessionRowView.swift`; shared
     `enum SessionCreditMeter` declared in that file).

## Testing

- [x] `session-meter.test.ts` (19 cases) — `computeCreditDelta`
      handles nullable start, negative deltas (billing rollover) and
      clamps to `[0, 100]`. Classifier respects RFC defaults and
      operator overrides; falls back on bogus thresholds.
- [x] `session-meter.test.ts` — `applyOpenCreditSnapshot` and
      `applyEndTurnCreditSnapshot` anchor start/last/delta and no-op
      on a null pct or NaN; end-turn anchors a missing baseline so
      subsequent turns show growth.
- [x] `session-meter.test.ts` — `shouldSnapshotEndTurnCredits` gates
      the 30 s cool-down and passes on skewed clocks.
- [x] Test-count ratchet: baseline 228 → 247.
- [ ] Manual soak: open a Grok NightMoose session, note the badge
      appears at `wk +0.0%`; run 5 tool-heavy turns; badge climbs;
      reincarnate; new session badge resets to `+0.0%`.
- [ ] Manual soak: kill billing endpoint mid-session (block via
      `/etc/hosts`), verify session still ends turns cleanly; badge
      is absent (unknown) without erroring.
- [x] `make check`

## Rollout

1. Draft on this branch, cut `nightly-maintenance-2026-09-17-rfc021-session-credit-meter` when ready to build.
2. `make check`
3. Kick LaunchAgent so `host/dist` loads
4. Rebuild ClankerSpanker Mac + install on Deez Nutz (RFC-020 style)
5. `docs/STATUS.md` → Shipped on merge
6. Append `MAINTENANCE_LOG.md`

## Follow-ups

- Antigravity per-session meter if Google exposes a per-turn quota
  delta (unlikely — `quotaInfo` is per-model).
- Auto-suggest reincarnation using a moving average of turn deltas
  (future RFC — needs data first; not worth predicting before we
  have real numbers).
- Cross-session "credit budget for this branch" view if reincarnate
  churn becomes a thing worth watching.
