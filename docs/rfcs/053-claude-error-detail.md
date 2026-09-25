# RFC-053 — Claude failures say why

**Status:** Shipped
**Date:** 2026-09-25
**Branch:** nightly-maintenance-2026-09-25-rfc053-claude-error-detail
**Severity:** P2

## Problem

A failing Claude turn surfaced only "Claude exited with code 1" (session
error, logs, phone). `ClaudeRunner` read stderr but only re-emitted it as a
`system` event nobody listened to, and ignored Claude's `is_error` result.

## Fix

Keep the last 800 chars of stderr and any `is_error` result text; on a
non-zero exit with no reply, the error becomes
`Claude exited with code N: <result error, else stderr tail>`.

## Testing

- [x] `runner-errors.test.ts` (3) with a fake `CLAUDE_BINARY`: stderr
      detail, error result, bare exit unchanged.
- [x] Live: the Personal-profile failure now reads "…Invalid MCP
      configuration: mcpServers.github: Does not adhere to MCP server
      configuration schema" (→ RFC-054).
