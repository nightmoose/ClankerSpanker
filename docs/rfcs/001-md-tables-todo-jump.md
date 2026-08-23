# RFC-001 — Markdown tables in the message viewer + todo jump to source

**Status:** Shipped
**Date:** 2026-08-23
**Branch:** nightly-maintenance-2026-08-23-rfc001-md-tables-todo-jump
**Severity:** P2 — daily-driver Mac/iOS UX
**Addresses:** expanded-message markdown tables render as pipe soup; Tasks
tab opens the session, not the originating transcript row, and the todo
row does not surface the full source message.

---

## Problem

1. **Tables.** `MarkdownView` / `MarkdownParser` (expanded-message sheet)
   handle headings, lists, fences, quotes, and inline emphasis. They have
   **no table block**. GFM rows (`| col | col |`) fall through as a
   paragraph, so a NEXT-STEPS-style status table is unreadable.

2. **Todo → message.** `SessionTask.sourceMessageId` is stored and Notes
   can jump. The global **Tasks** surface (`TasksView`) builds a
   `SessionRoute` with only `sessionId`, so the user lands at the bottom
   of the transcript. Linux `renderTasks` uses the wrong field
   (`t.sessionId` instead of `t.sourceSessionId`) and also does not jump.

3. **Todo text.** Save-as-todo encourages “edit down to just the action.”
   The Tasks row then shows only that snippet. The useful artifact is the
   **original message** (tables included). Jump + expand is the fix;
   stop telling the user to throw the body away.

`pinBottom` retries for ~1.4s on tab/content change and will **undo** a
jump if we don’t skip pinning while a jump is in flight. That is why
in-session “Jump to message” is also flaky on long transcripts.

## Non-goals

- Markdown tables in the Linux Electron *transcript bubble* (still
  `escapeHtml` plaintext). Jump from the Linux Tasks list is in scope.
- A Swift test target (still the RFC-000 follow-up).
- Raising the `slimSession` 120-entry transcript cap. If the source
  message has aged out, jump is a no-op and the todo text remains.

## Fix

1. Parse GFM pipe tables in `MarkdownParser` (`header` + separator +
   rows). Render with `Grid` inside a horizontal `ScrollView`.
2. `SessionRoute.messageId`. `SessionDetailView` accepts it, switches to
   Transcript, scrolls (retried, and **pin-to-bottom skipped** while
   jumping), and opens `ExpandedMessageView` on that entry.
3. `TasksView` passes `sourceMessageId`, shows the full `task.text`
   (no line limit), and the save-as-todo footer no longer asks the user
   to discard the message.
4. Linux Tasks list: `sourceSessionId` + `openSession(id, messageId)`.

## Testing

- [ ] Host: `make check` (no host behavior change besides docs).
- [ ] Mac: expand a message that contains a `| col |` table — header +
      rows, not raw pipes.
- [ ] Mac/iPhone: Tasks row → lands on the source bubble and the expand
      sheet opens with the full markdown.
- [ ] Notes “Jump to message” still works and is not yanked to the bottom.
- [ ] Linux: Tasks card opens the right session and scrolls to `msg-{id}`.

## Rollout

1. Land on the named branch; `make check`.
2. `docs/STATUS.md` → Shipped.
3. Append `MAINTENANCE_LOG.md`.

## Follow-ups

- Swift unit tests for `MarkdownParser`.
- Electron transcript markdown (tables included).
- `slimSession` transcript window vs. todo source ids.
