# ClankerSpanker

Remote-control **Grok Build** and **Claude Code** on your Mac Mini from an iPhone — local-first over Tailscale / LAN.

```
iPhone (ClankerSpanker)  ──Tailscale/LAN──►  Host gateway (Mac Mini)
                                              ├── grok agent stdio (ACP)
                                              └── claude -p stream-json + approval hooks
```

## Repo layout

```
GrokDispatch/          # repo folder (historical name)
├── host/              # Node gateway (REST + WebSocket)
├── ios/GrokDispatch/  # SwiftUI app → product ClankerSpanker
├── docs/
└── shared/
```

## Git

This folder is a git repo (`main`). Host token and session data stay **outside** the repo (`~/.grok-dispatch/`).

```bash
cd ~/Projects/GrokDispatch
git status
git log --oneline
# roll back working tree to last commit (destructive to uncommitted edits):
#   git checkout -- .
# roll back to a tag:
#   git switch --detach v0.2.3
```

## 1. Host (Mac Mini)

```bash
cd host
npm install
npm run build
npm start
# or install login item:
./scripts/install-launchd.sh
```

Config + token: `~/.grok-dispatch/config.json`  
Default port: **8787**

## 2. iOS app

```bash
cd ios/GrokDispatch
xcodegen generate
open ClankerSpanker.xcodeproj
```

- Bundle ID: `com.nightmoose.clankerspanker`
- Display name: **ClankerSpanker**
- Deep link: `clankerspanker://configure?url=…&token=…`

Onboarding: host URL + host token (leave xAI key blank).

## Features

- Dispatch multi-turn tasks to Grok Build (ACP, plan mode, phone approvals)
- Browse + resume **Grok** sessions from `~/.grok/sessions`
- Browse + resume **Claude Code** sessions from `~/.claude/projects`
  - Streaming transcript
  - Phone approval for Edit/Write/Bash via PreToolUse hook
  - Or hand off context to Grok
- Sessions UI tabs: **Active · Grok · Claude**
- Local notifications for approvals / turn complete

## Security

- Tailscale or LAN only; bearer host token
- Grok: never yolo — file edits / dangerous tools wait for the phone
- Claude: PreToolUse hook parks Edit/Bash until phone approves
