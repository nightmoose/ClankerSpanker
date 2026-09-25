# RFC-051 — Split session-manager.ts, phase A: helpers out of the class file

**Status:** Shipped
**Date:** 2026-09-25
**Branch:** nightly-maintenance-2026-09-25-rfc051-split-session-manager-a
**Severity:** P1 (maintainability)

## Problem

`host/src/acp/session-manager.ts` was 4,586 lines: module helpers, three
copy-pasted tombstone stores, and every backend's turn logic in one class.

## Non-goals (phase B, next RFC)

Moving per-backend turn logic (Grok ACP, Claude, Antigravity, bot) into
runners behind one interface.

## Fix (behavior-preserving)

- `session-helpers.ts` (335 lines): approval TTLs/signatures, safe-bash
  allowlist, orphaned-approval prompt, idle/question helpers, opening prompt,
  and the `LiveSession` / `ClaudeHookApproval` / `BotRunState` types.
- `session-support.ts` (282 lines): ACP method / exit-error mapping,
  questionnaire parsing, prompt-image handling.
- `tombstones.ts`: one `TombstoneFile` replaces the three deleted-session
  stores; on-disk format unchanged (reads old string arrays too).
- `session-manager.ts` re-exports the helpers tests import; 3,823 lines.
- Done by a script (cut ranges, compute each module's imports), then typecheck.

## Testing

- [x] 374 host tests (+3 `tombstones.test.ts`, +15 direct tests in `session-helpers.test.ts` / `session-support.test.ts`), typecheck, build.
- [x] Live: deployed; 178 sessions list; a real Grok sandbox session ran to
      idle with the right answer.
