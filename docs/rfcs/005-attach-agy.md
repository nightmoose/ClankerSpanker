# RFC-005 — Attach Antigravity / Gemini CLI conversations

**Status:** Accepted
**Date:** 2026-08-24
**Branch:** nightly-maintenance-2026-08-24-rfc005-attach-agy
**Severity:** P2 — Gemini profile has no “open this CLI chat” picker
**Addresses:** Grok and Claude disk sessions can be attached; `agy` chats
already sit on disk (`~/.gemini/antigravity-cli/conversations/<id>.db`)
and resume with `--conversation`, but ClankerSpanker never lists them.

---

## Problem

`GET /sessions` returns `diskSessions` (Grok) and `claudeSessions`. The
Mac/phone “on disk” lists and Linux Grok/Claude disk nav use those. A
Gemini / Antigravity profile currently shows **no** attach list
(“Antigravity (dispatch only)” on Mac; phone falls through to the Claude
section).

The CLI already stores conversation ids + workspace URIs in
`conversation_metadata.json` / `last_conversations.json`. Dispatch
sessions started here already resume via `antigravityConversationId`.
TUI/`agy` chats never get a wrapper.

Consumer Gemini app chats (gemini.google.com) stay out of scope.

## Non-goals

- Importing protobuf step blobs as a full transcript (SQLite payloads
  are not jsonl). Resume is `--conversation <id>`; a system line is
  enough until the first follow-up.
- `continue-with-grok` handoff (Claude-only for now).
- Per-profile `antigravityConfigDir` listing (still global
  `~/.gemini/antigravity-cli`).

## Fix

1. `listAgySessions()` in `host/src/sessions/reader.ts`.
2. `GET /sessions` → `agySessions` (hide already-linked /
   forgotten ids).
3. `POST /sessions/attach-agy` `{ conversationId, cwd, title?, prompt?,
   profileId? }` → idle Antigravity `DispatchSession` with
   `antigravityConversationId`. Next prompt uses existing `--conversation`.
4. Forget on hard-delete (same tombstone idea as Claude).
5. Mac / iPhone disk lists + Linux “Gemini disk” nav.

## Testing

- [ ] `listAgySessions` vitest against a temp `antigravity-cli` tree
- [ ] `make check`
- [ ] Mac: Gemini chip → on-disk row → attach → follow-up resumes

## Rollout

1. `make check`
2. Kickstart host + rebuild Mac / Nomad
3. `docs/STATUS.md` → Shipped on merge
4. Append `MAINTENANCE_LOG.md`

## Follow-ups

- Transcript excerpt from the sqlite trajectory (if Google documents it).
- Continue-with-Grok/Claude from an agy chat.
