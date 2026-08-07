# Next steps (post Mac + Linux client consolidation)

**Last updated:** 2026-08-07  

Client ownership is locked in [CLIENTS.md](CLIENTS.md). One host gateway only.

---

## Done (this arc)

- [x] Linux Electron command center in `desktop/` (committed)
- [x] Client ownership docs (Mac native / Linux Electron / browser / phone deferred)
- [x] Mac native command center (sessions, host panel, menu bar, icons)
- [x] Host install path toward Application Support + LaunchAgent (Mac)
- [x] Multi-folder project picker (Mac); message input at top of session detail
- [x] Host config: usable cwd guards, known workspace merge, Claude plan/worktree flags

---

## Open / in question

| Item | Status | Notes |
|------|--------|--------|
| **event-horizon/** | Untracked on purpose | Separate mini-game under repo root; not ClankerSpanker product. Commit separately or move out. |
| **Host tests** | Env broken here | `npm test` failed on missing `@rollup/rollup-darwin-arm64` (node_modules). Re-run after `cd host && rm -rf node_modules && npm i`. Typecheck clean. |
| **Linux AppImage/deb** | Not built | Must run `npm run dist:linux` **on Linux** / CI — not from this Mac. |
| **Phone Run scheme** | Deferred | iOS target exists; no Run scheme until we resume phone work. |
| **Host install from Mac** | Needs real-user soak | “Install / update host” + LaunchAgent not fully field-tested after Application Support copy. |
| **Electron host install** | Gap | Mac can install to App Support; Linux Electron still points at sibling `host/` path (fine for dev; packaging needs install story). |
| **ComposerViewModel / iOS shared** | Mac-focused | Shared Swift files changed for multiplatform; smoke phone build when scheme returns. |
| **ConnectionDefaults hardcode** | Known defect | Still may ship a site IP — AGENTS.md; fix when touching iOS networking. |

---

## Recommended next steps (priority)

### P0 — Ship what you use daily

1. **Mac soak:** Clean run → menu bar icon → Install host → LaunchAgent reboot → sessions after reboot.  
2. **Commit already done for Mac + host** (this push prep).  
3. **Push** `main` when ready (`git push` — not done automatically).

### P1 — Linux ship

4. On a **Linux** machine (or Linux CI), build installable packages:
   ```bash
   cd desktop && npm ci && npm run dist:linux
   ```
   That produces `.AppImage` / `.deb` under `desktop/release/`.  
   **You cannot reliably build those on this Mac** — electron-builder needs Linux for those targets.

5. **Host install from Linux desktop (done in product code):**  
   **Host → Install / update host** installs to `~/.local/share/clankerspanker/host` and enables systemd user service — same idea as Mac Application Support + LaunchAgent.  
   You only need a monorepo `host/` **once** as the install *source*; day-to-day does not require the AppImage to live next to git.  
   Soak-test on a real Linux box still open.

6. **Standalone agent CLIs** (Grok + Claude) on all OSes — see [STANDALONE-INSTALLS.md](STANDALONE-INSTALLS.md). Optional future: one-click installer buttons in the desktop apps.

### P2 — Product polish

7. Session deep-link from notifications / menu bar into a specific session id.  
8. Host API `POST /projects` hot-reload so adding folders doesn’t need host restart (today config is read at boot; custom paths still work if `allowCustomPaths`).  
9. Restore **iOS scheme** only when phone work resumes; keep Mac scheme as default.  
10. Fix `ConnectionDefaults` hardcoded LAN IP.

### P3 — Hygiene

11. **event-horizon/** — excluded via `.gitignore` until you move it (e.g. `~/Projects/event-horizon`). Not ClankerSpanker product.  
12. **Host tests:** Gate is `cd host && npm test && npm run typecheck && npm run build`.  
    Re-run after dependency surgery. (Restored here with `npm install` → **18 tests passed**.)

---

## Operator notes (for *you*, not the agent)

When using the products day-to-day:

- **Mac laptop:** Xcode scheme **ClankerSpanker** → destination **My Mac** (never “Designed for iPad”).  
- **Linux laptop:** Electron app in `desktop/`.  
- **One gateway:** `host/` + config in `~/.grok-dispatch/`.  

Agents reading the repo should follow [CLIENTS.md](CLIENTS.md) and [AGENTS.md](../AGENTS.md).