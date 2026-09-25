# RFC-039 — Mac composer + project form fixes (focus, default project, remote hosts, layout)

**Status:** Shipped
**Date:** 2026-09-25
**Branch:** nightly-maintenance-2026-09-25-rfc039-mac-composer-fixes
**Severity:** P2

---

## Problem (hands-on test, 2026-09-25)

- Clicking the Prompt box often left focus in Task (clicks on the 8 pt
  padding went nowhere; the first click into an inactive window only
  activates it — standard macOS).
- The composer always defaulted to the first project (Fullscore).
- "Add folders… / Pick cwd… / Extra folders…" overlap, and all three open
  **this Mac's** file picker (the first writes this Mac's config) even when
  the task runs on a remote host.
- New Project sheet: placeholders rendered as left-hand labels, help text ran
  off the edge, no sensible size.

## Fix

- Prompt `TextEditor` bound to `@FocusState`, tap-to-focus, padding 8 → 2.
- `ComposerViewModel`: remember the last project per host
  (`composer.lastProjectId.<hostId>`), used when nothing is selected.
- Mac folder buttons only when the task's host is this Mac; renamed
  "Save as projects… / Use once… / Extra access…" with help text. Remote
  host with no projects → shared `EmptyHostProjectsView` (RFC-036 flow,
  now used by both composers).
- `ProjectEditorView` on macOS: `.formStyle(.grouped)`, explicit labels with
  prompts, min size 520×440.

## Testing

- [x] Manual (real clicks): click in the Prompt box focuses it; New Project
      sheet renders cleanly. Both targets build.
- Swift has no test target yet (known gap).
