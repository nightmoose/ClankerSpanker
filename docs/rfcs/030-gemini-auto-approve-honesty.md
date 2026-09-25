# RFC-030 — Say plainly that Gemini sessions auto-approve

**Status:** Accepted
**Date:** 2026-09-25
**Branch:** nightly-maintenance-2026-09-25-rfc030-gemini-auto-approve-honesty
**Severity:** P1

---

## Problem

README → Security says agents wait for approval ("Grok: never yolo",
"Claude: PreToolUse hook"). Antigravity (`agy`) cannot ask in headless mode,
so `antigravityTurn` passes `--dangerously-skip-permissions` unless the
profile sets `ANTIGRAVITY_REQUIRE_PERMISSIONS=1`. Nothing in any client says
so. Owner decision (2026-09-25): keep auto-approve, make it visible.

## Non-goals

- Changing the default (owner chose to keep it).
- An approval bridge for `agy` (would need upstream support).

## Fix

- Host: `antigravityAutoApproves(env)` (single source of truth, used by the
  runner) and `PublicAgentProfile.autoApprovesTools`.
- iOS composer and Mac compose pane: a warning label on profiles where
  `autoApprovesTools` is true, naming the opt-out.
- README → Security: Gemini/Antigravity is not approval-gated.

## Testing

- [x] `antigravity-auto-approve.test.ts`: default true; `1`/`true` opt out;
      `publicProfiles` flag only on auto-approving Antigravity profiles and
      leaks no env.
- [ ] Manual: pick the Gemini chip in the composer → warning shows.

## Rollout

1. `make check`; Install / update host; rebuild Mac + phone.
2. `docs/STATUS.md` → Shipped; `MAINTENANCE_LOG.md`.
