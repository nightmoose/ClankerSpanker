# RFC-029 — WebSocket tickets

**Status:** Shipped
**Date:** 2026-09-25
**Branch:** main
**Severity:** P1

Document restored 2026-10-21. This number already belonged to the merged work below.
The design note was not in the tree. The number was not reassigned.

---

## Problem

The live event socket took the long-lived host token in the query string.
Query strings land in logs, crash reports, and browser history.

## What shipped

`POST /ws/ticket` exchanges the bearer token for a single-use ticket that lasts
30 seconds (`host/src/ws-tickets.ts`). The WebSocket upgrade accepts, in order:

1. an `Authorization` header
2. `?ticket=` from that endpoint
3. `?token=` only when the peer is the host machine itself

Clients trade the token for a ticket before connecting (`host/web/app.js`,
`desktop/src/host-ws.js`, `WebSocketClient.swift`).

## Testing

- `host/src/ws-tickets.test.ts`
- `host/src/ws-upgrade-auth.test.ts`
