# ClankerSpanker — Linux desktop (Electron)

**Linux laptop command center.** Sessions UI + optional managed host process. Feature parity with the macOS SwiftUI app in `ios/ClankerSpanker/`.

> **macOS users:** use the **native Mac app** (`ios/ClankerSpanker`, scheme `ClankerSpanker`).
> Do not ship dual session UIs on Mac. See [docs/CLIENTS.md](../docs/CLIENTS.md).

```
Electron (Linux)  ──REST + WS──►  host/ gateway (:8787)
       │                                ├── grok
       └── spawn sibling host/ ─────────┘── claude
```

## Feature parity with the Mac app

Functional parity with the Mac command center (not a SwiftUI clone):

- Full transcript rendering: user/assistant/thought/system bubbles + inline tool-call rows merged by timestamp.
- Streaming `thought` chunks; "Still working…" pulse when running with no text yet.
- Incremental WS events + `/sessions/:id/events?since=N` replay on reconnect.
- Session tabs: **Transcript · Tools · Plan · Diff · Notes** (notes/tasks are CRUD, with right-click capture from a bubble).
- Session ⋯ menu: rename, close as done, cancel, delete, transfer, reincarnate, review, assign project, archive.
- Session list: Recent (last 5) / Active / Archived, host content search (`?q=`), multi-select profile chips with usage %.
- Sidebar: **Projects** (CRUD, discover, multi-path), **Tasks** (global list), and **Bots** (hunter agents — create, enable/disable, edit standing job, change schedule, run now, view `.bot-outbox/` drafts).
- Compose: project + custom cwd, subagents toggle, Grok plan/worktree hidden for Claude/Antigravity.
- Follow-up images; local file viewer pane (managed/local disk only).
- Re-login banner → `POST /profiles/:id/login` (browser opens **on the host**).
- Rich approvals: comment, "Approve always this session", Enter / Esc.
- Multi-host registry, tray, host install + systemd user service.

## Modes

| Mode | Behavior |
|------|----------|
| **Managed** (default per host) | Uses installed host (`~/.local/share/clankerspanker/host`) or sibling `../host`; start/stop from tray; syncs token from `~/.grok-dispatch` |
| **Remote** | Connect to an existing host URL + token; process controls disabled |

## First-launch install (any Linux box)

1. Install the package:
   ```bash
   sudo dpkg -i ClankerSpanker-*.deb        # or chmod +x the AppImage and run it
   ```
2. Launch **ClankerSpanker**.
3. Open **Host → Install / update host**. This:
   - Copies the bundled host into **`~/.local/share/clankerspanker/host`**
   - Runs `npm install --omit=dev` there
   - Writes + enables a **systemd `--user`** unit `clankerspanker-host.service`
   - Points managed mode at the install path
4. Sessions light up. Done.

The AppImage/deb bundles a built `host/dist` under `resources/host` so the installer works on machines that never had the monorepo. The installer performs `npm install --omit=dev` at install time.

Requirements on the target machine:
- Node 20+ on PATH (the host service execs `node dist/index.js`)
- `grok` and/or `claude` CLIs on PATH for the profiles you use
- `systemd --user` if you want the persistent service (default on desktop distros; opt out with **Load service** unchecked)

## Multi-host

Add more hosts in **Desktop settings → Hosts** (name + URL + token; leave token blank for local managed hosts). Switch between them with the pill in the top-right of the sessions view or the tray "Switch host" submenu. Sessions/state reload per host.

## Dev workflow

```bash
cd host && npm install && npm run build
cd ../desktop
npm install
npm start
```

On first managed launch:

1. Ensures `~/.grok-dispatch/config.json`
2. Auto-starts the local host if `/health` is down (only if bundled/installed/sibling `host/` exists)
3. Opens the sessions command center

## Building packages

**Build packages on Linux** (or Linux CI). Cross-building AppImage/deb from macOS is unreliable.

```bash
cd desktop
npm install
npm run dist:linux     # runs prebuild-host (npm install + build inside ../host) automatically
# → release/ClankerSpanker-*-linux-*.AppImage
# → release/ClankerSpanker-*-linux-*.deb
```

The `prebuild-host` script rebuilds `../host/dist` before packaging so the bundle contains a fresh gateway build.

## Layout

```
desktop/
  src/         Electron main — process manager, host config I/O, tray, WS notify, multi-host registry
  renderer/    Command-center UI (sessions-first, tabs, approvals, search)
  resources/   App icon
```

| Prefs | Path |
|-------|------|
| Electron shell (host registry + prefs) | app `userData` / `config.json` |
| Host gateway (source of truth) | `~/.grok-dispatch/config.json` |
| Installed host package | `~/.local/share/clankerspanker/host` |
| systemd user unit | `~/.config/systemd/user/clankerspanker-host.service` |

## Security

- Host token lives in host config; shell stores a per-host copy for API calls
- Remote UI has no Node integration; renderer is sandboxed with contextIsolation
- LAN / Tailscale only — do not expose `:8787` publicly

## Known Linux-only limitations

- **Notification action buttons**: macOS notifications carry inline Approve/Reject buttons. On Linux, Electron's `Notification` API doesn't surface libnotify actions, so notifications click through to the session detail (which has keyboard shortcuts + rich approval bar). The body carries the approval kind + path so you can decide before opening.
- **Deep linking** (`clankerspanker://` URLs): not wired. Tray + notification click covers focus.
- **File viewer** only reads this machine's disk (same as Mac). Remote hosts: path must exist locally.

Keyboard (when focus is not in an input): **Ctrl+N** compose, **Ctrl+Shift+P** projects, **Ctrl+Shift+T** tasks, **Ctrl+Alt+I** file viewer.
