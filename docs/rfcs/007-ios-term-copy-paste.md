# RFC-007 — Phone copy/paste: Term paste + session message selection

**Status:** Accepted
**Date:** 2026-08-29
**Branch:** nightly-maintenance-2026-08-29-rfc007-ios-term-copy-paste
**Severity:** P1 — cannot run a copied host command from the phone without
retyping it

---

## Problem

The iPhone Term tab (`TerminalView` + WKWebView xterm) has accessory keys
(Esc, Tab, Ctrl-C, arrows) but **no paste**. iOS does not deliver a
clipboard paste into the xterm canvas the way a Mac keyboard does, so a
command sitting on the clipboard cannot reach the PTY.

The expanded-message popup (`ExpandedMessageView`) is the place you go
to read a long agent reply (often containing `launchctl`, `git`, `agy`
lines you want to run). SwiftUI `.textSelection(.enabled)` on markdown
`Text` does not give a reliable select-and-copy on iPhone, so there is
no path: session → copy snippet → Term → paste.

## Non-goals

- Copy from the xterm selection itself (follow-up).
- SSH / a second clipboard channel.
- Changing the PTY protocol or host token.
- Linux Electron / browser chrome beyond the shared `terminal.html`
  paste listener (those already have OS paste if the page is focused).

## Fix

1. **Term paste (iPhone)** — a **Paste** keycap on the accessory bar
   reads `UIPasteboard` and sends the string through
   `window.pasteClankerText` → xterm `term.paste()` (bracketed paste
   when the shell supports it) → existing `type: "in"` WS frames.
   `terminal.html` also listens for the DOM `paste` event so a long-press
   Paste inside the web view works when WKWebView delivers it.

2. **Expanded message (session popup)** — iPhone gets a **Read / Select**
   segmented control. **Select** is a non-editable `UITextView` (real
   system text selection + Copy). **Read** stays `MarkdownView`. Toolbar
   **Copy** copies the whole message. Fenced code blocks get a **Copy**
   chip. Transcript bubble long-press gains **Copy**.

No host API changes.

## Testing

- [x] `make check` (host ratchet unchanged; Swift has no tests)
- [ ] iPhone Term: copy a command in Notes → Term → Paste → it runs
- [ ] iPhone session: Expand a reply → Select → highlight a line → Copy
      → Term Paste
- [ ] Code-block Copy chip puts the fence body on the pasteboard
- [ ] Mac expand popup still renders markdown; Copy toolbar works

## Rollout

1. Rebuild the iPhone (and Mac) app from `project.yml` sources.
2. `make check`
3. `docs/STATUS.md` → Shipped on merge
4. Append `MAINTENANCE_LOG.md`

## Follow-ups

- Copy from xterm selection on iPhone.
- Selectable text on the inline transcript bubbles (not just Expand).
