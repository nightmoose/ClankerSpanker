# ClankerSpanker — Linux desktop (Electron)

**Linux laptop command center.** Sessions UI + optional managed host process.

> **macOS users:** use the **native Mac app** (`ios/GrokDispatch`, scheme `ClankerSpanker`).  
> Do not ship dual session UIs on Mac. See [docs/CLIENTS.md](../docs/CLIENTS.md).

```
Electron (Linux)  ──REST + WS──►  host/ gateway (:8787)
       │                                ├── grok
       └── spawn sibling host/ ─────────┘── claude
```

## Modes

| Mode | Behavior |
|------|----------|
| **Managed** (default) | Uses installed host (`~/.local/share/clankerspanker/host`) or sibling `../host`; start/stop; syncs token from `~/.grok-dispatch` |
| **Remote** | Connect to an existing host URL; process controls disabled |

### Install gateway (like Mac)

In the app: **Host → Install / update host**

1. Builds/copies host out of the monorepo into **`~/.local/share/clankerspanker/host`**  
2. `npm install --omit=dev`  
3. Enables **systemd --user** unit `clankerspanker-host.service`  
4. Points managed mode at the install path  

You no longer need the AppImage to sit next to a git checkout for day-to-day use (you only need a **source** `host/` once to install from).

## Requirements

- Node 20+
- Built host: `cd ../host && npm install && npm run build`
- Agents (`grok`, `claude`) on PATH for the host process

## Dev

```bash
cd host && npm run build
cd ../desktop
npm install
npm start
```

On first managed launch:

1. Ensures `~/.grok-dispatch/config.json`  
2. Auto-starts host if `/health` is down  
3. Opens the Sessions command center  

## Linux packages

**Build packages on Linux** (or Linux CI). Cross-building AppImage/deb from macOS is unreliable.

```bash
cd desktop
npm install
npm run dist:linux
# → release/ClankerSpanker-*-linux-*.AppImage
# → release/ClankerSpanker-*-linux-*.deb
```

AppImage installs often need **Host package path** set to an absolute `host/` with `dist/`.

## Layout

```
desktop/
  src/         Electron main — process manager, host config I/O, tray, WS notify
  renderer/    Command-center UI (sessions-first)
  resources/   App icon
```

| Prefs | Path |
|-------|------|
| Electron shell | app `userData` / `config.json` |
| Host gateway (source of truth) | `~/.grok-dispatch/config.json` |

## Security

- Host token lives in host config; shell stores a copy for API calls  
- Remote UI has no Node integration  
- LAN / Tailscale only — do not expose `:8787` publicly  
