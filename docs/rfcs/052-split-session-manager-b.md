# RFC-052 — Split session-manager.ts, phase B: CLI backends become runners

**Status:** Shipped
**Date:** 2026-09-25
**Branch:** nightly-maintenance-2026-09-25-rfc052-split-session-manager-b
**Severity:** P1 (maintainability)

## Problem

After RFC-051 the class still held every backend's turn logic. The Claude,
Antigravity and bot turns only need a handful of manager capabilities but
could reach all of its state, and were untestable without a live manager.

## Non-goals

The Grok ACP path (`runSession` / `promptTurn` / `handleAgentMessage` /
`handlePermissionRequest`) — it shares the live-session map and approval
state with the manager; next phase.

## Fix

- `acp/runners/context.ts`: `TurnContext` — config, CLI/bot run maps, get,
  persist, emitEvent, maybeNotify, profileFor, profileEnvFor, transfer
  handoff prompt, bot brain profile. Built once in the constructor with arrow
  wrappers (tests can still patch manager methods).
- `claude-turn.ts`, `antigravity-turn.ts`, `bot-turn.ts`: moved verbatim
  (`this.` → `ctx.`); the class keeps one-line delegates. Class 3,493 lines.
- Tests with a fake context and mocked CLI runners (they were impossible
  before): success, CLI failure, unknown session, Antigravity permission
  default + opt-out (RFC-030), bot limits and run-slot cleanup.

## Testing

- [x] 384 host tests (+10), typecheck, build; `context.ts` listed in
      TEST-EXCEPTIONS (types only).
- [x] Live Claude smoke surfaced an unrelated, pre-existing failure (invalid
      MCP config for the Personal profile) → RFC-053 (error detail) and
      RFC-054 (MCP schema).
