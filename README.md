# ClankerSpanker

[![CI](https://github.com/nightmoose/ClankerSpanker/actions/workflows/ci.yml/badge.svg)](https://github.com/nightmoose/ClankerSpanker/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node 20+](https://img.shields.io/badge/node-20%2B-339933)
![Platforms](https://img.shields.io/badge/clients-macOS%20%7C%20iOS%20%7C%20Linux%20%7C%20web-lightgrey)

**Local-first control plane for [Grok Build](https://x.ai) and [Claude Code](https://www.anthropic.com/claude-code).**
Run one gateway next to your code, then drive your coding agents from your phone, laptop or browser:
start tasks, approve edits and commands, and resume sessions, over loopback or your own Tailscale network.
Nothing leaves your machines except what the agents themselves send to their providers.

> **Not affiliated.** ClankerSpanker is an independent open-source project. It is not affiliated with,
> endorsed by, or sponsored by xAI, Anthropic, Google, Apple, or Tailscale. "Grok", "Claude" and other
> product names are trademarks of their respective owners and are used only to describe compatibility.

<!-- TODO(hero): replace with a real screenshot or GIF (phone approving an edit while the Mac host runs).
     Save it as docs/assets/hero.gif (or hero.png, keep under ~500 KB) and swap the placeholder below. -->
> 🚧 **TODO: hero screenshot / GIF goes here** (`docs/assets/hero.gif`)

```
Mac native app  ──┐
Linux Electron  ──┼── REST + WebSocket ──►  Host gateway (:8787)
Browser /app/   ──┤                              ├── grok agent (ACP)
iOS (phone)     ──┘                              └── claude (+ approval hooks)
```

## Quickstart

Requires Node 20+ and the agent CLI(s) you want to drive (`grok`, `claude`).

```bash
git clone https://github.com/nightmoose/ClankerSpanker.git
cd ClankerSpanker/host
npm install && npm run build && npm start
```

1. Open `http://localhost:8787/setup` **on the host machine** to see the QR code and token.
2. Open `http://localhost:8787/app/` in a browser and sign in with the token, or pair the iOS / desktop client.
3. Pick a project and send your first prompt.

Run it as a background service: `./scripts/install-service.sh` (macOS launchd / Linux `systemd --user`).

## Documentation

Start at the **[docs index](docs/README.md)**: [architecture](docs/ARCHITECTURE.md),
[clients](docs/CLIENTS.md), [standalone installs](docs/STANDALONE-INSTALLS.md), [MCP](docs/MCP.md),
[APNs push](docs/APNS.md), [host README](host/README.md), [design RFCs](docs/rfcs/README.md).

## Repo layout

```
ClankerSpanker/
├── host/                       # Node gateway: the only agent runner
│   ├── src/
│   ├── web/                    # Browser UI at /app/
│   └── scripts/                # launchd + systemd install
├── desktop/                    # Electron: Linux laptop command center
├── ios/ClankerSpanker/         # SwiftUI: iOS + native macOS app
├── docs/
└── shared/                     # OpenAPI contract
```

## Host details

| | |
|--|--|
| Browser UI | `http://<host-ip>:8787/app/` |
| Pair a phone | `http://localhost:8787/setup` on the host (QR code; host-machine only) |
| Config | `~/.grok-dispatch/config.json` (legacy directory name from the project's earlier name; kept for compatibility) |

Port `8787` is the default; change it with `bindPort` in the config. See [`host/README.md`](host/README.md).

## 2. Laptop clients

### macOS — native app (authoritative Mac UX)

```bash
cd ios/ClankerSpanker
./run-mac.sh
# or Xcode: scheme ClankerSpanker → destination My Mac (not Designed for iPad)
```

Sessions, host install/LaunchAgent, menu bar service, multi-folder projects.  
Details: [`ios/ClankerSpanker/RUN-MAC.md`](ios/ClankerSpanker/RUN-MAC.md).

### Linux — Electron (`desktop/`)

```bash
cd host && npm run build          # once
cd ../desktop && npm install && npm start
```

**Host → Install / update host** copies the gateway to `~/.local/share/clankerspanker/host` and enables a systemd user service (parity with Mac).  
Config remains `~/.grok-dispatch`.  
**AppImage / deb:** run `npm run dist:linux` **on Linux** (or Linux CI). See `desktop/README.md`.  
Standalone host + agent CLIs: [docs/STANDALONE-INSTALLS.md](docs/STANDALONE-INSTALLS.md).

### Browser (any OS)

Open `/app/` with the host token. No local process management.

### iPhone

```bash
open ios/ClankerSpanker/ClankerSpanker.xcodeproj
# Scheme: ClankerSpankerPhone → your iPhone (unlocked + trusted) → Run
```

Do not use “My Mac (Designed for iPad)” for the phone scheme.

## Features

- Dispatch multi-turn tasks to Grok Build (ACP, plan mode, client approvals)
- Browse + resume **Grok** / **Claude Code** sessions from disk
- Soft-archive Active chats
- Optional desktop/OS notifications (host + laptop shells)
- Cross-platform host PATH / binary discovery (no hardcoded machine IPs)

## Security

- Listens on loopback + Tailscale by default (`bindHost: "auto"`); bearer host token
- The token is only shown on the host machine (`/setup`) and never goes in WebSocket URLs
- Grok: never yolo — file edits / dangerous tools wait for the client
- Claude: PreToolUse hook parks Edit/Bash until approved
- **Gemini / Antigravity: not approval-gated.** Headless `agy` can't ask, so it runs with
  `--dangerously-skip-permissions`. The composer shows a warning on these profiles. Set
  `ANTIGRAVITY_REQUIRE_PERMISSIONS=1` in the profile's env to require permissions (shell
  tools are then refused).
- `host/src/auth.ts` is the security boundary (constant-time compare; empty token authorizes nobody)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md). Run `make check` before opening a PR.
Report security issues privately: [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2026 NightMoose, Inc. Tokens and session JSON live under `~/.grok-dispatch/` (not in git).
