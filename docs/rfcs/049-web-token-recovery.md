# RFC-049 — Browser client recovers from a rotated token

**Status:** Shipped
**Date:** 2026-09-25
**Branch:** nightly-maintenance-2026-09-25-rfc049-web-token-recovery
**Severity:** P2

## Problem

After the RFC-026 token rotation, `/app/` kept the old token in
localStorage and showed only "Unauthorized / OFFLINE" — its `/connect.json`
bootstrap runs only when no token is stored. Electron showed "HTTP 401".

## Fix

- Browser: on a 401 (once per request), if the UI is served by the host
  itself, fetch `/connect.json` (host-machine only, RFC-026), store the new
  token, reconnect the socket and retry. Single-flight, and success is
  judged against the token the failing request used, so parallel 401s don't
  race into an error. Otherwise: a message saying how to re-pair.
- Electron: a 401 says the token was rotated and where to paste the new one.

## Testing

- [x] Live: planted a stale token, reloaded → new token fetched, "live",
      49 sessions, no error banner (first two attempts showed the race; fixed).
