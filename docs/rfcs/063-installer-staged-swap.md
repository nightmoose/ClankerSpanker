# RFC-063 — Mac host installer: stage, then swap; never delete the live install first

**Status:** Shipped
**Date:** 2026-10-19
**Branch:** rfc-063-installer-staged-swap
**Severity:** P1

---

## Problem

On 2026-10-19 **Install / update host** in the Mac Host panel emptied the
live install. The saved `localHostPackagePath` (defaults domain
`com.nightmoose.clankerspanker.mac`) was
`~/Library/Application Support/ClankerSpanker/host`, which is
`HostInstaller.installRoot` itself. The log read "Source: …/Application
Support/ClankerSpanker/host", then "Copying dist + web + package manifests…",
then "The file 'dist' couldn't be opened". By then `install(...)` had already
deleted `dist/`, `web/`, `package.json`, `package-lock.json` and
`node_modules` from the install root. The panel showed "Not installed". The
LaunchAgent kept serving old code from memory, so the next restart would have
left the user with no gateway. It was restored by hand from the checkout.

RFC-027 added a guard for this case: `resolveSource` drops candidates whose
`standardizingPath` equals the install root. The app in
`~/Applications/ClankerSpankerMac.app` (built 2026-10-06) still contains the
pre-RFC-027 error string, so it predates that guard. The guard was the only
defense, and it had gaps:

1. `HostInstaller.install` deleted the five package items in the install root
   **before** copying anything. Any failure after that point, for any reason
   (a missing `web/`, a full disk, `npm install --omit=dev` failing), left
   the user with no host.
2. The guard compared paths with `standardizingPath`. That does not resolve
   symlinks and does not catch a subfolder of the install root such as
   `…/host/dist`.
3. The Host panel and Settings still let you save the install root as the
   source path.

## Non-goals

- The Linux/Electron installer (`desktop/src/host-installer.js`).
- Rolling back the install if the LaunchAgent fails to load after the swap.
  The files are good at that point, and **Load LaunchAgent** retries.
- Rebuilding `~/Applications/ClankerSpankerMac.app`. That is a local step and
  is listed under Rollout.

## Fix

`ios/ClankerSpanker/ClankerSpanker/Services/HostInstaller.swift`:

- `isInside(_:root:)` returns true when a path is the root or anything under
  it. It expands `~`, standardizes, and resolves symlinks on both sides, then
  compares path components. `isInstallRootPath(_:)` applies that test to
  `LocalHostConfigFile.installedHostRoot`.
- `refuseSelfSource(_:installRoot:)` throws when the source is inside the
  install root. The error says to set Source package to the checkout's
  `host/` folder and that the installed host was not touched. `install` calls
  it right after `resolveSource`, before the build. `deploy` calls it again
  before staging.
- `deploy(from:to:log:prepare:)` replaces the old delete-then-copy:
  1. It copies `dist`, `package.json`, `web` and `package-lock.json` (the last
     two when they exist) into `.host.staging-<id>`, a sibling of the install
     root on the same volume.
  2. It runs `prepare(staging)`, which in production is
     `npm install --omit=dev`, so `node_modules` is built in staging too.
  3. It checks that `dist/index.js` exists in staging.
  4. It swaps. Each existing package item moves to `.host.previous-<id>` and
     each staged item moves into the install root. These are renames, so they
     are fast and do not touch file contents. If a rename fails, it removes
     what it moved in and moves the old items back.
  5. It removes the staging and backup dirs in all cases.

  A failure in steps 1 to 3 never modifies the install root. Files in the
  install root that are not package items are left alone.
- `resolveSource`: if the saved path is inside the install root, it logs
  that, clears the saved path, and falls through to checkout auto-detection.
  Candidates are filtered with `isInside` instead of string equality.

`LocalHostController.savePackagePath(_:)` now returns `Bool`. It refuses a
path inside the install root: it removes the saved key, resets the field to
the detected checkout, and returns false. `init` uses `isInstallRootPath` for
its launch-time check.

`MacHostPanel` (**Save** and **Browse…**) and `SettingsView` (**Save path**)
show an error when the path is refused. `runInstall` never passes an
install-root path as the explicit source.

`Makefile` `test-swift` passes `CONFIGURATION_BUILD_DIR` and `TEST_HOST`
overrides. Commit 69b0ea9 hand-edited the committed `project.pbxproj` to build
the app into `~/Applications` without updating `project.yml`. Since then,
`make test-swift` has failed with "could not compute relative build path for
TEST_HOST". If it had built, it would also have replaced the user's installed
app. The overrides keep the test build in `/tmp/ClankerSpanker-tests`.
`HostInstallerTests.swift` was added to `project.pbxproj` by hand, not with
`xcodegen`, because regenerating would drop those `~/Applications` settings.

## Testing

- [x] `Tests/HostInstallerTests.swift` (`make test-swift`):
  - `testIsInsideMatchesRootSubfoldersTrailingSlashAndDots`
  - `testIsInsideFollowsSymlinks`
  - `testInstallRootPathIsNeverASource`
  - `testDeployFromInstallRootRefusesAndDeletesNothing`
  - `testDeployFromInsideInstallRootRefuses`
  - `testFailedCopyKeepsOldInstall` (the source has no `dist/`)
  - `testFailedPrepareKeepsOldInstall` (`npm install` fails in staging)
  - `testSuccessfulDeploySwapsPackageAndKeepsOtherFiles`
  - `testDeployIntoMissingInstallRootCreatesIt`
- [x] Manual (test build): with `localHostPackagePath` still set to the
      install root, launch the app and open **Host → Show Host panel**.
      Source package shows `~/Projects/GrokDispatch/host`, not the install
      root.
- [x] Manual (test build): type `~/Library/Application Support/ClankerSpanker/host`
      into Source package and press **Save**. The red error shows, the field
      resets to the checkout, and `defaults read … localHostPackagePath` no
      longer exists.
- [ ] Manual: press **Install / update host** with the install root saved.
      It should install from the checkout, and the saved path should become
      the checkout. Not run: it rebuilds and restarts the live gateway.
- [ ] Manual: a normal **Install / update host** from the checkout. The host
      restarts healthy and no `.host.staging-*` or `.host.previous-*` dirs are
      left in `~/Library/Application Support/ClankerSpanker/`.

## Rollout

1. `make check` and `make test-swift`.
2. Rebuild and replace `~/Applications/ClankerSpankerMac.app`. The copy
   there predates RFC-027.
3. Run the manual checks above.
4. Mark the RFC Shipped in `docs/rfcs/README.md`.

## Follow-ups

- Apply the same stage-then-swap to `desktop/src/host-installer.js`.
