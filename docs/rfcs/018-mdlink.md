# RFC-018 — Markdown link resolver with cwd context

**Status:** Draft
**Date:** 2026-09-11
**Branch:** nightly-maintenance-2026-09-11-rfc018-mdlink
**Severity:** P2

---

## Problem

Grok routinely emits Markdown links with bare filenames as the
destination:

```
- [Gangway_Architecture.pdf](Gangway_Architecture.pdf)
- [Gangway_Architecture.html](Gangway_Architecture.html)
- Linked from the top of [Gangway_Ingest_Classify_Extract.md](Gangway_Ingest_Classify_Extract.md)
```

Tapping any of those in the Mac command-center transcript pops
macOS's system alert **"The application can't be opened. −50"**
(paramErr). The transcript renders links via
`ios/GrokDispatch/GrokDispatch/Views/Session/TranscriptView.swift:567-575`
(`MarkdownView.inline()`), which uses `AttributedString(markdown:)`.
SwiftUI's default `Text` link handler forwards the raw href to
`NSWorkspace.shared.open(_:)`. A relative path — no scheme, no
absolute root — can't be routed anywhere, so macOS rejects it with
`-50`.

The session cwd needed to resolve those paths already lives on the
transcript's owning view:
`ios/GrokDispatch/GrokDispatch/Views/Session/SessionDetailView.swift:799-810`
passes `detail.cwd` down. `openFileInViewer(_:)` at
`SessionDetailView.swift:932-944` already does the right thing for
tool-call locations (prefix cwd, drop into `AppState.openInViewer`).
Nothing threads that cwd into `ExpandedMessageView` or `MarkdownView`,
so the Markdown link path never sees it.

Impact: every Grok answer that references files by name pops a
system alert instead of opening the file, which is the exact
opposite of a fluent linking experience. iPhone can't open Mac files
at all and should just not offer taps for those hrefs.

## Non-goals

- Fixing Grok's link-emission behavior. If the model wants to write
  bare filenames, we make them work; we don't rewrite prompts.
- Adding an in-app PDF/HTML viewer. Mac uses
  `AppState.openInViewer(_:)` which routes to the existing macOS
  handler chain (Preview, browser, etc.).
- Attempting host-side link rewriting. The cwd is authoritative on
  the client that opens the file; keep it there.

## Fix

Swift-only, one flow, scoped to `TranscriptView`:

1. Thread `cwd: String?` through
   `TranscriptView → ExpandedMessageView → MarkdownView` (all three
   already live in the same file). Add the parameter, default `nil`,
   plumb from `SessionDetailView.swift:799-810` where the transcript
   is instantiated.
2. Wrap the `Text(inline:)` calls in `MarkdownView` with
   `.environment(\.openURL, OpenURLAction { url in resolve(url) })`.
3. `resolve(url:)`:
   - If `url.scheme` is `http/https/file/mailto` → return `.systemAction`.
   - Otherwise treat as a relative path against `cwd`:
     - Mac: build `URL(fileURLWithPath: (cwd as NSString).appendingPathComponent(path))`
       and route through `AppState.openInViewer(_:)` for known
       previewable types (`.pdf`, `.html`, `.md`, `.png`, `.jpg`,
       `.svg`, `.txt`) or `NSWorkspace.shared.open` for the rest.
     - iOS: return `.discarded`. Files on the Mac aren't reachable
       from the phone; a follow-up RFC can add a download-through-
       host endpoint if needed.
   - `cwd == nil` (Grok subagent or a session pre-RFC-002) → fall
     back to `.discarded` with a one-line toast/log instead of a
     macOS system alert.
4. `MarkdownLinkResolver` becomes a small helper struct so the
   decision table is testable in isolation without SwiftUI.

## Testing

- [ ] Manual soak on the Mac:
  - Grok chat with `[foo.md](foo.md)` in transcript — tapping opens
    `<cwd>/foo.md` in Preview / editor via `openInViewer`.
  - Absolute `[repo README](https://github.com/…)` link still opens
    in the browser.
  - Session with `cwd == nil` — tapping shows nothing (no system
    alert), and a `[transcript] discarded relative link foo.md` log
    line appears.
- [ ] Manual soak on the phone:
  - Same message, tapping `foo.md` does nothing (no alert, no
    crash). Absolute links still open in Safari.
- [ ] No new vitest cases — host code is not touched.

## Rollout

1. Implement `MarkdownLinkResolver` helper struct + thread cwd.
2. `make check`.
3. `xcodebuild -scheme ClankerSpanker -destination 'platform=macOS' build`
   and `xcodebuild -scheme ClankerSpankerPhone -destination
   'generic/platform=iOS' build`.
4. Update `docs/STATUS.md` → Accepted; append `MAINTENANCE_LOG.md`.

## Follow-ups

- Download-through-host endpoint so the iPhone can fetch and open a
  file the Grok session referenced by relative path (needs a host
  route like `GET /sessions/:id/file?path=…` that mounts under the
  session's cwd with the usual auth).
- Consider making tool-call `locations` clickable using the same
  resolver so the tap semantics are consistent between "location
  from a tool" and "location from a Markdown link."
