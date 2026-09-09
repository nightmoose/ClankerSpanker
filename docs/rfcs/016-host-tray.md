# RFC-016 — Standalone Mac host tray

**Status:** Draft
**Date:** 2026-09-09
**Branch:** nightly-maintenance-2026-09-09-rfc016-host-tray
**Severity:** P2

---

## Problem

Laptops that only host a gateway (no session UI) still need a place to:

- confirm the gateway is up,
- open the browser configurator at `/setup` / `/app/`,
- kickstart the LaunchAgent after a host update,
- find the on-disk log and config paths.

Today that only exists inside the ClankerSpanker Mac command-center app
(`MenuBarExtra` in `GrokDispatchApp.swift`), so a machine without that
app has no discoverable configuration surface — the user has to remember
the URL and the `launchctl` incantation. Meanwhile RFC-015 leaves the
Mac app's menu-bar item redundant with what a stand-alone tray would
own, and Alex has explicitly asked to not have two identical bolts in
the menu bar.

## Non-goals

- Building a second session UI. The tray is a *configurator*, not a
  client. Sessions/composer/profiles stay in the Mac command-center app
  and the phone/desktop clients (see `docs/CLIENTS.md`).
- Bundling a `.app` binary in the repo. The tray is built from source
  like the other Xcode targets; distribution is a follow-up.
- Reimplementing `HostInstaller`. The tray does not copy anything into
  Application Support. It kickstarts an existing LaunchAgent and points
  the user at the two install scripts.

## Fix

- New macOS Xcode target `ClankerSpankerHostTray`:
  - `LSUIElement = true` (menu-bar only, no Dock icon)
  - Bundle id `com.nightmoose.clankerspanker.hosttray`
  - Own scheme `ClankerSpankerHostTray` in the shared
    `ClankerSpanker.xcodeproj`
  - Sources live under `ios/GrokDispatch/HostTray/`
- Icon: `bolt.circle.fill` (same as the current MenuBarExtra so the
  visual identity is preserved).
- Menu contents:
  - Status line: `Gateway: Up · agent · pid X` or `Down`
  - `Open web UI` → `http://127.0.0.1:<port>/app/`
  - `Open setup` → `http://127.0.0.1:<port>/setup`
  - Divider
  - `Kickstart host` (calls `launchctl kickstart -k` on the loaded
    agent — `clankerspanker-host` first, else `grok-dispatch-host`)
  - `Reveal host log` (opens the LaunchAgent log in Console.app)
  - `Reveal config` (opens `~/.grok-dispatch/` in Finder)
  - Divider
  - `Quit tray`
- ClankerSpanker Mac command-center app drops its `MenuBarExtra`
  (`GrokDispatchApp.swift:64-67`) and its `MacMenuBarMenu` view. It
  also flips `applicationShouldTerminateAfterLastWindowClosed` to
  `true` — with no menu-bar refuge, closing all windows should quit
  the app cleanly. The Host panel subtitle "Close with Done — app
  stays in the menu bar" is removed.
- `HostTray/README.md` documents `xcodebuild -scheme
  ClankerSpankerHostTray build` and copying the built `.app` into
  `~/Applications`, with a note about setting it as a Login Item via
  System Settings.
- `docs/CLIENTS.md` gains a "Configurator" row calling out the tray
  as separate from the numbered clients.

Shared helpers (`LocalHostConfigFile.readBindPort` / `readToken` and
the `launchctl(_:)` helper) are duplicated into the tray target rather
than extracted into a new Swift package — the surface is ~30 lines and
the extraction is a bigger project than the tray itself.

## Testing

- [ ] `make check` (vitest baseline 198 unchanged; refactor is
      Swift + xcodegen only)
- [ ] `xcodebuild -scheme ClankerSpankerHostTray build` completes on
      Alex's Mac mini
- [ ] `xcodebuild -scheme ClankerSpanker build` still succeeds after
      the `MenuBarExtra` removal
- [ ] Manual soak:
  - Launch the built tray `.app`. Icon appears once in the menu bar.
    Status line shows "Up · <agent> · pid X".
  - "Open web UI" opens `/app/` in the default browser.
  - "Kickstart host" bounces launchd's node; status updates within
    a few seconds.
  - Launch the ClankerSpanker Mac app too. The Mac app no longer adds
    a second bolt to the menu bar.

## Rollout

1. Implement.
2. `xcodegen` to regenerate `ClankerSpanker.xcodeproj`.
3. `make check` + `xcodebuild` for both new schemes.
4. Update `docs/STATUS.md` → Accepted.
5. Append `MAINTENANCE_LOG.md`.
6. Follow-up (not in this RFC): notarized `.dmg` distribution.

## Follow-ups

- Notarized DMG or a `host/scripts/install-tray.sh` that copies a
  pre-built `.app` into `~/Applications` and registers a Login Item.
- Preferences window that wraps `/setup` in a `WKWebView`, so config
  works even when the default browser is on a different profile.
- Merge the two duplicated `LocalHostConfigFile` helpers into a small
  shared Swift package (`GrokDispatchHostShared`) once a third target
  needs them.
