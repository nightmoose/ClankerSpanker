# RFC-047 — Finish the ClankerSpanker rename (in-repo parts only)

**Status:** Shipped
**Date:** 2026-09-25
**Branch:** nightly-maintenance-2026-09-25-rfc047-rename-safe-parts
**Severity:** P2

## Problem

The GrokDispatch → ClankerSpanker rename was half done: sources lived in
`ios/GrokDispatch/GrokDispatch/`, stale `GrokDispatch.xcodeproj` and
`GrokDispatch.xcodeproj.bak` sat next to the real project, the API spec was
titled "Grok Dispatch Host API", and the only token header was
`x-grok-dispatch-token`. AGENTS.md opened with a table of traps.

## Non-goals (owner decision: safe parts only)

Moving `~/Projects/GrokDispatch` or `~/.grok-dispatch`, changing bundle
ids, dropping the `grokdispatch://` scheme or the legacy header.

## Fix

- `git mv ios/GrokDispatch → ios/ClankerSpanker`, sources
  `GrokDispatch/ → ClankerSpanker/`; `project.yml` paths; xcodegen.
- Stale `GrokDispatch.xcodeproj` (tracked) and `.bak` removed.
- `auth.ts` accepts `x-clankerspanker-token` as well as the legacy header
  (same constant-time compare); CORS allow-list includes it.
- OpenAPI title; AGENTS / README / CLIENTS / NEXT-STEPS / RUN-MAC /
  PROJECT_STATUS / CLAUDE / HOUSE-STYLE / Makefile paths and naming table.
  Historical RFCs and MAINTENANCE_LOG keep the old paths.

## Testing

- [x] `auth.test.ts` (+4): new header, legacy header, wrong value, empty
      configured token.
- [x] All three schemes build from `ios/ClankerSpanker`; `make test-swift`
      11/11; host 354/354.

## Rollout

Anyone with Xcode open on the old path: reopen
`ios/ClankerSpanker/ClankerSpanker.xcodeproj`.
