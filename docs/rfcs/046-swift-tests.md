# RFC-046 — First Swift unit tests (`make test-swift`)

**Status:** Shipped
**Date:** 2026-09-25
**Branch:** nightly-maintenance-2026-09-25-rfc046-swift-tests
**Severity:** P2

## Problem

The Swift clients had no tests. Today's changes put real logic there
(QR re-pair host matching, live list status, new optional wire fields), and
a regression would only show up on a phone.

## Fix

- `ClankerSpankerMacTests` (macOS unit-test bundle, hosted by the Mac app so
  `@testable import ClankerSpankerMac` works), added to the `ClankerSpanker`
  scheme's test action via `project.yml`.
- Pure logic lifted out of `AppState`: `liveStatus(forEvent:payload:)`
  (RFC-038) and `existingHost(matching:in:)` (RFC-026), both `nonisolated`.
- 11 tests: host URL normalization / `endpointKey`; configure-link matching;
  event → status mapping; decoding of `SessionStatus` (unknown), approval
  `preview`, tool `outputPreview`/`exitCode`, profile `autoApprovesTools`
  (present and absent); onboarding defaults carry no LAN IP.
- `make test-swift`. Not part of `make check` (CI is Linux).

## Testing

- [x] `make test-swift` → 11 passed. Phone target still builds.
