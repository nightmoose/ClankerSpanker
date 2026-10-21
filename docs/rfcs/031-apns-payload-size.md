# RFC-031 — Keep push payloads under the APNs limit

**Status:** Shipped
**Date:** 2026-09-25
**Branch:** main
**Severity:** P1

Document restored 2026-10-21. This number already belonged to the merged work below.
The design note was not in the tree. The number was not reassigned.

---

## Problem

An approval title can be a whole shell command or a diff. Apple drops a push
whose payload is over the size limit, so the phone that most needs the banner
never gets it.

## What shipped

`encodeApnsBody` in `host/src/notify/apns.ts` trims the alert until the encoded
body fits. The send path from RFC-011 is unchanged aside from that cap.

## Testing

- `host/src/notify/apns.test.ts` (`encodeApnsBody payload size`)
