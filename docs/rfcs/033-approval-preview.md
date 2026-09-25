# RFC-033 — Approval cards show the diff or command; Diff tab shows new files

**Status:** Shipped
**Date:** 2026-09-25
**Branch:** nightly-maintenance-2026-09-25-rfc033-approval-preview
**Severity:** P1

---

## Problem

Hands-on test (2026-09-25, CS UX Sandbox): approval cards for a Grok edit
and a shell command showed an **empty box**. `ApprovalBarView` (and the
web/Electron cards) only render outbound-message fields (`to`, `body`,
`reason`, `path`); Grok's `SearchReplace` input (`old_string` /
`new_string`), Claude's Edit/MultiEdit/Write and Bash `command` never
render — the one thing needed to decide was missing. The Diff tab ran
`git diff HEAD`, so files the agent *created* never appeared.

## Non-goals

- Syntax highlighting; side-by-side diffs.
- Grok applying approved edits only after the last approval (upstream).

## Fix

- `host/src/approval-preview.ts`: `approvalPreview(rawInput, toolContent)`
  → `{type:"diff", path, oldText, newText}` (ACP `diff` blocks first, then
  `old_string`/`new_string`, MultiEdit `edits[]`, Write `content`) or
  `{type:"command", command, cwd}`; 8 000-char cap with `truncated`.
  Outbound bot drafts are left to the existing rendering.
- `PendingApproval.preview` set for Grok permission requests and Claude
  hook approvals.
- iOS/Mac `ApprovalPreviewView` (red/green lines, `$ command`), browser
  `/app/` and Electron cards render the same preview.
- `gitDiff` appends untracked, non-ignored files as `new file` diffs
  (≤ 20 files, ≤ 64 KB each, binaries summarized).

## Testing

- [x] `approval-preview.test.ts` (7): ACP diff, Claude Edit, MultiEdit,
      Write, command, truncation, bot drafts untouched.
- [x] `git-diff-untracked.test.ts` (2): tracked + new files, ignored and
      binary handling; clean tree empty.
- [x] Manual (Mac app, sandbox): edit card shows `- return a - b` /
      `+ return a + b`; new-file card shows the file; command card shows
      `python test_calc.py`; Diff tab lists `calc.py` and `test_calc.py`.

## Rollout

1. `make check`; Install / update host; rebuild Mac + phone.
2. `docs/STATUS.md` → Shipped; `MAINTENANCE_LOG.md`.
