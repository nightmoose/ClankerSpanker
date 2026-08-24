# ClankerSpanker — Maintenance Log

---

## Run: 2026-08-24 — Host status pill flashing (RFC-004 follow-up)

Two `WebSocketServer({ server, path })` instances both subscribed to HTTP
`upgrade`. `ws` abortHandshake()s path mismatches, so `/ws/terminal` killed
every `/ws` client. Status flipped Live ↔ Offline. Route upgrades by pathname
with `noServer: true`.

---

## Run: 2026-08-24 — RFC-004 host terminal

Authenticated PTY over `ws://host:8787/ws/terminal?token=` (same host token,
`tokensMatch`). Login shell via Python `pty.fork` (no node-pty). Phone **Term**
tab, Mac toolbar ⌘⇧K sheet, Linux nav Terminal, `/app/terminal.html`.

**Soak:** phone Term → `hostname` / `launchctl`; Mac sheet; idle close.

---

## Run: 2026-08-24 — RFC-003 phone bots (create + run)

iPhone chrome had no Bots tab (`AppTab` was Sessions/Projects/Tasks/Dispatch/Settings). Mac already had hunters (⌘2). Host `POST /bots` and `POST /bots/:id/run` were live; the phone never called them.

Added **Bots** to the top strip. List + New bot sheet + Run now / last session / job / outbox. Same host APIs as Mac.

**Soak:** iPhone Bots → New bot → Create; Run now opens the hunter session.

---

## Run: 2026-08-24 — RFC-002 session chat-only, Files, extra folders

Transcript now has a **Chat only** toggle (Mac/iOS + Linux) that hides
tool rows, thoughts, and system lines. Notes gained a **Files** section
(cwd, extra dirs, tool locations, attachments) with view: Mac pane,
Linux viewer (local disk, host API fallback), iPhone sheet via
`GET /sessions/:id/file`. Dispatch accepts `extraDirs`; Mac/Linux use a
real multi-folder picker (first = cwd, rest extra). iPhone picks extra
folders from registered host projects. Mid-session `PATCH …/extra-dirs`
merges more folders; Claude gets `--add-dir` on the next turn.

**Soak:** Chat only on a noisy Claude session; Notes Files open a tool
path; pick two folders on New Session; add a third from Notes.

---

## Run: 2026-08-23 — RFC-001 markdown tables + todo jump to source

Expanded-message `MarkdownParser` had no table block — GFM `| col |` rows
rendered as pipe soup. Added table parse + `Grid` render.

Tasks tab built `SessionRoute` with session id only, so the user landed at
the bottom of the transcript. Route now carries `sourceMessageId`; detail
scrolls (retries; pin-to-bottom skipped while jumping) and opens the
expand sheet on that message. Save-as-todo footer no longer tells you to
throw the body away. Linux Tasks list used `t.sessionId` (wrong) and
ellipsis-truncated the card; both fixed, plus `openSession(id, messageId)`.

**Soak:** expand a table-heavy assistant message; tap a todo that was saved
from a message.

---

## Run: 2026-08-23 — RFC-000 CI: parse vitest summary without ANSI

Second CI fail: tests were green but the ratchet regex missed `Tests 106 passed`
because Actions emits ANSI. Strip CSI sequences and set `NO_COLOR=1`.

---

## Run: 2026-08-23 — RFC-000 CI: hermetic Grok CLI credential test

GitHub Actions failed `profileHasCredentials bot > accepts Grok CLI login`
because it asserted `true` against **this Mac’s** `~/.grok/auth.json`. CI has
no login file. Fixture now uses `GROK_HOME` + a temp `auth.json` (same injection
`profiles.ts` already honors). 106 tests pass with empty home.

---

## Run: 2026-08-23 — RFC-000 house style + CI gate

Adopted ContractGate’s loop in this repo so the next session cannot recreate
the unreviewed 10k-line pile.

**Shipped:** `docs/HOUSE-STYLE.md`; RFC template + `000-house-style`;
`docs/STATUS.md`; `scripts/house-style-check.py` (RFC index, TEST-EXCEPTIONS,
heavy-diff requires RFC+log, LAN-IP allowlist, vitest count ratchet);
`scripts/new-rfc.sh`; `Makefile` `check`; `.github/workflows/ci.yml`;
`CONTRIBUTING.md`; `host/test-baseline.txt` seeded at **106**.

**Verify:** `python3 scripts/house-style-check.py`; `cd host && npm test`
(106 passed); `npm run typecheck`; `npm run build`.

**Not in this RFC:** Swift tests, OpenAPI drift check, `192.168.50.9` default,
GrokDispatch path rename.
