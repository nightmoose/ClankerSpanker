# RFC-038 — Session list status follows live events

**Status:** Shipped
**Date:** 2026-09-25
**Branch:** nightly-maintenance-2026-09-25-rfc038-live-list-status
**Severity:** P1

---

## Problem

Hands-on test: the Mac sidebar said "Queued" while the session header said
"Running", and later "Needs approval" after the approval was resolved. The
header reads the live event stream; the list only changed on a full
refetch, and `scheduleSessionRefresh` restarted an 800 ms debounce on every
event — a busy session emits faster than that, so the refetch kept being
postponed until the session went quiet.

## Fix (AppState, shared by Mac and iPhone)

- `applyLiveStatus`: on `approval.needed` / `question.needed` /
  `approval.resolved` / `question.answered` / `session.*` with a `status`,
  patch the matching `(hostId, sessionId)` row in `sessions` and
  `archivedSessions` immediately.
- `scheduleSessionRefresh`: still debounces 800 ms, but never postpones a
  refresh that has been pending ≥ 3 s.

## Testing

- [x] Manual (Mac, sandbox, approvals via API): row went Needs approval →
      Running within ~1 s of approving, then Your turn as the host went idle.
- Swift has no test target yet (known gap).
