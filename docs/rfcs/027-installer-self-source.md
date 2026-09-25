# RFC-027 — Mac host installer: never install from itself, always rebuild

**Status:** Shipped
**Date:** 2026-09-25
**Branch:** nightly-maintenance-2026-09-25-rfc027-installer-self-source
**Severity:** P1

---

## Problem

`HostInstaller.install` (Mac Host panel → **Install / update host**):

1. Ends with `savePackagePath(installRoot.path)`, so the saved "Host package
   path" becomes `~/Library/Application Support/ClankerSpanker/host` — the
   install root itself. `LocalHostController.defaultHostPackagePath()` also
   prefers the installed copy over a checkout.
2. The next **Install / update** therefore uses the install root as its
   *source*: it deletes `dist/`, `web/`, `package.json`, … from the install
   root and then tries to copy them from the folder it just emptied. The
   copy throws and the host is left without `dist/index.js`. Found on
   2026-09-25 (`localHostPackagePath` in the app's defaults pointed at the
   install root).
3. It only runs `npm run build` when the source has **no** `dist/`. A
   checkout with an older `dist/` installs stale code without warning.

## Non-goals

- Linux/Electron installer (`desktop/src/host-installer.js`).
- XCTest target for the Mac app (tracked separately; no Swift tests exist).

## Fix

- `HostInstaller.resolveSource`: ignore any candidate whose standardized
  path equals `installRoot` (including the saved path). Fall back to the
  checkout candidates; if none exist, throw "Point Host package path at your
  ClankerSpanker checkout's host/ folder."
- When the source looks like a checkout (`src/` + `tsconfig.json`), always
  run `npm install && npm run build` before copying.
- Save the **source** path (not `installRoot`) after a successful install.
- `LocalHostController.defaultHostPackagePath()`: prefer checkout
  candidates; never return the install root. On launch, a saved path equal
  to the install root is replaced by the default.

## Testing

- [x] Manual: with `localHostPackagePath` pointing at the install root, press
      **Install / update host** → it installs from `~/Projects/GrokDispatch/host`,
      the host restarts healthy, and the saved path is the checkout.
- [ ] Manual: change a string in `host/src`, press Install / update → the
      running host has the change (rebuild happened).
- [x] `make check` (host unaffected).

## Rollout

1. Build the Mac app; run the manual checks above.
2. `docs/STATUS.md` → Shipped; `MAINTENANCE_LOG.md`.

## Follow-ups

- An XCTest target so installer path logic can be unit tested.
