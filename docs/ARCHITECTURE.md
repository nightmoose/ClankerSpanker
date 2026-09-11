# Architecture

## Components

| Piece | Role |
|-------|------|
| **Host gateway** (`host/`) | Single Node HTTP + WebSocket server; spawns Grok ACP / Claude processes |
| **Browser UI** (`host/web`) | Thin control plane at `/app/` — no host lifecycle |
| **Mac native app** (`ios/…` → ClankerSpankerMac) | **macOS laptop** command center: sessions + local host manager + menu bar |
| **Electron app** (`desktop/`) | **Linux laptop** command center: sessions + local host manager + tray |
| **iOS app** | Phone control plane (same Swift sources; scheme deferred) |

Authoritative client matrix: **[CLIENTS.md](CLIENTS.md)**.

There is **no second gateway**. Laptop shells are clients; they may spawn/install the same `host` process.

## Data flow

```
Compose → POST /dispatch
  → SessionManager spawns AcpClient (grok agent stdio) or Claude runner
  → session/new + session/prompt
  → session/update events → WS broadcast → clients
  → session/request_permission
       ├─ safe kinds (read/search/…) → auto allow
       └─ edit/execute/… → pending approval → client approve/reject
```

## Persistence

| Store | Location |
|-------|----------|
| Host config + token | `~/.grok-dispatch/config.json` |
| Dispatch session snapshots | `~/.grok-dispatch/sessions/*.json` |
| Native Grok sessions | `~/.grok/sessions/` (subagent / helper worktrees are not listed) |
| Claude projects | `~/.claude/projects/` |
| Mac app prefs / keychain | macOS userData + Keychain |
| Electron prefs | Electron `userData` (shell only — not host token of record) |
| Installed host package (Mac optional) | `~/Library/Application Support/ClankerSpanker/host` |

## Why a gateway?

ACP is the right integration surface for Grok, but a small REST/WS facade keeps phone and laptop clients simple and stable without shipping a full JSON-RPC agent client on every release.
