# RFC-028 — Listen on loopback + Tailscale, not every network

**Status:** Shipped
**Date:** 2026-09-25
**Branch:** nightly-maintenance-2026-09-25-rfc028-bind-loopback-tailscale
**Severity:** P0

---

## Problem

The host defaults to `bindHost: "0.0.0.0"` (`host/src/config.ts`,
`desktop/src/host-config-io.js`, `LocalHostController.swift`). It listens on
every interface over plain HTTP, including hotel / café Wi-Fi. The API can
start shell-capable agents and `/ws/terminal` is a shell, so on an untrusted
network the only barrier is a bearer token sent in cleartext. Tailscale
already encrypts and authenticates peers, and the owner's phone reaches the
host over Tailscale; the LAN listener adds exposure and no value.

## Non-goals

- TLS for the LAN listener (use Tailscale, or `tailscale serve`, instead).
- Changing an existing `config.json` automatically. Existing values are
  honored; the owner switches with one edit (below).

## Fix

- New `bindHost: "auto"` (`host/src/bind-addresses.ts`): listen on
  `127.0.0.1`, `::1`, and every Tailscale address (`100.64.0.0/10`,
  `fd7a:115c:a1e0::/48`). Re-scan every 30 s so Tailscale coming up after
  launchd (or re-addressing) is picked up; listeners for vanished addresses
  close.
- `bindHost` also accepts a comma-separated list. `"0.0.0.0"` / `"::"` still
  mean every interface, now with a startup warning pointing at `"auto"`.
- `startServer` creates one `http.Server` per address sharing the same
  request/upgrade handlers.
- New installs default to `"auto"` (host, Electron installer, Mac app).

## Testing

- [x] `bind-addresses.test.ts`: auto = loopback + Tailscale (not Wi-Fi, not
      non-Tailscale CGNAT); auto without Tailscale = loopback; wildcard and
      explicit lists honored; case-insensitive.
- [x] Manual: set `"bindHost": "auto"`, restart; `lsof -iTCP:8787` shows
      127.0.0.1, ::1 and 100.x only; `curl http://192.168.x.x:8787/health`
      refused; phone on Tailscale still connects.

## Rollout

1. `make check`; Install / update host.
2. Owner: set `"bindHost": "auto"` in `~/.grok-dispatch/config.json` and kick
   the LaunchAgent. Confirm the phone (Tailscale) still connects.
3. `docs/STATUS.md` → Shipped; `MAINTENANCE_LOG.md`.

## Follow-ups

- Optional HTTPS via `tailscale serve` documented in `docs/CLIENTS.md`.
