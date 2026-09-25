# RFC-035 — iPhone opens sessions on their own host (list rows + notification tap)

**Status:** Shipped
**Date:** 2026-09-25
**Branch:** nightly-maintenance-2026-09-25-rfc035-phone-cross-host-open
**Severity:** P1

---

## Problem

First two-host soak (Primary + Astrodata, 2026-09-25): with the phone
focused on Astrodata, an approval on Primary pushed correctly, but opening
the session gave **404**.

- `DashboardView` built every row's `SessionRoute` with
  `appState.selectedHost?.id` (attention section and main list), and
  `ProjectsView.sessionRow` did the same — RFC-024 moved the Mac to
  `endpoint(for:)` but missed these iPhone paths.
- A plain tap on a notification only refreshed the list; it never opened
  the session. Only the Approve/Reject action buttons did anything.

## Fix

- Rows route with `appState.endpoint(for: session)` (the session's own host).
- `handleNotificationAction`: default tap sets `AppState.notificationRoute`
  (host from the push's `hostId`) and switches to Sessions; `DashboardView`
  consumes it into its existing `pendingRoute`.

## Testing

- [x] Manual, Deez Nutz: focused on Astrodata, Primary approval → tap banner
      → session opens on Primary with the RFC-033 diff → Approve on phone →
      edit landed on Primary.
- Swift has no test target yet (known gap).
