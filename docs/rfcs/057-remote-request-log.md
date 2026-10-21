# RFC-057 — Log what a remote client actually did

**Status:** Shipped
**Date:** 2026-09-26
**Branch:** main
**Severity:** P1

Document restored 2026-10-21. This number already belonged to the merged work below.
The design note was not in the tree. The number was not reassigned.

---

## Problem

A phone showed no sessions and no projects while the host looked healthy from
the Mac sitting in front of it. Nothing in the log said whether the phone's
packets had arrived.

## What shipped

`host/src/request-log.ts` records requests that are not from this machine:

- the first request from an address after it has been quiet (`QUIET_MS`, five minutes)
- every response at status 400 or above
- every request slower than `SLOW_MS` (three seconds)

The line includes the path and not the query string, because a legacy socket
URL can still carry a token (RFC-029).

## Testing

- `host/src/request-log.test.ts`
