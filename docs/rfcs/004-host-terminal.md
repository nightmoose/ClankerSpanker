# RFC-004 — Host terminal from the phone (and other clients)

**Status:** Accepted
**Date:** 2026-08-24
**Branch:** nightly-maintenance-2026-08-24-rfc002-session-chat-files-folders
**Severity:** P1 — operator loop (“run this when you’re back at the Mac”)
**Addresses:** kickstart, git, launchctl, `agy` login, and similar host-shell
jobs currently require sitting at the computer.

---

## Problem

ClankerSpanker’s phone and laptop clients can dispatch agents, approve
tools, and manage bots. They cannot open a **shell on the host**. The
docs still say “operator: run this when you get back to the Mac”
(`launchctl kickstart`, host updates, CLI login). That is the gap.

A raw OpenSSH client in the app would be a second security and
connectivity stack (port 22, keys, `Remote Login`, a different host
string than `:8787`). The product already has an authenticated gateway.

## Non-goals

- OpenSSH to port 22, key management, jump hosts, or `~/.ssh/config`.
- tmux attach, mosh, SFTP, or recording/replay.
- Root-by-default or a passwordless sudo backdoor.
- Browser `/app/` first-class tab chrome (standalone `/app/terminal.html`
  is enough).

## Fix

Authenticated **PTY over WebSocket** on the existing host:

- `ws://<host>:8787/ws/terminal?token=` — same token as `/ws` (`tokensMatch`,
  empty token authorises nobody). No new header name.
- Host spawns the user’s login shell (`$SHELL -il`) on a real PTY via a
  stdlib **Python 3** bridge (`pty.fork`). No `node-pty` native addon
  (LaunchAgent installs stay `tsc`-only).
- Cap 3 concurrent PTYs. Idle (no input) 30 minutes. Kill the process
  group on WS close. Do not log PTY bytes.
- Clients: xterm.js page at `/app/terminal.html` (static, unauthenticated
  HTML; the socket is the gate). Phone **Term** tab, Mac toolbar sheet,
  Linux nav **Terminal**. Accessory keys on iPhone (Esc, Tab, Ctrl, arrows).

`launchctl kickstart`, `cd ~/Projects/…`, `agy`, `git` — those are just
commands in that shell.

## Testing

- [ ] Frame codec vitest (encode/decode, split reads)
- [ ] PTY bridge: spawn, `echo`, read back (skip if no `python3`)
- [ ] `make check`
- [ ] Phone: Term tab, type `hostname`, Ctrl-C
- [ ] Mac: toolbar Terminal sheet
- [ ] Linux: Terminal nav

## Rollout

1. Kickstart host so `host/dist` + `pty-bridge.py` load.
2. Rebuild Mac/iPhone apps.
3. `docs/STATUS.md` → Shipped on merge
4. Append `MAINTENANCE_LOG.md`

## Follow-ups

- OpenSSH transport as an optional alternate.
- Persist tmux sessions across reconnect.
