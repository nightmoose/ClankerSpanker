# RFC-043 — Onboarding does not embed a LAN address

**Status:** Shipped
**Date:** 2026-09-25
**Branch:** main
**Severity:** P1

Document restored 2026-10-21. This number already belonged to the merged work below.
The design note was not in the tree. The number was not reassigned.

---

## Problem

The phone's first-run screen shipped with a hardcoded LAN address. That address
was one person's network, it rotted, and it taught the app to skip the QR pairing
flow from RFC-026 and RFC-028.

## What shipped

`ConnectionDefaults.swift` has no machine address. Onboarding tells the person to
scan the QR code on the host's `/setup` page. The house-style gate rejects a new
`192.168.*` literal outside `host/src/platform.ts`, which is the private-range
check and not a client default.

## Testing

- `scripts/house-style-check.py` (new LAN literals)
- `ios/ClankerSpanker/Tests/HostEndpointTests.swift`
