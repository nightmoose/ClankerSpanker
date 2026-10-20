# RFC-064 — Mac Host panel: no subprocess on the main thread; recover an interrupted LaunchAgent load

**Status:** Draft
**Date:** 2026-10-19
**Branch:** rfc-064-mac-host-panel-async-status
**Severity:** P1

---

## Problem

On 2026-10-19 at 14:00, **Install / update host** in the Mac Host panel
crashed the app (EXC_BAD_ACCESS / SIGSEGV at 0x0). The crashing thread:

```
UpdateCycle  UC::DriverCore::continueProcessing()
CoreFoundation __CFRunLoopDoObservers
Foundation   -[NSConcreteTask waitUntilExit]
             HostInstaller.launchAgentLoaded.getter   HostInstaller.swift:28
             MacHostPanel.installCard.getter           MacHostPanel.swift:82
             MacHostPanel.body.getter
SwiftUICore  ViewBodyAccessor.updateBody …  NSHostingView.layout()
```

Two things combined:

1. `HostInstaller.install` was `@MainActor` and synchronous. It ran
   `npm install`, `npm run build` and `launchctl` on the main thread. Each one
   called `Process.waitUntilExit`, which spins the run loop. While the run
   loop spun, the install log grew, so SwiftUI re-rendered the panel.
2. `MacHostPanel.installCard` read `HostInstaller.launchAgentLoaded`, a
   computed property that ran `launchctl print` and waited for it inside
   the SwiftUI body. That nested `waitUntilExit` spun the run loop again from
   inside a SwiftUI update, which re-entered SwiftUI's update cycle and crashed.

The crash came after `launchctl bootout` and the plist rewrite, but before
`launchctl bootstrap`. The gateway stayed unloaded. Every client showed no
sessions until someone ran `launchctl bootstrap` by hand. Nothing loaded the
plist again until the next login.

`LocalHostController.start()` (Kickstart, from the Host menu, Settings and
the panel) also ran `launchctl kickstart` synchronously on the main thread.

## Non-goals

- The Host Tray target (`HostTray/`). It has its own `launchctl` wrapper and
  is a follow-up.
- The Linux/Electron installer.
- Changing what the installer installs, or the RFC-063 stage-and-swap.

## Fix

`ios/ClankerSpanker/ClankerSpanker/Services/HostInstaller.swift`:

- `HostServiceStatus` (struct): `packageInstalled`, `plistPresent`,
  `appAgentLoaded`, `standaloneAgentLoaded`. `probe(...)` builds one. It
  checks the disk and runs `launchctl print` through an injectable `isLoaded`,
  and must run off the main thread. `recovery` is `.loadAppAgent` only when
  the package and plist are on disk, our agent is not loaded, and the
  repo-standalone agent (same port) is not loaded either.
- `launchAgentLoaded` and `isInstalled` are gone. Views read
  `LocalHostController.service` instead.
- Every function that runs a subprocess is `nonisolated` and synchronous, and
  public callers reach it through `async` wrappers (`install`,
  `loadLaunchAgent`, `loadExistingLaunchAgent`, `unloadLaunchAgent`,
  `uninstall`). The wrappers run the work on a global queue (`offMain`).
  `install` still reads and saves the source path on the main actor.
- `installLaunchAgent` writes the new plist before unloading anything, then
  calls `bootstrapAgent`. That function runs `bootout`, waits until
  `launchctl print` no longer finds the old job (polling every 0.5 s, up to
  30 s), then runs `bootstrap`, `enable` and `kickstart`. `bootstrap` is
  retried up to 10 times, 1 s apart. `bootout` returns before launchd
  finishes removing the job, and the gateway shuts down gracefully on SIGTERM,
  so a `bootstrap` sent too early fails with "Input/output error". If the
  plist is missing, `bootstrapAgent` throws without booting anything out.

  Follow-up, 2026-10-20: the first version retried `bootstrap` 5 times, 0.4 s
  apart, with no wait. On the owner's Mac that gave up before the old gateway
  had exited. The install finished on disk, but the LaunchAgent was left
  unloaded until it was bootstrapped by hand. That is why the wait was added.

`ios/ClankerSpanker/ClankerSpanker/Services/LocalHostController.swift`:

- `@Published service: HostServiceStatus?`, filled by `refreshStatus` (on
  appear, the 4 s health poll, after each install step, and the panel's
  Refresh button). `loadedAgentLabel` now comes from it.
- `recoverLaunchAgentIfNeeded()` runs once per app launch. If `recovery` is
  `.loadAppAgent`, it bootstraps the plist already on disk, which is what
  launchd would do at the next login anyway. It does not run on every health
  poll, because during an install the agent is briefly unloaded on purpose.
  It skips when `serviceChangeInProgress` is set by the panel, and under
  XCTest (the test bundle is hosted by the app).
- `launchctl(_:)` is `nonisolated` and documented as never-on-main.
  `launchctlAsync(_:)` wraps it. `start()` is `async` and uses it. Callers
  updated: `GrokDispatchApp` Host menu, `AppState.ensureLocalHostOnMac`,
  `SettingsView`, `MacHostPanel`.

`ios/ClankerSpanker/ClankerSpanker/Views/Mac/MacHostPanel.swift`:

- The install card reads `host.service` and shows "Checking…" until the first
  check finishes. When `recovery == .loadAppAgent` it says the plist is
  installed but not loaded, and points at **Load LaunchAgent**.
- Install / Load / Unload / Uninstall `await` the async installer calls. Log
  lines are appended through `DispatchQueue.main.async`, in order.

The "Update from the git repo" card (RFC-059) talks to the gateway over HTTP
only. It runs no subprocess in the app, so it is unchanged.

## Testing

- [x] `Tests/HostServiceStatusTests.swift` (13 cases): recovery decision for
  interrupted install / loaded / standalone loaded / no plist / no package;
  `loadedAgentLabel` preference; `probe` against temp dirs with a fake
  `launchctl`; `bootstrapAgent` order and retry (bootout, print, bootstrap ×3,
  enable, kickstart), waits for the old job to unload before bootstrapping,
  still tries bootstrap once the unload wait runs out, gives up after N attempts, refuses without a plist and
  never boots out; `offMain` runs off the main thread.
- [x] `make test-swift`: 33 passed, 0 failed.
- [ ] Manual: Install / update host from a `/tmp` build; `launchctl bootout`
  the agent with the plist left in place, relaunch the app, and confirm the
  agent is loaded again.

## Rollout

1. Rebuild the Mac app. It builds into `~/Applications` by default, so quit
   the running app first.
2. `make check`, `make test-swift`.
3. RFC row in `docs/rfcs/README.md`.

## Follow-ups

- `HostTray/HostTrayConfig.swift` `HostTrayLaunchctl.run` waits on
  `launchctl` synchronously; check whether the tray calls it on the main thread.
