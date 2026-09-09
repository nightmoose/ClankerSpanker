# RFC-011 — APNs so a killed iPhone still badges

**Status:** Accepted
**Date:** 2026-09-02
**Branch:** nightly-maintenance-2026-09-02-rfc011-apns
**Severity:** P1 — RFC-010 only updates the icon while the app (or its
WebSocket) is alive. Ignore an approval with the app closed and the
phone looks idle.

---

## Problem

RFC-010 writes `attentionSessions.count` onto the SpringBoard badge via
local `UNUserNotification` + `setBadgeCount`. That path requires a
running client. The host already emits `approval.needed` /
`question.needed` over `/ws` and can `notify-send` on the Mac. None of
that reaches a killed iPhone.

Confirmed on Deez Nutz: the badge/banner only appears if the app is
open (or was open long enough to see the event).

## Non-goals

- Android / FCM.
- Linux Electron dock badge.
- Waking the app with `content-available` / `UIBackgroundModes`
  `remote-notification` (badge-only and alert payloads are enough).
- Implementing the stub `BGTaskScheduler` refresh identifier.
- Badging idle “waiting on you” sessions.
- Putting the `.p8` in git. Key lives under `~/.grok-dispatch/apns/`.

## Fix

Outbound APNs from the **existing host** (LAN/Tailscale, no inbound).
Same HTTP/2 + ES256 JWT pattern as NightMoose Dirt Work.

1. **Config** (`~/.grok-dispatch/config.json`, not returned to clients):

   ```json
   "apns": {
     "keyId": "10CHARKEYID",
     "teamId": "XHS7K665C9",
     "keyPath": "apns/AuthKey_….p8",
     "bundleId": "com.nightmoose.clankerspanker",
     "environment": "auto"
   }
   ```

   `environment: auto` tries sandbox first (Xcode Debug sideload), then
   production on `BadDeviceToken`. Env overrides: `APNS_KEY_ID`,
   `APNS_TEAM_ID`, `APNS_KEY_P8` / `APNS_KEY_PATH`, `APNS_BUNDLE_ID`,
   `APNS_ENV`. Missing config ⇒ no-op (today’s local-only behavior).

2. **Device register** (host token required):

   - `POST /push/register` `{ token, clientHostId, name? }`
   - `DELETE /push/register` `{ token }`
   - `GET /push/status` `{ configured, deviceCount, bundleId }`
   - `POST /push/test` sends a one-shot alert to registered devices

   Tokens in `{dataDir}/push-devices.json` (0600). Cap 20. Echo
   `clientHostId` in the payload so Approve/Reject on a cold start still
   finds the right `HostEndpoint` UUID on that phone.

3. **Send** on SessionManager `event`:

   | Event | APNs |
   |---|---|
   | `approval.needed` / `question.needed` | alert + sound + badge + category |
   | `approval.resolved` / `question.answered` | badge only (absolute attention count) |

   Badge = sessions with status `awaiting_approval` or
   `awaiting_question` (including archived-but-still-pending), same as
   the Sessions tab. Drop `Unregistered` / `BadDeviceToken` after both
   environments fail.

4. **iPhone** — Push capability (`aps-environment` development on
   Debug, production on Release). After notification permission,
   `registerForRemoteNotifications`, hex-encode the token, POST it to
   every configured host. Foreground remote pushes present **badge
   only** so they do not double the WebSocket local banner. Categories
   stay `APPROVAL_REQUEST` / `QUESTION_REQUEST`.

Shared Swift sources: Mac does **not** register for remote push.

## Testing

- [x] vitest: key normalize, JOSE sig, device store, payload, skip when unconfigured
- [ ] `make check` (ratchet 165 → 184)
- [ ] Deez Nutz: kill the app, trip an approval, banner + badge without opening
- [ ] Approve from the banner (or in-app) → badge drops
- [ ] `POST /push/test` while the app is killed

## Rollout

1. Drop the `.p8` at `~/.grok-dispatch/apns/` (0600); set `apns` in config.
2. Rebuild host (`npm run build`) and kick
   `com.nightmoose.grok-dispatch-host`.
3. Rebuild **ClankerSpankerPhone** and install on **Deez Nutz**. Open
   once so the token registers.
4. `make check`
5. `docs/STATUS.md` → Shipped on merge
6. Append `MAINTENANCE_LOG.md`

## Follow-ups

- TestFlight / production entitlement soak.
- `BGTaskScheduler` as a belt if APNs is delayed.
- Optional: include idle “waiting on you” sessions in the count.
