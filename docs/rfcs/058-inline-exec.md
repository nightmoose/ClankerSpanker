# RFC-058 — Inline shell execution from chat code blocks

**Status:** Accepted
**Date:** 2026-10-02
**Branch:** nightly-maintenance-2026-10-02-rfc058-inline-exec
**Severity:** P2

---

## Problem

When an agent produces a `` ```bash `` code block, the user must manually copy it,
switch to a terminal, paste, run, then copy back the output to continue the
conversation. This 4-step detour is the main friction point for debugging cycles.

## Non-goals

- Inline terminal (PTY) in the chat bubble — follow-up RFC.
- Electron / browser client — follow-up; iOS/Mac scope here.
- Execution approval gate — the host token already gates this endpoint;
  the user chose to tap Run.

## Fix

### Host — `POST /exec`

New endpoint in `host/src/exec.ts`:

```
POST /exec
Authorization: Bearer <token>

{ "command": string, "cwd"?: string, "timeoutMs"?: number }

→ 200 { "stdout": string, "stderr": string, "exitCode": number, "durationMs": number }
```

- `timeoutMs` defaults to 30 000, capped at 60 000.
- Output capped at 100 KB each stream.
- Uses the configured login shell (`$SHELL` → `/bin/bash`).
- `cwd`, if given, must be an existing directory (validated via `statSync`; returns 400 otherwise).
- Requires auth (same bearer gate as every other route).

### iOS/Mac — Run button in expanded code blocks

`MarkdownParser.Block.code` gains a `lang` field (was opaque `String`; now
`code(lang: String?, body: String)`). The fence opener `` ```bash `` is parsed
to extract the language specifier.

`MarkdownView` gains `onRunCode: ((String) -> Void)?`. When a code block's lang
is `bash`, `sh`, `zsh`, or `shell`, a "Run" button appears alongside the
existing "Copy" button. Tapping it fires `onRunCode(body)`.

The callback threads from `MarkdownView` → `ExpandedMessageView` →
`TranscriptView` → `SessionDetailView`, where `vm.runAndInject(command:api:)`
is called:

1. `POST /exec` with the command and the session `cwd`.
2. Formats output as a fenced code block: `` `$ cmd\nstdout+stderr` ``.
3. Appends an optimistic `user` entry to the transcript immediately.
4. `POST /sessions/:id/prompt` so the agent sees the output and continues.

## Testing

- [ ] `exec.test.ts`: stdout, stderr, nonzero exit, timeout, cwd validation, max-timeout clamp (6 tests)
- [ ] `openapi-contract.test.ts` passes (catches missing spec entry automatically)
- [ ] Manual: tap Run on a `bash` block in an expanded assistant message → output appears as a user bubble and the agent responds

## Rollout

1. `make check`
2. Build + install `ClankerSpankerPhone` on your iPhone
3. Update `docs/STATUS.md` → Shipped
4. Append `MAINTENANCE_LOG.md`

## Follow-ups

- Electron/browser Run button (same `/exec` endpoint, different UI).
- Approval gate option for untrusted commands.
- Shell block detection heuristic for unlabelled fences (trailing `$`-prompt lines, etc.).
