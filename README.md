# ClankerSpanker

Local-first control plane for **Grok Build** and **Claude Code**.  
One **host gateway** next to your code; clients drive it over LAN / Tailscale.

```
Mac native app  ──┐
Linux Electron  ──┼── REST + WebSocket ──►  Host gateway (:8787)
Browser /app/   ──┤                              ├── grok agent (ACP)
iOS (phone)     ──┘                              └── claude (+ approval hooks)
```

Client ownership and parity: **[docs/CLIENTS.md](docs/CLIENTS.md)** (read this before adding another laptop UI).

How we work (ContractGate house style, **enforced**): **[docs/HOUSE-STYLE.md](docs/HOUSE-STYLE.md)**. `make check` before merge.

## Repo layout

```
ClankerSpanker/                 # GitHub name (folder may still be GrokDispatch)
├── host/                       # Node gateway — the only agent runner
│   ├── src/
│   ├── web/                    # Browser UI at /app/
│   └── scripts/                # launchd + systemd install
├── desktop/                    # Electron — Linux laptop command center
├── ios/ClankerSpanker/           # SwiftUI — iOS + Mac native (Mac is the laptop shell)
├── docs/
│   ├── CLIENTS.md              # Who owns which client
│   └── ARCHITECTURE.md
└── shared/
```

## 1. Host (any machine with Node 20+)

```bash
cd host
npm install
npm run build
npm start
# optional background service (macOS launchd / Linux systemd --user):
./scripts/install-service.sh
```

| | |
|--|--|
| Browser UI | `http://<host-ip>:8787/app/` |
| Pair a phone | `http://localhost:8787/setup` on the host (QR code; host-machine only) |
| Config | `~/.grok-dispatch/config.json` |

Port `8787` is intentional (Bricklayer uses `8791`). Same Mac can run both.

## 2. Laptop clients

### macOS — native app (authoritative Mac UX)

```bash
cd ios/ClankerSpanker
./run-mac.sh
# or Xcode: scheme ClankerSpanker → destination My Mac (not Designed for iPad)
```

Sessions, host install/LaunchAgent, menu bar service, multi-folder projects.  
Details: `ios/ClankerSpanker/RUN-MAC.md`.

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

- Listens on loopback + Tailscale by default (`bindHost: "auto"`, RFC-028); bearer host token
- The token is only shown on the host machine (`/setup`, RFC-026) and never goes in WebSocket URLs (RFC-029)
- Grok: never yolo — file edits / dangerous tools wait for the client
- Claude: PreToolUse hook parks Edit/Bash until approved
- **Gemini / Antigravity: not approval-gated.** Headless `agy` can't ask, so it runs with
  `--dangerously-skip-permissions`. The composer shows a warning on these profiles. Set
  `ANTIGRAVITY_REQUIRE_PERMISSIONS=1` in the profile's env to require permissions (shell
  tools are then refused). RFC-030.
- `host/src/auth.ts` is the security boundary (constant-time compare; empty token authorizes nobody)

## Git

- Remote: https://github.com/nightmoose/ClankerSpanker  
- Tokens and session JSON under `~/.grok-dispatch/` (not in git)
