# Clients — ownership and parity

There is **one host gateway** (`host/`). Everything else is a **client** (and optionally a **local process manager** for that host). Do not invent a second gateway.

## Ownership (authoritative)

| Platform | Client | Location | Manages local host? |
|----------|--------|----------|---------------------|
| **macOS laptop** | **Native Swift** | `ios/GrokDispatch` → scheme `ClankerSpanker` → `ClankerSpankerMac.app` | Yes (`LocalHostController`, optional Application Support install + LaunchAgent) |
| **Linux laptop** | **Electron** | `desktop/` | Yes (`host-process.js`, reads/writes `~/.grok-dispatch`) |
| **Any OS browser** | Static UI | `host/web` served at `/app/` | No — host must already be running |
| **iPhone** | SwiftUI | same `ios/` sources, scheme **ClankerSpankerPhone** → **Deez Nutz** | No — remote host only |

**Do not** dual-maintain full session UIs on Mac in both Electron and Swift.  
**Mac = native. Linux = Electron.** Electron may *run* on macOS for debugging; shipping Mac UX is the native app.

## Shared contract (only)

| Concern | Shared location |
|---------|-----------------|
| REST + WebSocket API | `host/src/server.ts`, `shared/openapi.yaml` (if present) |
| Host config + token | `~/.grok-dispatch/config.json` |
| Session snapshots | `~/.grok-dispatch/sessions/` |
| Auth header | `Authorization: Bearer <hostToken>` (legacy wire header still accepted by host) |
| Default port | `8787` |

Client shells **must not** invent parallel config roots or alternate ports without migration.

## Feature parity (high level)

| Capability | Mac native | Electron (`desktop/`) | Browser `/app/` |
|------------|------------|------------------------|-----------------|
| Session list / detail / approvals / follow-up | Yes | Yes | Yes |
| Compose / dispatch | Yes | Yes | Yes |
| First-turn screenshot attach on New Session | Yes | Yes | No |
| Transcript Chat-only toggle | Yes | Yes | No |
| Notes Files list + view | Yes | Yes | No |
| Extra workspace folders (dispatch + mid-session) | Yes | Yes | No |
| Create / run hunter bots | Yes (⌘2) | Yes | No |
| Host terminal (login shell) | Yes (⌘⇧K) | Yes | `/app/terminal.html` |
| Tool-call ellipsis (rawInput / command) | Yes | Yes | No (browser session UI has no tool rows) |
| Grok / Claude disk attach | Yes (via host API; Grok subagent helpers omitted) | Yes | Yes |
| Multi-host registry | Yes | Remote mode + URL | URL in settings |
| Start/stop **local** host | Yes | Yes (managed mode) | No |
| Install host out of repo tree | Yes (App Support + LaunchAgent) | Yes (`~/.local/share/clankerspanker/host` + systemd user) | Scripts only |
| Menu bar / tray | Menu bar extra | System tray | No |
| OS notifications | UNUserNotification + host `notify-send` | Electron Notification + host | Host only |
| App icon / Dock badge | Yes — awaiting approval/question (iPhone SpringBoard + Mac Dock; same count as the Sessions tab) | No | n/a |
| Multi-folder project picker | Yes (Mac panel) | Host config JSON / UI | Host config only |

iPhone uses the same `ios/` sources as Mac. RFC-003 adds a **Bots** tab on the phone (create + Run now). RFC-010 badges the iPhone icon (and Mac Dock) with the number of sessions awaiting approval or a question. RFC-011 sends those badges/banners via **APNs** when the app is killed (host outbound to Apple). Setup: [APNS.md](APNS.md). Browser `/app/` still has no hunters UI.

Gaps are product work on the **owning** client for that platform, not a reason to fork the host.

## Host lifecycle (optional managers)

```
┌─────────────────┐     REST/WS      ┌──────────────────┐
│ Mac native app  │ ───────────────► │                  │
│ Electron app    │ ───────────────► │  host/ gateway   │
│ Browser         │ ───────────────► │  :8787           │
└────────┬────────┘                  └────────▲─────────┘
         │ spawn / launchd / systemd           │
         └─────────────────────────────────────┘
              (only when “managed” / local)
```

- **Standalone host** remains first-class: `cd host && npm start` or `./scripts/install-service.sh`.
- Desktop/Mac managers only **start/stop/install** the same `host` process and point the UI at it.

## Build notes

| Client | How |
|--------|-----|
| Host | `cd host && npm i && npm run build && npm start` |
| Electron (dev) | `cd desktop && npm i && npm start` (host must be built) |
| Electron Linux packages | **`npm run dist:linux` on a Linux machine** (or Linux CI). Cross-build from macOS is unreliable. |
| Mac app | `cd ios/GrokDispatch && ./run-mac.sh` or Xcode scheme **ClankerSpanker** → **My Mac** |
| iPhone | Scheme **ClankerSpankerPhone** → **Deez Nutz** (see § Phone deploy) |

Standalone host + agent CLI installs (all OSes): **[STANDALONE-INSTALLS.md](STANDALONE-INSTALLS.md)**.

## Phone deploy (always Deez Nutz)

The daily-driver iPhone is **Deez Nutz** (iPhone 13 Pro). **After any iOS
client change, install on that device.** Simulator is fine for a compile
check; it is not a ship. Do not install on **DaT OnE KiTtY** by accident
(same model, different phone).

```bash
cd ios/GrokDispatch
# Confirm the phone is paired:
xcrun devicectl list devices
# UDID (xcodebuild -destination id=) and CoreDevice identifier
# (devicectl --device) are different strings — copy both from the lists.

DD=/tmp/ClankerSpankerPhone-build
xcodebuild \
  -project ClankerSpanker.xcodeproj \
  -scheme ClankerSpankerPhone \
  -destination 'id=<UDID>' \
  -configuration Debug \
  -derivedDataPath "$DD" \
  -allowProvisioningUpdates \
  build

xcrun devicectl device install app --device '<COREDEVICE-ID>' \
  "$DD/Build/Products/Debug-iphoneos/ClankerSpankerPhone.app"
xcrun devicectl device process launch --device '<COREDEVICE-ID>' \
  com.nightmoose.clankerspanker
```

Last known ids (re-check if install fails): UDID
`00008110-001640DC3E9B801E`, CoreDevice
`C08299BA-E602-5C10-B12F-F3418B15C28B`. Phone must be unlocked and trusted.
Launch fails if SpringBoard is locked — install still counts; open the app
on the device.

iPad daily driver (when the work is iPad-only) is **Nomad**, not Deez Nutz.

## Naming (“desktop app”)

Avoid bare “desktop app” in docs. Prefer:

- **Mac app** / **ClankerSpankerMac**
- **Linux desktop** / **Electron client** (`desktop/`)
- **Browser control plane** (`/app/`)
