# RFC-010 — iOS app icon badge for sessions that need you

**Status:** Accepted
**Date:** 2026-09-02
**Branch:** nightly-maintenance-2026-09-02-rfc010-ios-app-icon-badge
**Severity:** P2 — phone already banners for approvals; the SpringBoard
icon never shows a count, so pending work is invisible once the banner
is gone.

---

## Problem

`NotificationService` already requests `[.alert, .sound, .badge]` and
the iOS `AppDelegate` presents banners with `.badge` in the options.
Nothing ever writes a badge number:

- `UNMutableNotificationContent.badge` is never set
- `UNUserNotificationCenter.setBadgeCount` is never called
- `applicationIconBadgeNumber` is unused

The phone *does* know how many sessions need the operator. `AppState.attentionSessions`
(awaiting approval or a question) drives the Sessions tab capsule and the
dashboard “needs your attention” inbox. That count never reaches the
home-screen icon, so ClankerSpanker looks idle when it is not.

## Non-goals

- APNs / remote push when the app is killed (badge stays at last known
  count until the next launch or a live WebSocket refresh).
- Wiring the unused `BGTaskScheduler` identifier
  `com.nightmoose.clankerspanker.refresh`.
- Badging idle “waiting on you” sessions (those fire a generic banner
  today but are not in `attentionSessions`).
- Linux Electron dock badge.
- Changing host APIs, auth, or the `x-grok-dispatch-token` header.

## Fix

Reuse `attentionSessions.count` as the icon badge. Same number as the
Sessions tab.

1. **`NotificationService.setAppIconBadge(_:)`** — absolute count via
   `UNUserNotificationCenter.setBadgeCount` (iOS 17 / macOS 14). `0`
   clears the mark.
2. **`AppState`** — after every `refreshSessions()` return (including
   empty-host), and on `clearConfiguration()`, set the badge to the
   current attention count. Optimistic bump when `approval.needed` /
   `question.needed` posts a local notification, so SpringBoard updates
   before the session list round-trip.
3. **Local notifications** — `notifyApproval` / `notifyQuestion` set
   `content.badge` to that count so the number still lands if the
   process is about to suspend. Generic `notify()` does not touch the
   badge.
4. **Notification actions** — Approve/Reject from a banner always
   `refreshSessions()` on success so the badge drops when the work is
   done, even if the WebSocket is down.
5. **Foreground** — iOS `MainTabView` refreshes sessions when
   `scenePhase` becomes `.active`.

Shared Swift sources mean the Mac Dock badge shows the same count. That
is intended, not a second product.

Without APNs the number is only as fresh as a running (or briefly
backgrounded) client. That matches today’s local-notification model.

## Testing

- [x] `make check` (host ratchet unchanged; Swift has no tests)
- [x] `xcodebuild` ClankerSpankerPhone (generic iOS Simulator)
- [x] Installed + launched on **Deez Nutz** (2026-09-02)
- [ ] iPhone: session hits approval → home-screen icon shows `1` (or N)
- [ ] Approve or answer in-app → badge drops; `0` removes it
- [ ] Approve from the notification action → badge drops after refresh
- [ ] Deny notification permission: app still runs; badge may stay at 0
- [ ] Mac: Dock badge matches pending approvals (shared path)

## Rollout

1. Rebuild the iPhone app (scheme **ClankerSpankerPhone**). Mac rebuild
   picks up the Dock badge from the same sources.
2. `make check`
3. `docs/STATUS.md` → Shipped on merge
4. Append `MAINTENANCE_LOG.md`

## Follow-ups

- APNs (or a host-side push) so a killed phone still badges.
- Implement the stub `BGTaskScheduler` refresh identifier.
- Optional: include idle “waiting on you” sessions in the count.
