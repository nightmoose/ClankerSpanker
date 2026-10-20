# RFC-066 — Linux desktop on Electron 44

**Status:** Draft
**Date:** 2026-10-20
**Branch:** rfc-066-electron-44
**Severity:** P1

---

## Problem

The Linux command center (`desktop/`) pins `electron ^35.1.2` (resolved 35.7.5).
Electron supports only the latest three majors; on 2026-10-20 that is 42–44, so 35
gets no Chromium or Node security fixes. `npm audit` in `desktop/` reported 16
findings, 8 high, including a high advisory on `electron` itself (which ships inside
the AppImage/deb) and electron-builder's tree (`@xmldom/xmldom`, `brace-expansion`,
`extract-zip`, …).

There is also no automated check on `desktop/` at all: nothing in CI loads the main
process, so a bump that broke it would only show up on someone's Linux box.

## Non-goals

- New features or UI changes in the shell.
- Adding `setWindowOpenHandler` / `will-navigate` guards. The renderer opens no
  windows and navigates nowhere today; that hardening is a follow-up.
- A headless Electron run (xvfb) in CI. The smoke check below runs on plain Node.

## Fix

1. `electron` → `^44.9.1`, `electron-builder` → `^26.15.3` (resolves 26.17.0).
   `engines.node` → `>=22.12` (Electron 44's own requirement).
2. Walk the breaking changes 36 → 44 against `desktop/src` and `desktop/renderer`:

   | Version | Change | Effect here |
   |---|---|---|
   | 36 | GTK 4 default on GNOME | None in code. `--gtk-version=3` is the escape hatch. |
   | 38 | Native Wayland by default; `ELECTRON_OZONE_PLATFORM_HINT` removed | Documented `--ozone-platform=x11` in `desktop/README.md`. |
   | 42 | `electron` no longer downloads its binary in `postinstall` | First `npm start` fetches it. Dropped the stale `allowScripts` entry for `electron@35.7.5`. electron-builder fetches its own copy for packaging. |
   | 43 | Open/save dialogs default to `~/Downloads`; OS stops remembering the last folder | **Changed.** `main.js` now passes `defaultPath`, starting at `$HOME` and following the parent of the last pick (project/file pickers). |
   | 44 | `clipboard` removed from renderers | None. The renderer already uses `navigator.clipboard`. |
   | 44 | Unity support and `app.isUnityRunning()` removed; armv7l builds dropped | Not used. Package targets are x64 only. |

   The window already sets `contextIsolation: true`, `nodeIntegration: false`,
   `sandbox: true` explicitly, and the preload uses only `contextBridge` +
   `ipcRenderer`, so nothing relied on weaker defaults.
3. `desktop/scripts/smoke.js` (`npm run smoke`), wired into CI as the `desktop` job:
   - `node --check` over every `src/` and `renderer/` script;
   - loads `src/main.js` and `src/preload.js` with `electron` mocked, under a
     throwaway `HOME`/userData and a remote-only host config (nothing spawned, no real
     config touched);
   - asserts the main window keeps contextIsolation on, nodeIntegration off,
     sandbox on, and that every channel the preload invokes has an `ipcMain` handler.

   It needs no `npm install` and runs in well under a second.

## Testing

- [x] `npm run smoke` passes; flipping `sandbox` to `false` makes it fail.
- [x] `npm audit` in `desktop/`: 0 high (8 moderate remain, see Follow-ups).
- [ ] Manual soak on a Linux desktop (X11 and Wayland): start, tray menu, project
      folder picker opens in `$HOME` then in the last folder's parent, notifications,
      managed host start/stop, systemd install.

## Rollout

1. Merge; CI's `desktop` job guards future bumps.
2. `make check`
3. Index row in `docs/rfcs/README.md`

## Follow-ups

- 8 moderate `npm audit` findings: `sprintf-js` (GHSA-hp3w-g68c-fv3c, no patched
  release) via `global-agent` → `@electron/get` inside electron-builder. Build-time
  only, not shipped in the package. npm's only "fix" is downgrading electron-builder
  to 26.5.0.
- `setWindowOpenHandler(() => ({ action: "deny" }))` and a `will-navigate` guard on
  the main window.
