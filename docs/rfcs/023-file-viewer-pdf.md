# RFC-023 — In-app PDF preview + share on the session file viewer

**Status:** Accepted
**Date:** 2026-09-21
**Branch:** nightly-maintenance-2026-09-21-rfc023-file-viewer-pdf
**Severity:** P2 — session 22530a89 ("Florida chicken coop design")
generated `chicken-coop-sketch.pdf` and the assistant fell back to
email because it saw no way to hand a PDF to the chat surface. Users
also can't preview PDFs in-app today; the viewer renders "Binary
file · 424 KB" and stops.

---

## Problem

`SessionFileViewer.swift:29–58` renders inline for text, markdown, and
images only. Any other binary — the chicken-coop PDF is the canonical
case — collapses to `Binary file · N KB` with no preview and no way
to export.

Files created by session tools are also often invisible in the Files
tab. `listSessionFiles` (`host/src/sessions/files.ts:202`) surfaces
cwd + extraDirs as folders, plus files that were named in a
`toolCall.locations` payload, plus attachments. A Bash-tool-written
`chicken-coop-sketch.pdf` in cwd never gets a `locations` entry, so
it doesn't appear in the tab. iOS `.disabled(file.isFolder)` on the
folder rows prevents drilling in.

Both gaps together explain "I can't attach files to this chat" — the
assistant is right that the transcript can't hold a PDF, and the
file viewer isn't currently useful for the PDF that was just
written.

## Non-goals

- Full file browser / drill-into-folders navigation. Deferred to a
  future RFC that reshapes the Files tab.
- Editing files from the client. Read + share only.
- Mac/Electron PDF viewer changes. Mac already renders PDFs via its
  `WKWebView` file viewer; Electron isn't in the loop for the
  chicken-coop shape.
- Teaching the agent's system prompt that the file viewer exists
  (agents will discover it as users start opening PDFs through it;
  system-prompt tweak is a separate RFC).

## Fix

1. **Host `mimeFor()`** (`host/src/sessions/files.ts`): add
   `pdf → application/pdf`. Everything else is unchanged; the
   base64 path in `readSessionFile` already handles binaries.

2. **Host `listSessionFiles`**: shallow scan of `session.cwd`
   top-level (non-recursive), surfacing files with
   `mtime >= session.createdAt` as `kind: "file"`. Cheap way to make
   session-authored PDFs (or any output) show up without a folder
   navigator. Cap under the existing `MAX_LIST`.

3. **iOS PDFKit preview**
   (`SessionFileViewer.swift`): when
   `content.mimeType == "application/pdf"` and `content.data` is
   non-empty, decode the base64 and render a `PDFView` (native
   scroll + pinch-zoom). Falls back to the existing
   "Binary file · N KB" line if PDFKit is unavailable.

4. **Universal share button** on the viewer toolbar: `ShareLink` is
   already there for text; extend to binary by writing the decoded
   bytes to a temp file (once per open) and sharing that URL. Works
   for PDF, docx, xlsx, zip — anything.

## Testing

- [x] `files.test.ts` — `mimeFor` returns `application/pdf` for
      `.pdf`; case-insensitive. `listSessionFiles` includes
      new-in-cwd files (mtime > createdAt) and skips older ones;
      respects `MAX_LIST`; skips dotfiles.
- [x] Test-count ratchet: 262 → ≥ 266 depending on new cases.
- [ ] Manual soak: reincarnated chicken-coop session shows
      `chicken-coop-sketch.pdf` in the Files tab on iOS; tapping
      opens PDFKit preview; share sheet exports the PDF to Files /
      Mail.
- [x] `make check`

## Rollout

1. `make check`
2. Kick LaunchAgent — host has real code changes this time.
3. Rebuild `ClankerSpankerPhone` and install to Deez Nutz + Nomad.
4. `docs/STATUS.md` → Shipped on merge.
5. Append `MAINTENANCE_LOG.md`.

## Follow-ups

- Folder drill-in on the iOS Files tab (would replace the shallow
  scan hack with a proper browser).
- Nudge assistants' system prompt: "files written to session cwd
  can be opened by the user in-app via Files tab" so agents stop
  offering email as first resort.
- Electron file viewer parity (currently no PDF path exists there
  either).
