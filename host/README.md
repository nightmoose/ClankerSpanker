# ClankerSpanker Host

Cross-platform local gateway. Clients (browser UI or iOS app) talk REST + WebSocket over LAN / Tailscale; this process drives **Grok Build** (ACP), **Claude Code**, **Antigravity**, and an in-process **bot** runtime (hunter drafts, phone-gated outbound — no send in v1).

Works on **macOS**, **Linux**, and (with agents installed) **Windows** via `npm start`. User-service install helpers exist for macOS launchd and Linux systemd.

## Quick start

```bash
cd host
npm install
npm run dev          # or: npm run build && npm start
```

First run writes `~/.grok-dispatch/config.json` including a **host token**.

| URL | Purpose |
|-----|---------|
| `http://<host>:8787/app/` | Browser control plane |
| `http://<host>:8787/setup` | Token + deep link for iOS |
| `http://<host>:8787/health` | Liveness |

### Run as a background service

```bash
./scripts/install-service.sh   # macOS → launchd, Linux → systemd --user
```

Or OS-specific:

- macOS: `./scripts/install-launchd.sh`
- Linux: `./scripts/install-systemd-user.sh`

## API

All routes except `GET /health`, `GET /`, `GET /setup`, `GET /app/*`, and `GET /connect.json` require:

```
Authorization: Bearer <hostToken>
```

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Liveness |
| GET | `/app/` | Browser UI |
| POST | `/auth/validate` | Check token |
| GET | `/projects` | Allowlisted project dirs |
| GET | `/sessions` | Active + archived + disk hints |
| GET | `/sessions/:id` | Detail + transcript + pending approval/question |
| GET | `/sessions/:id/tool-calls/:toolCallId` | Full tool payload (`rawInputJson` / `contentJson`) for the ellipsis sheet |
| GET | `/sessions/:id/diff` | `git diff HEAD` in session cwd |
| POST | `/dispatch` | Start a task (optional `images[]` on the opening turn) |
| POST | `/sessions/attach` | Resume Grok disk session |
| POST | `/sessions/attach-claude` | Resume Claude / hand off to Grok |
| POST | `/sessions/:id/prompt` | Follow-up |
| POST | `/sessions/:id/approve` | Tool approval |
| POST | `/sessions/:id/reject` | Tool rejection |
| POST | `/sessions/:id/answer-questions` | Questionnaire answers |
| POST | `/sessions/:id/archive` | Soft-archive |
| POST | `/sessions/:id/unarchive` | Restore |
| POST | `/sessions/:id/review` | Non-destructive critique of recent work (new sibling session) |
| GET | `/profiles?usage=1` | Profiles + Claude OAuth 5h/weekly utilization (who can still work) |
| GET | `/bots` | Autonomous bots (`~/.grok-dispatch/bots.json`) |
| POST | `/bots` | Create a bot (profile backend must be `bot`) |
| PATCH | `/bots/:id` | Update a bot (enable, interval, job, …) |
| POST | `/bots/:id/run` | Manual fire (allowed even when disabled). Body `{ note }` is a one-shot extra instruction. |
| GET | `/bots/:id/outbox` | Markdown drafts under the bot project's `.bot-outbox/` |
| POST | `/sessions/:id/cancel` | Cancel |
| WS | `/ws?token=<hostToken>` | Live event stream |

## Config

`~/.grok-dispatch/config.json`:

```json
{
  "hostToken": "…",
  "bindHost": "0.0.0.0",
  "bindPort": 8787,
  "grokBinary": "grok",
  "projects": [
    { "id": "my-app", "name": "My App", "path": "/home/you/code/my-app" }
  ],
  "allowCustomPaths": true,
  "autoApproveKinds": ["read", "search", "think", "fetch"],
  "notifyDesktop": true,
  "dataDir": "/home/you/.grok-dispatch"
}
```

- `notifyDesktop` — OS notifications (macOS/Linux/Windows best-effort). Legacy key `notifyMac` still accepted.
- Env: `GROK_DISPATCH_HOST`, `GROK_DISPATCH_PORT`, `GROK_DISPATCH_TOKEN`, `GROK_BINARY`, `GROK_DISPATCH_CONFIG`, `GROK_DISPATCH_LAN_URL` (advertised URL on setup page when browsing via localhost).

## Security

- Bind is `0.0.0.0:8787` by default — **Tailscale or LAN only**, not the public internet.
- Bearer host token authenticates browser and phone.
- Agent auth is whatever is already configured on the host (`grok login`, Claude CLI, Antigravity `agy`, etc.).
- Never starts Grok with `--always-approve` / yolo for write/execute tools.
- **Antigravity profiles** (`backend: "antigravity"`): see [`docs/ANTIGRAVITY.md`](../docs/ANTIGRAVITY.md).
