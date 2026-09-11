# RFC-002 — Transcript chat-only, session Files, extra folders

**Status:** Accepted
**Date:** 2026-08-24
**Branch:** nightly-maintenance-2026-08-24-rfc002-session-chat-files-folders
**Severity:** P2 — daily-driver Mac/iOS/Linux UX
**Addresses:** Transcript mixes tools/thoughts with chat; Notes has no
session file list; dispatch cwd is a typed path (or first-of-many
picker) with no extra folders, and none can be added later.

---

## Problem

1. **Chat vs noise.** Session Transcript merges user/assistant bubbles
   with tool rows, thoughts, and system lines. Operators want a chat-only
   view. A sixth tab is worse than a toggle on Transcript.

2. **Files.** Notes is todos + notes. Tool locations, cwd, extra folders,
   and attachments are the files that actually matter for a session, but
   there is no list or view from Notes. Mac already has `FileViewerPane`;
   iPhone cannot open host paths locally.

3. **Folders.** Compose has a project picker plus a typed absolute path.
   Mac `FolderPicker` already multi-selects, then throws away every path
   but the first (cwd). Extra workspace folders are not sent on dispatch.
   Mid-session there is no way to add folders. Claude already has
   `--add-dir` for attachment dirs; user extra dirs never reach it.

## Non-goals

- A new Chat tab (toggle on Transcript instead).
- Editing files in the viewer (read-only).
- Grok ACP actually sandboxes extra dirs (prompt + `_meta` only).
- Antigravity `--add-dir` (flag not documented; extra dirs go in the
  prompt; Claude gets `--add-dir`).
- Browser `/app/` first-turn folder picker (still typed cwd; follow-up).
- Swift test target.

## Fix

### Host

- `DispatchRequest.extraDirs` / `DispatchSession.extraDirs`. Validated
  like cwd (`normalizeExtraDirs`: exists, not `/`, honors
  `allowCustomPaths`).
- Claude: merge session extra dirs into `ensureAttachmentDirs` so every
  turn already passes `--add-dir` + Read grants.
- Grok / Antigravity: prepend an extra-folder note on the agent prompt.
  Grok `session/new` `_meta.extraDirs` when present.
- `PATCH /sessions/:id/extra-dirs` `{ extraDirs: string[] }` merges more
  folders mid-session. Next Claude turn picks them up; other backends
  see them on the next prompt.
- `GET /sessions/:id/files` — cwd, extra dirs, tool-call locations,
  session/project attachments (capped, deduped).
- `GET /sessions/:id/file?path=` — read if the resolved path is under
  cwd, extra dirs, or attachment stores. Size-capped. Text or base64.

### Clients (Mac native + iOS + Linux)

- Transcript: **Chat only** toggle (hide tools, thoughts, system).
- Notes: **Files** section; tap to view (Mac pane / Linux viewer / iPhone
  sheet via the file API).
- Compose: native multi-folder picker (Mac `NSOpenPanel`, Linux
  `showOpenDialog`). First folder is cwd; the rest are `extraDirs`.
  iPhone: pick extra folders from registered host project paths (the
  folders live on the host).
- Session: add extra folders later from Notes / details.

## Testing

- [ ] Host vitest: `normalizeExtraDirs`, file list/read allowlist, extra
      dirs note.
- [ ] `make check`
- [ ] Mac: Chat only; Notes Files open in viewer; pick two folders on
      dispatch; add a third mid-session.
- [ ] Linux: same surfaces.
- [ ] iPhone: Chat only; Files sheet; extra folders from project list.

## Rollout

1. Land on the named branch.
2. `make check`
3. `docs/STATUS.md` → Shipped
4. Append `MAINTENANCE_LOG.md`
5. Kickstart LaunchAgent so `host/dist` loads; rebuild Mac app.

## Follow-ups

- Browser `/app/` chat-only + files.
- Antigravity `--add-dir` if the CLI documents it.
- iPhone document picker is the wrong machine — keep host-path pickers.
