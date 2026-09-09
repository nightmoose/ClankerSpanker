# RFC-015 — Detach the Mac app from the host process

**Status:** Draft
**Date:** 2026-09-09
**Branch:** nightly-maintenance-2026-09-09-rfc015-host-detach
**Severity:** P1

---

## Problem

`LocalHostController.start()` on macOS spawned `node dist/index.js` as a
child of the Mac app via `Process()`. When the Mac app quit (Cmd-Q,
crash, upgrade, sign-out), the child was reaped and the gateway died —
even though a LaunchAgent may already have been managing the host. The
`applicationShouldTerminateAfterLastWindowClosed → false` shim only kept
the app alive when the window was closed; a real quit still tore down
the process tree.

RFC-010/011 (APNs) leaned on this by rsync-ing into
`~/Library/Application Support/ClankerSpanker/host` and pointing docs at
the `com.nightmoose.clankerspanker-host` LaunchAgent — which competes on
port 8787 with the long-standing repo agent
`com.nightmoose.grok-dispatch-host` from
`host/scripts/install-launchd.sh`. Two agents on one port is not a
supported shape.

Impact: killing/quitting the Mac app took the gateway down with it,
which drops iPhone WebSocket sessions, freezes idle timers, and delays
APNs delivery.

## Non-goals

- Rewriting `HostInstaller` from scratch. The Application Support flow
  is kept; only its guards and side effects change.
- Removing either LaunchAgent. Both `com.nightmoose.clankerspanker-host`
  and `com.nightmoose.grok-dispatch-host` remain first-class install
  targets — the app just no longer runs node in-process.
- Node child-process management (logs, restarts, PID tracking). All
  that responsibility moves to launchd.

## Fix

- `LocalHostController.start()`: drop the `Process()` spawn entirely. On
  invocation, `launchctl kickstart -k gui/{uid}/{label}` — trying the
  app-managed agent (`clankerspanker-host`) first, then the repo agent
  (`grok-dispatch-host`). If neither is loaded, surface an actionable
  error pointing at Host → Install and `./host/scripts/install-launchd.sh`.
- Rip dead bookkeeping: `process`, `pid`, `isRunning`, the process
  branch of `stop()`, the `Owned by this app` status label, and the
  `Self.findNode()` helper. `stop()` becomes an informational nudge.
- `HostInstaller.installLaunchAgent`: replace the hard error when the
  repo agent is loaded with an opt-in `takeoverStandalone` parameter.
  When true, `bootout` the repo agent before bootstrapping the
  app-managed one so the port hand-off is atomic.
- `MacHostPanel`: guard the Install button with an `.alert` confirm
  when the repo agent is loaded ("This will replace your repo-standalone
  host at ~/Projects/GrokDispatch/host with the Application Support
  copy"). Remove the dead "Stop (app-owned)" button; simplify the Start
  button so it always kickstarts whichever agent is loaded. Update the
  logs card title to point at the launchd log paths.
- `SettingsView` (macOS local host row): drop the Start/Stop process
  buttons and the "Sandbox is off so the app can manage a local
  gateway" copy. Show LaunchAgent status instead.
- Menu commands (`GrokDispatchApp`): drop "Stop local host" from the
  Host command menu and "Stop app-owned host" from the MenuBarExtra.
- `docs/APNS.md`: reflect that the standalone repo agent is the
  daily-driver bounce target.

## Testing

- [ ] `make check` (vitest baseline 198 unchanged; refactor is
      Swift-only, no host code touched)
- [ ] Manual soak on the Mac:
  - Quit Mac app (Cmd-Q). `lsof -nP -iTCP:8787 -sTCP:LISTEN` still
    reports the launchd node. iPhone stays connected.
  - Menu → Host → "Start local host" with API down: node comes back
    via `launchctl kickstart -k`.
  - Host panel → Install / update host while the repo agent is loaded:
    confirmation alert appears; accepting boots the repo agent out and
    installs the Application Support one; declining does nothing.

## Rollout

1. Implement.
2. `make check`
3. Update `docs/STATUS.md` → Accepted (Shipped after merge to main).
4. Append `MAINTENANCE_LOG.md`.

## Follow-ups

- Delete `~/Library/LaunchAgents/com.nightmoose.clankerspanker-host.plist`
  and `~/Library/Application Support/ClankerSpanker/host/` on Alex's
  machine (local cleanup, not a code change).
- Consider consolidating on one LaunchAgent label in a future RFC once
  both install paths are exercised in the wild.
