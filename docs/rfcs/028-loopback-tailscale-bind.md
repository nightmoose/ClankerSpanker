# RFC-028 — Listen on loopback and Tailscale

**Status:** Shipped
**Date:** 2026-09-25
**Branch:** main
**Severity:** P1

Document restored 2026-10-21. This number already belonged to the merged work below.
The design note was not in the tree. The number was not reassigned.

---

## Problem

The gateway listened on every interface. A laptop on public Wi-Fi exposed port
8787 to that network.

## What shipped

`bindHost` in `config.json`:

| Value | Listens on |
|---|---|
| `"auto"` (default for a new install) | `127.0.0.1`, `::1`, and this machine's Tailscale addresses |
| `"0.0.0.0"` or `"::"` | Every interface. The process logs a warning. |
| a comma-separated list | Exactly those addresses |

Tailscale addresses are re-checked on a short interval. `host/src/bind-addresses.ts`
resolves the list. `host/src/server.ts` opens one listener per address.

## Testing

- `host/src/bind-addresses.test.ts`
