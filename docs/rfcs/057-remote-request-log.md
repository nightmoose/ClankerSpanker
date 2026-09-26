# RFC-057 — Log what remote clients do

**Status:** Shipped
**Date:** 2026-09-26
**Branch:** nightly-maintenance-2026-09-25-rfc057-remote-request-log
**Severity:** P2 (diagnosability)

## Problem

The phone showed no sessions and no projects (FullScore) while the desktop
was fine. From the host everything checked out — `/profiles`, `/sessions`,
`/projects` 200 over Tailscale in < 1 s, payloads decode with the app's own
models, Tailscale path to the phone up — but the host log had no record of
whether the phone ever connected or what it got back.

## Fix

`host/src/request-log.ts` + `server.ts`: for requests from other machines
only, log

- the first request from an address after 5 min quiet (`[client] …`),
- every response ≥ 400 or slower than 3 s (`[client!] …`),
- rejected WebSocket upgrades.

Method, path (query string dropped — it may hold a legacy token), status,
ms, bytes. Loopback / this machine's own addresses are not logged.

## Testing

- [x] `request-log.test.ts` (4): arrival logged once while polling, again
      after quiet, failures/slow always, query string never logged,
      `::ffff:` stripped.
- [ ] Next phone launch: `grep '\[client' ~/Library/Logs/clankerspanker-host.log`.
