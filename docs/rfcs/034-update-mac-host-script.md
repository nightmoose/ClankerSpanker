# RFC-034 — One-command host update for a Mac: `scripts/update-mac-host.sh`

**Status:** Shipped
**Date:** 2026-09-25
**Branch:** nightly-maintenance-2026-09-25-rfc034-update-mac-host-script
**Severity:** P0 (second host still leaks its token)

---

## Problem

The second host ("Astrodata", `alexs-macbook-pro`, 100.66.166.28) runs a
pre-RFC-026 host: `GET /connect.json` over Tailscale returned **200** on
2026-09-25, i.e. its token is served to any peer, and it binds 0.0.0.0.
Its Mac app predates RFC-027, so **Install / update host** there can
delete its own install. There is no safe, repeatable way to update a Mac
host from a checkout, and SSH to that machine is closed.

## Non-goals

- Linux hosts (Electron installer / `install-systemd-user.sh`).
- Remote updates.

## Fix

`scripts/update-mac-host.sh [--bind-auto] [--rotate-token] [--no-pull]`:
detect the install style (Mac app LaunchAgent + Application Support copy,
or standalone checkout LaunchAgent), `git pull --ff-only`, build, rsync
into the install root and `npm install --omit=dev` (app style), optionally
set `bindHost: "auto"` and/or drop `hostToken` (backup first, 0600), kick
the LaunchAgent, wait for `/health`, print listeners and pairing steps.

## Testing

- [x] This Mac: `--no-pull` → app style detected, deployed, restarted,
      listeners loopback + Tailscale.
- [x] Config step on a scratch file: `0.0.0.0 → auto`, token removed,
      result 0600.
- [ ] Astrodata: run with `--bind-auto --rotate-token`; from this Mac
      `GET http://100.66.166.28:8787/connect.json` → 403.

## Rollout

Owner runs it on Astrodata; then re-pair the phone from Astrodata's `/setup`.
