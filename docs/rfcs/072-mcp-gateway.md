# RFC-072 — MCP gateway for remote coding tasks

**Status:** Draft
**Date:** 2026-10-24
**Branch:** cursor/rfc-072-mcp-gateway-1fc8
**Severity:** P1

`make rfc SLUG=mcp-gateway` assigned 072 after `git fetch origin` on 2026-10-24.

---

## Problem

Grok Bot agents run off the machine. They can call a remote MCP server, but they cannot start a Claude Code or Grok Build session on the Mac mini. The gateway already does that for the phone and the desktop apps. A second job runner would fork the session model, the approval path, and the token check.

`docs/MCP.md` is the other direction: MCP servers a profile connects *to*. This RFC is the gateway *being* an MCP server.

## Non-goals

- Approving edits or shell commands from the connector. The phone still does that.
- Driving Antigravity or the in-process bot. Engines are Claude and Grok.
- A second auth system. `host/src/auth.ts` is unchanged. `/mcp` accepts the host bearer token or an optional `mcpGateway.token` checked with the same `tokensMatch`. The MCP token does not authorize any other route.
- Publishing port 8787. The optional public listener is loopback and serves `/mcp` and `/health` only.
- OAuth for the connector. A bearer token is the credential. Signing cloud clients into MCP OAuth is a follow-up.

## Fix

`POST /mcp` on the main gateway speaks Streamable HTTP.

- Protocol `2026-07-28` (per-request `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`) and the legacy `initialize` handshake for `2025-11-25`, `2025-06-18`, and `2025-03-26`.
- `GET` and `DELETE` are 405. There is no session stream.
- Replies are one JSON object, or one SSE event when the client accepts only `text/event-stream`.
- A missing `Origin` is allowed. `localhost`, `127.0.0.1`, and `::1` are allowed. Any other origin needs `mcpGateway.allowedOrigins`. This is the DNS-rebinding check the MCP spec requires.
- CORS allow-headers gain `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`, and `Mcp-Session-Id` so a browser preflight can name them. Who may call the gateway does not change: the hosted origin is still the only website origin that receives CORS on the main port.

Tools, all backed by `SessionManager`:

| Tool | Gateway call |
|---|---|
| `list_engines` | Claude and Grok profiles |
| `list_repos` | Allowlisted directories and projects inside them |
| `list_sessions` | Tasks this connector started |
| `start_task` | `dispatch` with `source: "mcp"` |
| `get_task` | Session status, plus `needsHuman` when the phone is blocking |
| `get_output` | `getEventsSince`, optional long-poll up to 25 s |
| `send_followup` | `followUp` |
| `cancel_task` | `cancel` |
| `get_result` | Last assistant text and `diff` |

`source: "mcp"` is stored on the session. Follow-up, cancel, and result refuse every other session, so a connector token cannot type into a phone chat.

Guardrails, from `mcpGateway` in config.json:

- `allowedRoots`. Empty means the configured project paths and nothing else. A path must be the root or a real directory inside it. A symlink that leaves the root is refused. `allowCustomPaths` is not consulted.
- `taskTimeoutMs`. Default 2 hours. `0` disables. The timer covers one turn, including time spent waiting on the phone, and is cleared when the turn goes idle.
- `maxConcurrent`. Default 2. Counts queued, running, and waiting-on-a-person MCP tasks. `0` refuses new work.
- `publicBindPort`. Unset by default. When set, listen on `127.0.0.1` only and serve `/mcp` and `/health`. It must differ from `bindPort` and `serveBindPort`.

`GROK_DISPATCH_MCP_TOKEN` overrides `mcpGateway.token` when set. The value stays in config.json (mode 0600) or the environment. It is not logged and not returned by any route.

CORS and token handling called out here: the new route checks a second bearer with `tokensMatch`, and the allow-headers list is longer. `isAuthorized` is not modified.

## Testing

- [x] `host/src/mcp-gateway.test.ts`: protocol versions, header checks, origin, token scope, allowlist (sibling prefix and symlink), concurrency, phone-only approval text, timeout, public listener 404s `/exec`
- [ ] Mac mini: restart the LaunchAgent, open the public port, register the connector from a cloud client

## Rollout

1. Merge.
2. On the Mac mini, set `mcpGateway` in `~/.grok-dispatch/config.json` and restart the host. Steps are in `docs/MCP-GATEWAY.md`. The route answers on the main port before that; the public port stays closed until `publicBindPort` is set.
3. `make check`.
4. Row in `docs/rfcs/README.md`.

## Follow-ups

- OAuth for clients that cannot hold a bearer token.
- Letting the connector answer a question the agent asked. Approval stays on the phone.
- Streaming tool progress over the SSE response while the agent runs. Clients poll `get_output` for now.
