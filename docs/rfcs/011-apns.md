# RFC-011 — Push to a phone that is not running

**Status:** Shipped
**Date:** 2026-09-09
**Branch:** main
**Severity:** P1

Document restored 2026-10-21. This number already belonged to the merged work below
(landed with RFC-010). The design note was not in the tree. The number was not reassigned.

---

## Problem

The iPhone badge and approval banners only moved while ClankerSpanker was in the
foreground. A killed phone never learned that a session needed a person.

## What shipped

The host sends Apple Push itself. Outbound HTTPS goes to Apple. Port 8787 stays on
loopback and Tailscale.

- `host/src/notify/apns.ts` signs and sends the notification.
- `host/src/notify/push.ts` and `push-devices.ts` register device tokens.
- Operator setup (key id, team id, `.p8` path, bundle id) is `docs/APNS.md`.
  The key file stays out of git.

RFC-010 is the icon badge. RFC-031 caps the payload size. This RFC is the send path.

## Testing

- `host/src/notify/apns.test.ts`
- `host/src/notify/push.test.ts`
- `host/src/notify/push-devices.test.ts`
- A physical iPhone. The simulator does not receive push.
