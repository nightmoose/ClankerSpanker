# RFC-055 — Split Grok ACP inbound handling out of SessionManager

**Status:** Shipped
**Date:** 2026-09-25
**Branch:** nightly-maintenance-2026-09-25-rfc055-grok-events-split
**Severity:** P3 (maintainability)

## Problem

After RFC-052 `session-manager.ts` was still ~3,500 lines. The Grok ACP
inbound path — `session/update` streaming, permission requests,
`x.ai/ask_user_question`, `x.ai/exit_plan_mode`, soft-parked questionnaires,
assistant flushing — was ~470 lines of private methods with no direct tests.

## Fix

Move it verbatim to `acp/runners/grok-events.ts` as functions of
`(TurnContext, LiveSession, …)`. It needs only `config`, `persist`,
`emitEvent`, `maybeNotify` and `profileFor`, all already on RFC-052's
`TurnContext`. `SessionManager` keeps two one-line wrappers
(`handleAgentMessage`, `flushAssistant`). No behaviour change.

`session-manager.ts`: 3,489 → 3,028 lines.

## Testing

- [x] `grok-events.test.ts` (10): chunk streaming + flush on tool call,
      tool_call_update merge + diff event, phone-parked permission (no rpcId
      leak), auto-approve kinds, profile allowlist reject, underscore-prefixed
      ask_user_question, exit_plan_mode defaults, fs / unknown requests
      answered, whitespace flush.
- [x] Full suite + typecheck unchanged otherwise.
- [x] Live: Grok session in `cs-ux-sandbox` streams, parks an edit approval,
      approves, completes.
