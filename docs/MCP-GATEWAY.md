# Remote MCP gateway

The host can **be** an MCP server. A remote client (a Grok Bot agent, or any other Streamable HTTP client) starts Claude Code and Grok Build tasks on the machine where the gateway runs. Those tasks use the same sessions, profiles, and phone approvals as the apps.

This is the opposite of [MCP.md](MCP.md), which is about MCP servers a profile connects *to*.

The endpoint is `POST /mcp`. It speaks protocol `2026-07-28` and the older `initialize` handshake (`2025-11-25`, `2025-06-18`, `2025-03-26`).

## Tools

| Tool | What it does |
|---|---|
| `list_engines` | Claude and Grok profiles. If an engine has more than one, `start_task` needs `profileId`. |
| `list_repos` | Directories a task is allowed to use, and projects inside them. |
| `list_sessions` | Tasks this connector started. Phone and desktop chats are not listed. |
| `start_task` | `engine` (`claude` or `grok`), `prompt`, and `cwd` or `projectId`. |
| `get_task` | Status. `needsHuman` is set when the phone has to approve or answer. |
| `get_output` | Lines since `sinceSeq`. Pass `waitMs` (max 25000) to long-poll. |
| `send_followup` | Another prompt on a task this connector started. |
| `cancel_task` | Stop that task. |
| `get_result` | Latest assistant text and the git diff. |

Edits and shell commands still wait for a person on the phone. The connector cannot approve them. When `needsHuman` is set, the agent should stop and say so.

## Config

In `~/.grok-dispatch/config.json` on the host (mode `0600`; the file is not in git):

```json
"mcpGateway": {
  "token": "paste-output-of-openssl-rand-hex-32",
  "allowedRoots": ["~/Projects"],
  "taskTimeoutMs": 7200000,
  "maxConcurrent": 2,
  "publicBindPort": 8790
}
```

| Field | Meaning |
|---|---|
| `token` | Bearer accepted **only** by `/mcp`. Leave it out and `/mcp` accepts the host token. Do not put the host token in a cloud connector. |
| `allowedRoots` | Absolute paths or `~/…`. A task may use that directory or one inside it. Empty or omitted: configured project paths only. A symlink that points out of the root is refused. |
| `taskTimeoutMs` | Wall clock for one turn, including time waiting on the phone. Default 2 hours (`7200000`). `0` disables. |
| `maxConcurrent` | How many MCP tasks may be queued, running, or waiting on a person. Default 2. `0` refuses new work. |
| `publicBindPort` | Loopback port that serves **only** `/mcp` and `/health`. Unset = that port is not opened. Must differ from `bindPort` and `serveBindPort`. |
| `allowedOrigins` | Extra browser `Origin` values. Cloud clients send no Origin. `localhost` is always allowed. |

Mint the token on the host:

```bash
openssl rand -hex 32
```

Paste it into `mcpGateway.token`. An environment variable overrides the file when the host process can see it:

```bash
GROK_DISPATCH_MCP_TOKEN=...
```

Do not commit the token, put it in a repo, or paste it into a log.

Restart the host after editing the file. On the Mac mini, with the Application Support LaunchAgent:

```bash
launchctl kickstart -k "gui/$(id -u)/com.nightmoose.clankerspanker-host"
```

`POST /mcp` is on the main port as soon as the gateway is running, even with no `mcpGateway` block. Defaults then are: project paths only, 2-hour turns, 2 tasks at a time, no public port.

Check it from the host:

```bash
curl -sS -X POST http://127.0.0.1:8787/mcp \
  -H "Authorization: Bearer $MCP_TOKEN" \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

The host token works in that header too. The MCP token does not work on `/sessions`, `/exec`, or anything else.

## Exposing it

Cloud agents are not on the tailnet, so `tailscale serve` (which only answers tailnet users) does not reach them. Do not point Funnel, a tunnel, or any public proxy at port **8787**. That port is the whole gateway.

Set `publicBindPort` (8790 in the example). The process listens on `127.0.0.1:8790` and answers `/mcp` and `/health` only. Then publish **that** port.

### Tailscale Funnel

Funnel puts a public HTTPS name on the internet. The bearer token is the only lock. Enable Funnel for this node in the tailnet policy (the node attribute `funnel`), then on the Mac mini:

```bash
tailscale funnel --bg 8790
tailscale funnel status
```

Use the `https://…ts.net/mcp` URL it prints. Turn it off with `tailscale funnel reset`.

The gateway's `serveBindPort` / `tailscale serve` path is a different feature and stays tailnet-only. Funnel traffic is rejected there on purpose. Funnel belongs on `publicBindPort`.

### Cloudflare Tunnel

```bash
cloudflared tunnel --url http://127.0.0.1:8790
```

That prints a temporary `trycloudflare.com` URL. For a name you keep, create a named tunnel and point its ingress at `http://127.0.0.1:8790`. The public URL is `https://<your-host>/mcp`.

Prefer the dedicated `mcpGateway.token` in the connector. A leaked MCP token can start and cancel MCP tasks. It cannot call `/exec` or read other sessions. A leaked host token can.

## Register the connector

In the cloud client's custom MCP server form:

| Field | Value |
|---|---|
| URL | `https://<public-host>/mcp` |
| Transport | Streamable HTTP |
| Header | `Authorization: Bearer <mcpGateway.token>` |

The form's labels vary by product. The URL, the transport, and that header are the whole registration. No OAuth client is required.

Local clients on the host can use `http://127.0.0.1:8787/mcp` with the same header and skip the tunnel.

## What you do on the Mac mini

This repo change does not edit the machine's config or open a port.

1. Update the host checkout and restart it (or merge, then `./scripts/update-mac-host.sh` from a checkout that tracks `origin/main`).
2. Add `mcpGateway` to `~/.grok-dispatch/config.json` as above. Generate the token there. Do not copy it into git.
3. Restart the LaunchAgent.
4. If a cloud client must reach it: set `publicBindPort`, restart, then `tailscale funnel --bg <port>` or a Cloudflare tunnel to `127.0.0.1:<port>`.
5. Paste the public URL and the MCP token into the connector. Confirm a `tools/list` call works.
6. Send a small task and approve it on the phone when the card appears. The connector will sit on `awaiting_approval` until you do.
