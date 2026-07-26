# Architecture

## Components

1. **iOS app** — SwiftUI MVVM, URLSession REST, URLSessionWebSocketTask, Keychain, UserNotifications.
2. **Host gateway** — Node/TypeScript HTTP + WebSocket server on the Mac Mini.
3. **Grok Build** — `grok agent stdio` (ACP JSON-RPC) per dispatched task process.

## Data flow

```
Compose → POST /dispatch
  → SessionManager spawns AcpClient (grok agent stdio)
  → session/new + session/prompt
  → session/update events → WS broadcast → phone
  → session/request_permission
       ├─ safe kinds (read/search/…) → auto allow
       └─ edit/execute/… → pending approval → phone approve/reject
```

## Persistence

| Store | Location |
|-------|----------|
| Host config + token | `~/.grok-dispatch/config.json` |
| Dispatch session snapshots | `~/.grok-dispatch/sessions/*.json` |
| Native Grok sessions | `~/.grok/sessions/` |
| iOS secrets | Keychain `com.nightmoose.grokdispatch` |

## Why a gateway (not raw ACP on the phone)?

ACP is the right integration surface for Grok, but a small REST/WS facade keeps the iOS client simple, stable, and easy to evolve without shipping a full JSON-RPC agent client on every phone release.
