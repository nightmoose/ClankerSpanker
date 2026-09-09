# ClankerSpanker Host Tray

Menu-bar-only configurator for a Mac that hosts a ClankerSpanker
gateway but does not run the full `ClankerSpanker.app` command center.

Not a session client. See [`docs/CLIENTS.md`](../../../docs/CLIENTS.md).

## What it does

- Shows gateway status (`Up · <agent> · pid X` or `Down`).
- Opens the browser configurator at `/app/` and `/setup`.
- `Kickstart host` calls `launchctl kickstart -k` on whichever
  LaunchAgent is loaded — the app-managed
  `com.nightmoose.clankerspanker-host` first, then the repo-standalone
  `com.nightmoose.grok-dispatch-host`.
- Reveals the LaunchAgent log and `~/.grok-dispatch/` config folder.

## What it doesn't do

- No session UI (no chat, transcript, compose, profiles).
- No install. Install the host with either:
  - Repo: `./host/scripts/install-launchd.sh`
  - ClankerSpanker.app: Host → Install / update host

## Build

```bash
cd ios/GrokDispatch
xcodegen               # regenerate ClankerSpanker.xcodeproj
xcodebuild -project ClankerSpanker.xcodeproj \
  -scheme ClankerSpankerHostTray \
  -destination 'platform=macOS' \
  build
```

Copy the built `.app` from `~/Library/Developer/Xcode/DerivedData/…/Build/Products/Debug/`
to `~/Applications`, then add it to **System Settings → General → Login
Items** so the icon comes up at login.
