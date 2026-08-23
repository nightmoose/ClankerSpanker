# ClankerSpanker — Maintenance Log

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
