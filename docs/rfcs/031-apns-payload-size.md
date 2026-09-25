# RFC-031 — Keep push notifications under the APNs size limit

**Status:** Accepted
**Date:** 2026-09-25
**Branch:** nightly-maintenance-2026-09-25-rfc031-apns-payload-size
**Severity:** P1

---

## Problem

`~/Library/Logs/clankerspanker-host.err.log` shows
`[push] delivery failed: … sandbox PayloadTooLarge`. `payloadFromEvent`
puts the approval's raw title (a whole shell command or diff) into the
alert, and `encodeApnsBody` sends it as-is. APNs rejects anything over
4096 bytes, so exactly the approvals that most need a look never reach the
phone.

## Non-goals

- Changing what the notification says (still title + first line).
- Rich notifications / notification service extension.

## Fix

`encodeApnsBody` clamps the title to 120 and the body to 400 code points
(ellipsis, never splitting a surrogate pair), then shrinks the body until
the encoded JSON is ≤ 4000 bytes. `data` (hostId, sessionId, kind,
approvalId) is untouched, so tapping still routes correctly.

## Testing

- [x] `apns.test.ts`: huge ASCII and multi-byte payloads fit; short payloads
      unchanged; `clampText` keeps emoji intact.
- [ ] Manual: trigger an approval with a long command → banner arrives on
      Deez Nutz.

## Rollout

1. `make check`; Install / update host.
2. `docs/STATUS.md` → Shipped; `MAINTENANCE_LOG.md`.
