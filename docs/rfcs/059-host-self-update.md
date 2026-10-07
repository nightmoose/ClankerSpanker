# RFC-059 — Host updates itself from the git checkout

**Status:** Accepted
**Date:** 2026-10-06
**Branch:** nightly-maintenance-2026-10-02-rfc058-inline-exec
**Severity:** P1

---

## Problem

A running host is a copy under Application Support (or an XDG dir), not
the git checkout. Getting a fix onto a second machine means sitting there
and running Install / update, or `scripts/update-mac-host.sh`. SSH to the
other Mac is closed (RFC-034). Hosts go stale.

## Non-goals

- Discarding local edits, `reset --hard`, or switching branches.
- Updating a host that has no checkout on disk.
- Electron Host panel button (the HTTP API is enough for a follow-up).
- Signing or shipping release artifacts. The source of truth stays the git remote.

## Fix

The host finds a checkout (`repoDir` in config, else `GROK_DISPATCH_REPO`,
else `~/Projects/GrokDispatch`, else walk up from the process). Every 30
minutes, and on `GET /host/update?fetch=1`, it `git fetch`es and reports
how the current branch compares to its upstream.

`POST /host/update` is allowed only when that comparison is a clean
fast-forward (`canApply`). A detached script then `git pull --ff-only`,
builds `host/`, rsyncs into the install root when this process is the
copied host, and kickstarts the LaunchAgent or systemd user unit. The
script sleeps a second first so the HTTP response gets out. Log:
`~/.grok-dispatch/self-update.log`.

`autoUpdate: true` (or `GROK_DISPATCH_AUTO_UPDATE=1`) applies that same
fast-forward on the timer when no session is queued, running, or waiting
on a person. Default is off.

The button ships with the host. On the host machine, open
`http://localhost:8787/setup` — **Update from repo** is on that page.
The browser UI (`/app/`, header **Update**) has the same card. Those
pages are what a machine has when only the host is installed. The
ClankerSpanker app’s Settings and Mac Host panel have the same call,
but that app is often not installed.

## Testing

- [x] vitest: dirty / diverged / behind classification, real clone is
      behind after a remote commit, controller spawns only when `canApply`,
      a second spawn is refused while the first is still running and allowed
      once it has exited, script contains `git pull --ff-only` and not
      `reset --hard`, and takes its lock before sleeping.
- [x] Manual: `GET /host/update?fetch=1` on a host that has this build
      returned `behind` / `canApply`. `POST` fast-forwarded a clean checkout,
      rebuilt `host/`, restarted that process, and the next check was
      `current`. Scratch host on port 8797 only. The mini's LaunchAgent
      was not restarted. The mini's own checkout is still dirty and has no
      upstream, so it still refuses to apply.

## Rollout

1. One install of this build per machine (the checker is not on older hosts).
2. After that, Settings → Update from repo, or `"autoUpdate": true` in that
   machine's `config.json`.
3. `make check` when the branch is ready. `docs/STATUS.md`, this log.

## Follow-ups

- Electron Host panel button.
- A configured branch (always track `main`) instead of the checkout's current upstream.
