# RFC-024 — One phone, more than one host

**Status:** Shipped
**Date:** 2026-09-21
**Branch:** main
**Severity:** P1

Document restored 2026-10-21. This number already belonged to the merged work below.
The design note was not in the tree. The number was not reassigned.

---

## Problem

The phone kept a single WebSocket and treated every session as belonging to the
selected host. A second host's sessions disappeared from the list, its events
were dropped, and an approval tap could be sent to the wrong machine.

## What shipped

Each saved host gets its own socket. Sessions, bots, and tasks carry the host
that returned them. Lists fan out across every configured host. Notification
actions route by the embedded host id.

- `ios/ClankerSpanker/ClankerSpanker/Services/HostSocketPool.swift`
- `ios/ClankerSpanker/ClankerSpanker/ViewModels/AppState.swift`
- `GET /host/self` returns a stable `hostId` minted on first boot
  (`host/src/config.ts`).

RFC-025 is the same shape for the Electron desktop app. This RFC is the phone
and the host identity those clients share.

## Testing

- `host/src/config.test.ts` (a config from before this RFC has no `hostId`)
- Swift host-endpoint tests under `ios/ClankerSpanker/Tests/`
