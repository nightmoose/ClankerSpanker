# RFC-040 — Tool rows show command output and exit code

**Status:** Shipped
**Date:** 2026-09-25
**Branch:** nightly-maintenance-2026-09-25-rfc040-tool-output
**Severity:** P2

---

## Problem

Hands-on test: `python -m pytest` failed (pytest not installed), the agent
retried with `python3`, then `python3 -c …`, and each needed approval — but
every tool row just said "done", so there was no way to see *why* before
approving the retry. Rows also repeated the path already in the title.

## Fix

- Host `tool-output.ts`: `toolOutputSummary(content, rawOutput)` → last 6
  lines / 600 chars of output (ACP text blocks, else `output_for_prompt`)
  + `exit_code`. Set on Grok `tool_call` / `tool_call_update`.
- `ToolCallRecord.outputPreview` / `exitCode` survive `slimSession` (disk)
  and `toDetail` (wire); bulky `content` stays off the wire.
- Mac/iOS tool row: red `exit N` badge when non-zero, monospaced output tail
  (red on failure), subtitle hidden when the title already contains it.

## Non-goals / follow-ups

- Claude's runner doesn't forward tool output yet.
- Grok sometimes reports `exit_code: 0` mid-stream for a failing command;
  the final update carries the real code.

## Testing

- [x] `tool-output.test.ts` (5): content blocks, rawOutput + exit code,
      tail/char caps, empty, survives `toDetail`.
- [x] Manual (Mac app): pytest row shows `exit 1` + "No module named
      pytest"; second row shows `-1`.
