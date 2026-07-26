# Grok Dispatch Host

Thin local gateway on your Mac Mini. The iPhone app talks REST + WebSocket over Tailscale; this process speaks ACP to `grok agent stdio`.

## Quick start

```bash
cd host
npm install
npm run dev
```

On first run a config is written to `~/.grok-dispatch/config.json` including a **host token**. Put that token in the iOS app.

### Production

```bash
npm install
npm run build
npm start
# or install as a login item:
./scripts/install-launchd.sh
```

## API

All routes except `GET /health` require:

```
Authorization: Bearer <hostToken>
```

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Liveness |
| POST | `/auth/validate` | Check token |
| GET | `/projects` | Allowlisted project dirs |
| GET | `/sessions` | Dispatched sessions |
| GET | `/sessions/:id` | Detail + transcript + pending approval |
| GET | `/sessions/:id/diff` | `git diff HEAD` in session cwd |
| POST | `/dispatch` | Start a task |
| POST | `/sessions/:id/prompt` | Follow-up on live session |
| POST | `/sessions/:id/approve` | `{ approvalId, optionId?, comment? }` |
| POST | `/sessions/:id/reject` | `{ approvalId, optionId?, comment? }` |
| POST | `/sessions/:id/cancel` | Cancel |
| WS | `/ws?token=<hostToken>` | Live `event` stream |

### Dispatch body

```json
{
  "prompt": "Add a settings toggle for dark mode",
  "projectId": "grok-dispatch",
  "planMode": true,
  "worktree": true,
  "subagents": true,
  "model": "grok-build"
}
```

## Security model

- Bind is `0.0.0.0:8787` by default — **only expose on Tailscale**, not the public internet.
- Host token authenticates the phone.
- Mac-side Grok auth uses your existing `grok login` / `XAI_API_KEY`.
- File edits and dangerous tools require phone approval. Reads/searches auto-approve (`autoApproveKinds` in config).
- Never starts Grok with `--always-approve` / yolo.

## Config

`~/.grok-dispatch/config.json`:

```json
{
  "hostToken": "…",
  "bindHost": "0.0.0.0",
  "bindPort": 8787,
  "grokBinary": "/Users/you/.grok/bin/grok",
  "projects": [
    { "id": "my-app", "name": "My App", "path": "/Users/you/Projects/MyApp" }
  ],
  "allowCustomPaths": true,
  "autoApproveKinds": ["read", "search", "think", "fetch", "other"],
  "notifyMac": true,
  "dataDir": "/Users/you/.grok-dispatch"
}
```

Env overrides: `GROK_DISPATCH_HOST`, `GROK_DISPATCH_PORT`, `GROK_DISPATCH_TOKEN`, `GROK_BINARY`, `GROK_DISPATCH_CONFIG`.
