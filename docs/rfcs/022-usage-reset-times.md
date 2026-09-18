# RFC-022 — Reset-time tooltip on profile usage chip

**Status:** Accepted
**Date:** 2026-09-18
**Branch:** nightly-maintenance-2026-09-18-rfc022-usage-reset-times
**Severity:** P3 — Alex asked for it while RFC-021 was warm; small,
client-only, no host restart.

---

## Problem

The profile chip on Electron / Mac / iOS shows current usage %
(`peakUsedPercent`, "34%") but no reset time. So "wk 40%" tells you
where you are but not how hard you can push before the plan rolls
over. Data is already on the wire — `ProfileUsage` carries
`fiveHourResetsAt` and `sevenDayResetsAt` for all three quota
backends (Claude OAuth, Grok billing, Antigravity `resetTime`).
Nothing renders them.

`/app/` (browser) does not show a usage chip at all today, so it's
out of scope for this RFC.

## Non-goals

- Live countdown / animated ticker (setInterval per chip is scope
  creep; hover-to-see is enough).
- Notify-on-imminent-reset ("you have 15m left in the 5h window").
- Reshaping the chip's visible text — this is a tooltip / help-text
  addition only.
- `/app/` browser chip (no chip exists there yet).

## Fix

1. **Pure formatter** in `host/src/reset-time.ts`:
   `formatResetLine(five, seven, nowMs)` → string like
   `"5h window resets in 2h 15m · weekly resets in 3d"` or
   `"Weekly plan resets in 4d 2h"` (Grok collapses both to one line).
   Buckets:
   - < 1 min: `"in <1m"`
   - < 60 min: `"in 42m"`
   - < 24 h:  `"in 4h 12m"` (drop the minutes tail past 6h)
   - < 7 d:   `"in 3d 4h"`
   - ≥ 7 d or in the past: absolute short date `"Sep 24"`.

2. **Electron chip tooltip**: add `title` attribute on the
   `.profile-chip` button (`desktop/renderer/app.js::renderProfiles`
   or wherever the chip HTML is composed).

3. **Mac / iOS chip tooltip**: `.help(usageTooltip(profile.usage))`
   on the pill in `ProfileSegmentBar.swift`. `.help` is a no-op on
   older iOS but works in the current iOS 17+ target; keeping the
   accessibility label as the fallback.

4. **Swift formatter** mirrors the TS one — inline in
   `ProfileSegmentBar.swift` as a `private static` on a
   `ResetTimeFormatter` enum, since there's no shared Swift utility
   module yet.

5. No host code changes → **no LaunchAgent bounce** required. Ship
   is a Mac + iOS rebuild only.

## Testing

- [x] `reset-time.test.ts`: minute / hour / day / week / past
      buckets; nullable inputs; Grok single-line vs Claude two-line;
      status-only fallbacks ("Grok not signed in").
- [x] Test-count ratchet: baseline 247 → 261 (14 new).
- [ ] Manual soak: hover the FullScore chip and see the 5h + weekly
      reset lines; hover NightMoose and see the single weekly line.
- [x] `make check`

## Rollout

1. `make check`
2. Rebuild `ClankerSpanker` Mac + install
3. Rebuild `ClankerSpankerPhone` + install on Deez Nutz
4. `docs/STATUS.md` → Shipped on merge
5. Append `MAINTENANCE_LOG.md`

## Follow-ups

- Add a usage chip to `/app/` browser (needs a chip anywhere first;
  not scoped here).
- Live countdown widget on the Reincarnate suggestion when the plan
  is near reset (encourages "wait for reset" vs "reincarnate now").
