# RFC-044 — OpenAPI contract test: spec and router can't drift

**Status:** Shipped
**Date:** 2026-09-25
**Branch:** nightly-maintenance-2026-09-25-rfc044-openapi-contract
**Severity:** P2

## Problem

HOUSE-STYLE says "keep `shared/openapi.yaml` in the same change", but nothing
checked it: 34 of 61 routes in `server.ts` were undocumented (projects CRUD,
profiles, attach, archive/close/transfer/review, tasks, notes, internal
Claude hook, setup/connect.json).

## Fix

- `host/src/openapi-contract.test.ts` reads `server.ts` (`method === "X" &&
  path === "/p"`, `/^…$/.exec(path)` and `path.match(/^…$/)` matchers) and
  the spec; fails on routes missing from the spec and spec entries with no
  route. Static UI and WebSocket paths are an explicit allowlist.
- Spec: 34 routes added (methods merged into existing path keys).

## Testing

- [x] Contract test green; extractor sanity check (> 50 routes).
- [x] No duplicate path keys / methods in the spec.

## Follow-up

A table-driven router (see the session-manager/server split) would let the
test read routes from data instead of source text.
