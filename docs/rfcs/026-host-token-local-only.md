# RFC-026 — The host token stays on the host machine

**Status:** Shipped
**Date:** 2026-09-25
**Branch:** main
**Severity:** P0

Document restored 2026-10-21. This number already belonged to the merged work below.
The design note was not in the tree. The number was not reassigned.

---

## Problem

`config.json` holds the host token and profile secrets. Before this change a
missing token was replaced on every boot, so paired phones were stranded, and
`/setup` plus `/connect.json` would hand that token to a browser that was not
on the host machine.

## What shipped

- `config.json` is written mode `0600` and the token is kept once minted
  (`host/src/config.ts`, `host/src/config-perms.test.ts`).
- `GET /`, `GET /setup`, and `GET /connect.json` answer only a client on this
  machine, addressed by one of this machine's own names, with no cross-site
  `Origin`. They send no CORS headers (`host/src/server.ts`, `host/src/trusted-local.ts`).
- Phones pair by scanning the QR code. They do not receive the token from a
  page loaded on another computer.

RFC-029 is the WebSocket ticket that keeps the same token out of the socket URL.
RFC-049 is how the on-host browser page recovers after a rotation.

## Testing

- `host/src/config-perms.test.ts`
- `host/src/trusted-local.test.ts`
- `host/src/local-machine.test.ts`
