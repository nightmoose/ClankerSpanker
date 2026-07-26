# ClankerSpanker

Local-first control plane for **Grok Build** and **Claude Code**. Run the host next to your code; drive it from a **browser** or the **iOS** app over LAN / Tailscale.

```
Browser  ──┐
           ├── REST + WebSocket ──►  Host gateway (macOS / Linux / Windows*)
iOS app  ──┘                              ├── grok agent (ACP)
                                          └── claude -p stream-json + approval hooks
```

\* Windows: `npm start` is supported; service install helpers are macOS launchd + Linux systemd.

## Repo layout

```
ClankerSpanker/          # GitHub name (folder may still be GrokDispatch locally)
├── host/                # Node gateway + browser UI (host/web)
│   ├── src/
│   ├── web/             # Browser control plane served at /app/
│   └── scripts/         # install-service (launchd / systemd)
├── ios/GrokDispatch/    # SwiftUI app → product ClankerSpanker
├── docs/
└── shared/
```

## Git

- **Remote (private today):** https://github.com/nightmoose/ClankerSpanker  
- Host token + session JSON live under `~/.grok-dispatch/` (not in git).

```bash
cd host   # or repo root
git status
git log --oneline
```

## 1. Host (any machine with Node 20+)

```bash
cd host
npm install
npm run build
npm start
# background service:
./scripts/install-service.sh
```

| | |
|--|--|
| Browser UI | `http://<host-ip>:8787/app/` |
| Setup / token | `http://<host-ip>:8787/setup` |
| Config | `~/.grok-dispatch/config.json` |

## 2. Clients

### Browser (built-in)

Open `/app/`, paste the host token once (or open `/setup` first). Same APIs as the phone app: sessions, dispatch, approvals, archive, Grok/Claude disk attach.

### iOS app

```bash
cd ios/GrokDispatch
xcodegen generate
open ClankerSpanker.xcodeproj
```

- Bundle ID: `com.nightmoose.clankerspanker`
- Deep link: `clankerspanker://configure?url=…&token=…`

## Features

- Dispatch multi-turn tasks to Grok Build (ACP, plan mode, client approvals)
- Browse + resume **Grok** sessions from `~/.grok/sessions`
- Browse + resume **Claude Code** sessions from `~/.claude/projects`
- Soft-archive Active chats
- Desktop notifications on macOS / Linux / Windows (best-effort)
- Cross-platform host PATH / binary discovery (no hardcoded machine IPs)

## Security

- Tailscale or LAN only; bearer host token
- Grok: never yolo — file edits / dangerous tools wait for the client
- Claude: PreToolUse hook parks Edit/Bash until approved
