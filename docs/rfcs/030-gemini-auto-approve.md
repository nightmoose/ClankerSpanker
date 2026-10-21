# RFC-030 — Say when Gemini auto-approves

**Status:** Shipped
**Date:** 2026-09-25
**Branch:** main
**Severity:** P1

Document restored 2026-10-21. This number already belonged to the merged work below.
The design note was not in the tree. The number was not reassigned.

---

## Problem

Antigravity / Gemini sessions run tools without asking. The phone and the Mac
showed the same approval chrome as a backend that stops and waits, so a person
thought a gated tool was waiting when it had already run.

## What shipped

Headless `agy` is started with `--dangerously-skip-permissions` unless the
profile sets `ANTIGRAVITY_REQUIRE_PERMISSIONS=1`. `antigravityAutoApproves` in
`host/src/profiles.ts` is that check. The public profile sets `autoApprovesTools`,
and the composer shows a warning (`TaskComposerView.swift`).

- `host/src/profiles.ts`
- `host/src/acp/runners/antigravity-turn.ts`

## Testing

- `host/src/antigravity-auto-approve.test.ts`
- `host/src/acp/runners/antigravity-turn.test.ts`
