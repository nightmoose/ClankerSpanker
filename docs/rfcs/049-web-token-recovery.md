# RFC-049 — The on-host page recovers a rotated token

**Status:** Shipped
**Date:** 2026-09-25
**Branch:** main
**Severity:** P1

Document restored 2026-10-21. This number already belonged to the merged work below.
The design note was not in the tree. The number was not reassigned.

---

## Problem

Rotating the host token (delete `hostToken`, restart, the process mints a new
one) left the browser UI holding the old value. The next request failed with a
bare unauthorized error, and the page that is itself served by the host could
have read the new token.

## What shipped

When this UI is served by the host (`state.baseURL` is this page's origin) and a
request fails authorization, it fetches `/connect.json` once. That route is
host-machine only (RFC-026). If the token changed, the page stores it and
reconnects the socket. Parallel failures share one refresh.

The desktop shell reports the failure in words instead of a bare "Unauthorized"
(`desktop/renderer/api.js`). It does not read `/connect.json` from another machine.

## Testing

Manual: rotate the token, reload `http://127.0.0.1:8787/app/`, confirm the page
comes back without pasting the new token. There is no vitest for the browser
file yet.
