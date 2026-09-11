# RFC-014 — Close as done sticks; hide Grok helper sessions

**Status:** Accepted
**Date:** 2026-09-09
**Branch:** nightly-maintenance-2026-09-09-rfc014-close-done-hide-helpers
**Severity:** P1 — Active list is unusable; “Close as done” / Archive appear to no-op

---

## Problem

1. **Close as done (and Archive) do not leave Active.** For idle sessions
   (imported Grok disk rows, parked Claude/agy, anything not in
   `this.live`), `closeAsDone` / `setArchived` load a **fresh** copy from
   disk, mutate it, `store.save`, and return that copy. `GET /sessions`
   uses `list()`, which overlays `this.hydrated` (populated by the
   earlier `get()` when the operator opened the session). The overlay
   still has `archived: false`, so the chat stays on Active. Same hole
   on idle `cancel` / `rename` / `setSessionProject`. Live sessions
   already go through `persist()` and are fine.

2. **Grok helper sessions flood every list.** Grok Build now writes
   subagent / `subagent_resume` chats under
   `~/.grok/sessions/` (cwd `~/.grok/worktrees/.../subagent-<id>`,
   `session_kind` `subagent` or `subagent_resume`). Claude already skips
   `agent-` / `subagent` jsonl names. Grok disk import does not, so
   `syncGrokDiskSessions` and `diskSessions` show helpers the operator
   should not talk to. Already-imported wrappers stay in Active /
   Archived until filtered.

## Non-goals

- Deleting helper transcripts from `~/.grok/sessions` or Dispatch JSON.
- A UI to browse subagent transcripts (follow-up if someone wants it).
- Changing Close as done vs Archive semantics (done still completes +
  archives; Archive still only hides).
- Swift tests.

## Fix

1. Idle mutations use the hydrated object and `persist()` so `list()`
   matches disk. `deleteSession` drops the hydrated entry.

2. `isGrokHelperSession` / `isGrokHelperCwd` skip Grok disk rows whose
   `session_kind` starts with `subagent`, `worktree_label` is
   `subagent-*`, or cwd/group has a `subagent-*` path segment.
   `listDiskSessions` and `syncGrokDiskSessions` skip them.
   `GET /sessions` also omits already-imported Dispatch wrappers whose
   cwd looks like a helper (Active, Archived, and disk hints).
   `GET /sessions/:id` still works if you have the id.

3. Desktop **Close as done** refreshes the session list the same way
   Archive already does.

## Testing

- [x] `isGrokHelperSession` / `isGrokHelperCwd` cases (kind, cwd, group)
- [x] `listDiskSessions` returns the user session and skips subagent rows
- [x] `closeAsDone` / `setArchived` after `get()` — `list()` is archived
- [x] `syncGrokDiskSessions` does not import a helper cwd
- [ ] Manual: Close as done on an idle Grok chat — drops off Active;
      helper rows gone from Active / Archived / disk attach (kick host, then soak)

## Rollout

1. Kick the host LaunchAgent so `host/dist` has the list/persist fix.
2. `make check`
3. Update `docs/STATUS.md` → Shipped after merge
4. Append `MAINTENANCE_LOG.md`
5. No iOS rebuild required (list comes from the host). Linux Electron
   picks up the Close as done refresh on next desktop start.

## Follow-ups

- Optional `?includeHelpers=1` on `GET /sessions` for debugging.
- Hide Claude `agent-` jsonl the same way if any still leak past the
  filename skip.
