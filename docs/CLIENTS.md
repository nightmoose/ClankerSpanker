# Clients — ownership and parity

There is **one host gateway** (`host/`). Everything else is a **client** (and optionally a **local process manager** for that host). Do not invent a second gateway.

## Ownership (authoritative)

| Platform | Client | Location | Manages local host? |
|----------|--------|----------|---------------------|
| **macOS laptop** | **Native Swift** | `ios/GrokDispatch` → scheme `ClankerSpanker` → `ClankerSpankerMac.app` | Yes (`LocalHostController`, optional Application Support install + LaunchAgent) |
| **Linux laptop** | **Electron** | `desktop/` | Yes (`host-process.js`, reads/writes `~/.grok-dispatch`) |
| **Any OS browser** | Static UI | `host/web` served at `/app/` | No — host must already be running |
| **iPhone** | SwiftUI | same `ios/` sources (phone scheme deferred) | No — remote host only |

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
| Grok / Claude disk attach | Yes (via host API) | Yes | Yes |
| Multi-host registry | Yes | Remote mode + URL | URL in settings |
| Start/stop **local** host | Yes | Yes (managed mode) | No |
| Install host out of repo tree | Yes (App Support + LaunchAgent) | Path override / sibling `host/` | systemd/launchd scripts on host |
| Menu bar / tray | Menu bar extra | System tray | No |
| OS notifications | UNUserNotification + host `notify-send` | Electron Notification + host | Host only |
| Multi-folder project picker | Yes (Mac panel) | Host config JSON / UI | Host config only |

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

## Naming (“desktop app”)

Avoid bare “desktop app” in docs. Prefer:

- **Mac app** / **ClankerSpankerMac**
- **Linux desktop** / **Electron client** (`desktop/`)
- **Browser control plane** (`/app/`)
