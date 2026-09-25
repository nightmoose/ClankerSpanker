# RFC-029 — WebSocket tickets: the host token leaves the URL

**Status:** Shipped
**Date:** 2026-09-25
**Branch:** nightly-maintenance-2026-09-25-rfc029-ws-tickets
**Severity:** P1

---

## Problem

Every client opened `/ws` and `/ws/terminal` with `?token=<hostToken>`
(`host/web/app.js`, `host/web/terminal.html`, `desktop/src/host-ws.js`,
`WebSocketClient.swift`). A long-lived credential in a URL ends up in
proxy / server logs, browser history, crash reports and screenshots. The
terminal socket is a full shell, so leaking it is leaking the machine.

## Non-goals

- Replacing the host token with per-device credentials.
- TLS (Tailscale provides transport encryption; RFC-028).

## Fix

- `POST /ws/ticket` (bearer auth) returns `{ ticket, expiresInMs }`: 24
  random bytes, single use, 30 s TTL, in memory (`host/src/ws-tickets.ts`).
- `wsUpgradeAuthorized` (both sockets): accept the auth header; else a
  ticket (consumed); else legacy `?token=` **only from this machine** so
  old local builds keep working. A network peer can no longer use `?token=`.
- Clients: browser `/app/` and `terminal.html` (web, Electron-embedded and
  the phone's WKWebView terminal) fetch a ticket first; Electron main
  process fetches a ticket (stale awaits are dropped); iOS/Mac
  `WebSocketClient` sends `Authorization: Bearer` on the upgrade request.

## Testing

- [x] `ws-tickets.test.ts`: single use, expiry, unknown/empty, pruning,
      distinct tickets.
- [x] `ws-upgrade-auth.test.ts`: header from anywhere; ticket once; legacy
      token refused from network, accepted from loopback; wrong/none refused;
      empty configured token authorises nobody.
- [x] Manual: browser `/app/` shows Live; Terminal tab opens a shell; phone
      shows Live and the Term tab works over Tailscale.

## Rollout

1. `make check`; Install / update host.
2. Rebuild Mac + phone (Deez Nutz). An old phone build over Tailscale will
   show Offline until updated — that is the point.
3. `docs/STATUS.md` → Shipped; `MAINTENANCE_LOG.md`.
