# RFC-050 — Browser + Electron parity with today's Swift features

**Status:** Shipped
**Date:** 2026-09-25
**Branch:** nightly-maintenance-2026-09-25-rfc050-web-electron-parity
**Severity:** P2

## Problem

Owner decision: all four clients stay first-class. Today's Swift-only work
left gaps:

| Feature | Browser `/app/` | Electron |
|---|---|---|
| Profile picker in Compose | missing | had it |
| Gemini auto-approve warning (RFC-030) | missing | missing |
| Add / import a project from Compose (RFC-036) | missing (and "configure on host") | local folder only, even for a remote host |
| Remembered project (RFC-039) | missing | draft kept |
| Tool rows with output + exit code (RFC-040) | no tool rows at all | rows without output |
| Labeled option checkboxes | misaligned, unlabeled | ok |

## Fix

- Browser Compose rewritten: profile picker (own state — doesn't filter the
  session list), Gemini warning, Grok-only options with labels, "+ Add
  project" / "Import from this host…" / "New project…" inline, last project
  remembered, dispatch refuses an empty project.
- Browser session view: "Tools" section with output tail and red `exit N`.
- Electron: tool rows show output + exit code (path not repeated); Compose
  has "Import from host…" (shared `discoverAndImport`) and shows "Add
  folder…" only when the active host is this machine; Gemini warning.

## Testing

- [x] Browser (live): picker switches to Gemini → warning shown, Grok options
      hidden; New project with a relative path → "Project paths must be
      absolute…"; session view shows pytest `exit 1` + error.
- [x] Electron: `node --check` on all renderer files (not launched: it
      manages its own host and would contend for :8787 on this Mac).
