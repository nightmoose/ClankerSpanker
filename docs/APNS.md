# APNs — phone push from the host

The iPhone badge and approval banners only update locally while
ClankerSpanker is running. The **host** sends Apple Push so a killed
phone still sees work. Outbound HTTPS to Apple; port 8787 stays LAN /
Tailscale.

RFC: [rfcs/011-apns.md](rfcs/011-apns.md). Daily driver: **Deez Nutz**.

## Operator setup

1. Apple Developer → Keys → Apple Push Notifications service (Key). One
   key per team (`XHS7K665C9`) covers every Nightmoose bundle. Save the
   `.p8` **out of git**.

2. On the host machine:

   ```bash
   mkdir -p ~/.grok-dispatch/apns
   cp /path/to/AuthKey_XXXXXXXXXX.p8 ~/.grok-dispatch/apns/
   chmod 600 ~/.grok-dispatch/apns/AuthKey_XXXXXXXXXX.p8
   ```

3. Add to `~/.grok-dispatch/config.json` (do not put the PEM in git):

   ```json
   "apns": {
     "keyId": "XXXXXXXXXX",
     "teamId": "XHS7K665C9",
     "keyPath": "apns/AuthKey_XXXXXXXXXX.p8",
     "bundleId": "com.nightmoose.clankerspanker",
     "environment": "auto"
   }
   ```

   `keyPath` is relative to `dataDir` (`~/.grok-dispatch`) or absolute.
   `environment: auto` tries sandbox (Xcode Debug) then production.

4. Rebuild host and kick the **standalone repo** LaunchAgent
   (`com.nightmoose.grok-dispatch-host`). Do not copy into Application
   Support and do not load `com.nightmoose.clankerspanker-host`.

   ```bash
   cd ~/Projects/GrokDispatch/host && npm run build
   launchctl kickstart -k "gui/$(id -u)/com.nightmoose.grok-dispatch-host"
   ```

   Boot log should say `APNs: configured`, not `APNs not configured`.

5. Rebuild **ClankerSpankerPhone**, install on **Deez Nutz**, open the
   app once (token upload). Then kill it and trip an approval.

Env overrides if you would rather not touch `config.json`:
`APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_KEY_PATH` or `APNS_KEY_P8`,
`APNS_BUNDLE_ID`, `APNS_ENV` (`sandbox` / `production` / `auto`).

## API (host token)

| Method | Path | Body / result |
|---|---|---|
| POST | `/push/register` | `{ token, clientHostId, name? }` |
| DELETE | `/push/register` | `{ token }` |
| GET | `/push/status` | `{ configured, deviceCount, bundleId }` — no secrets |
| POST | `/push/test` | one alert to every registered device |

Device list: `~/.grok-dispatch/push-devices.json` (0600). Cap 20.

## What gets pushed

| Host event | Payload |
|---|---|
| `approval.needed` / `question.needed` | alert + sound + badge + action category |
| `approval.resolved` / `question.answered` | badge only (absolute attention count) |

Attention count matches the Sessions tab: `awaiting_approval` +
`awaiting_question`.

## Troubleshooting

- **No banner, app killed:** `GET /push/status` — `configured` must be
  true and `deviceCount` ≥ 1. Open the phone app once after install.
- **`InvalidProviderToken`:** key id / team id / PEM mismatch. Team is
  `XHS7K665C9`. Key file must be the `.p8` for that Key ID.
- **`BadDeviceToken`:** Debug build vs production environment. `auto`
  retries the other side. Confirm the phone scheme is
  `ClankerSpankerPhone` (development entitlement).
- **`Unregistered`:** token expired; reopen the app.
- Never commit `AuthKey_*.p8` or `APNS_KEY_P8`.
