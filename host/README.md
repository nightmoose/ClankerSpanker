# ClankerSpanker Host

Cross-platform local gateway. Clients (browser UI or iOS app) talk REST + WebSocket over LAN / Tailscale; this process drives **Grok Build** (ACP), **Claude Code**, **Antigravity**, and an in-process **bot** runtime (hunter drafts, phone-gated outbound — no send in v1).

Works on **macOS**, **Linux**, and (with agents installed) **Windows** via `npm start`. User-service install helpers exist for macOS launchd and Linux systemd.

## Quick start

```bash
cd host
npm install
npm run dev          # or: npm run build && npm start
```

First run writes `~/.grok-dispatch/config.json` (mode `0600`) including a **host token**.

| URL | Purpose |
|-----|---------|
| [https://clankerspanker.tech/](https://clankerspanker.tech/) | Primary website. Chrome on the same machine calls this gateway over loopback |
| `http://<host>:8787/app/` | The same control plane, served by the gateway (any browser on a machine that can reach it) |
| `http://localhost:8787/setup` | Pairing: QR code + token. **Only answers on the host machine itself** |
| `http://<host>:8787/health` | Liveness |

### Run as a background service

```bash
./scripts/install-service.sh   # macOS → launchd, Linux → systemd --user
```

Or OS-specific:

- macOS: `./scripts/install-launchd.sh`
- Linux: `./scripts/install-systemd-user.sh`

## API

`GET /`, `GET /setup` and `GET /connect.json` reveal the token, so they only
answer a browser or app **on the host machine**, addressed by one of its own
names, with no cross-site `Origin`. They never send CORS headers.
Everyone else pairs by scanning the `/setup` QR code.

### Where the host listens

`"bindHost"` in `config.json`:

| Value | Listens on |
|---|---|
| `"auto"` (default for new installs) | `127.0.0.1`, `::1`, and this machine's Tailscale addresses (re-checked every 30 s) |
| `"0.0.0.0"` | Every network, including public Wi-Fi (logs a warning) |
| `"127.0.0.1,100.64.0.10"` | Exactly the listed addresses |

Phones and other laptops should connect over Tailscale.

### Tailscale Serve (HTTPS for any browser, RFC-058 phase 2)

`https://clankerspanker.tech` can only call `http://127.0.0.1:8787` from Chrome (an HTTPS page calling `http:` is mixed content). For Safari, Firefox, and other devices, give the gateway a tailnet HTTPS name:

1. Pick a machine name you don't mind being public. Enabling HTTPS publishes `<machine>.<tailnet>.ts.net` in Certificate Transparency logs. Rename the machine first if needed.
2. In the Tailscale admin console, DNS page: MagicDNS on, HTTPS Certificates enabled.
3. Set `"serveBindPort": 8788` (any free port other than `bindPort`; unset = off, the default) in `config.json` and restart the host. It logs `tailscale serve listener on http://127.0.0.1:8788`.
4. `tailscale serve --bg 8788` — **the serve port, never 8787**. Use the `https://…ts.net` address it prints as the Host URL.
5. `tailscale serve status` must show the entry as tailnet only. Funnel stays off.

What the serve listener does:

- Binds `127.0.0.1` only.
- Every request (HTTP and WebSocket upgrade, `/health` included) without a non-empty `Tailscale-User-Login` header gets `403`. Serve sets that header for signed-in tailnet users and strips client-sent copies. Funnel and tagged nodes get no header, so they fail closed.
- `/`, `/setup`, `/connect.json`, and `/mcp/oauth/callback` are not mounted (`404`).
- The host token is still required for the API.
- Any request carrying `Tailscale-User-Login`, on either port, is not "this machine": no `?admin=1` profile records, no profile create/edit/delete, no MCP catalog apply or OAuth, no legacy `?token=` WebSocket. Direct loopback to `8787` without the header is unchanged.

Do not point `tailscale serve` (or Funnel) at `8787`: its peer is loopback, which `8787` treats as the host machine.

### Logs

On macOS the LaunchAgent writes to `~/Library/Logs/clankerspanker-host.log` and
`clankerspanker-host.err.log`. The gateway rotates its own log files once they pass
10 MB, keeping three old copies (`.1`–`.3`). Change the limit with `"logMaxBytes"` in
`config.json`, or set it to `0` to turn rotation off (RFC-068).

### Import from disk

`POST /projects/discover` (the apps' **Import from disk…**) lists git repos
in `~` and two levels under `~/Projects`, `~/Developer`, `~/code`, `~/src`,
`~/dev`, `~/repos`, `~/GitHub`, `~/Documents` and `~/Documents/GitHub`.
Add your own with `"discoverRoots": ["~/work"]` in `config.json`.

### Pairing a phone

1. On the host machine open `http://localhost:8787/setup`.
2. Point the iPhone camera at the QR code and tap the banner.
3. The app asks **Add host?** (or **Update host token?** when that address is
   already saved). Tap it.

### Updating a Mac host

From the checkout on that Mac: `git pull`, `cd host && npm ci && npm run build`,
then restart the service (`launchctl kickstart -k gui/$(id -u)/com.nightmoose.grok-dispatch-host`
for the LaunchAgent install, or `systemctl --user restart clankerspanker-host` on Linux).
To bind to loopback + Tailscale set `bindHost` accordingly (see the table above), and to
mint a new token see "Rotating the token" below. Re-pair clients from `/setup` afterwards.

### Rotating the token

Stop the host, delete `"hostToken"` from `~/.grok-dispatch/config.json`, start
the host (a new token is minted and saved), then re-pair each client from
`/setup`. On the phone, the scan updates the existing host in place.

All other routes except `GET /health` and `GET /app/*` require:

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
| POST | `/ws/ticket` | Single-use 30 s WebSocket ticket |
| WS | `/ws` | Live event stream. Auth: `Authorization: Bearer` header, or `?ticket=` from `/ws/ticket`. `?token=` is accepted only from the host machine itself. |

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
