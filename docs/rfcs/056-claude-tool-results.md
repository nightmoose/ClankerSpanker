# RFC-056 — Claude tool rows finish and show output

**Status:** Shipped
**Date:** 2026-09-25
**Branch:** nightly-maintenance-2026-09-25-rfc056-claude-tool-results
**Severity:** P2

## Problem

Every Claude tool call stayed "pending" forever with no output (RFC-040 gave
Grok rows an output tail; Claude never got one). Three causes in the stream-json
path:

1. Tool results arrive as `type: "user"` frames with `tool_result` blocks;
   `ClaudeRunner` ignored `user` frames entirely.
2. `extractToolUse` returned only the first `tool_use` in a message, so
   parallel calls were dropped.
3. `claudeTurn` replaced the row on each `tool` event, so a result-only
   update would have wiped the title and input.

## Fix

- Runner emits every `tool_use`, and for each `tool_result` a
  `{ id, status: completed | failed (is_error), output }` event.
- `claudeTurn` merges a result into the known row (status + `outputPreview`
  via the shared `outputTail`), and a repeated `tool_use` frame no longer
  reopens a finished call.
- Clients unchanged: they already render `outputPreview` / `failed` (RFC-040).

## Testing

- [x] `runner-tools.test.ts` (3): fake `claude` streams two parallel tool
      uses + results (one error) → four events in order; `extractToolResults`
      edge cases.
- [x] `claude-turn.test.ts`: result merges without losing title/input;
      repeat frame doesn't reopen.
- [x] Live: Claude session in `cs-ux-sandbox` — Read row ends `completed`
      with an output preview.
