# Per-profile MCP

MCP servers are billed to the **profile**, not the host. Configure them on
this Mac in `/app/` → Profiles (loopback only). Public API lists **names
only** — env, headers, and OAuth tokens never leave the machine.

See RFC-008 (server list) and RFC-009 (remote OAuth).

## JSON shape

Paste an array on the profile:

```json
[
  {
    "name": "databricks",
    "command": "npx",
    "args": ["-y", "databricks-mcp"],
    "env": { "DATABRICKS_TOKEN": "${DB_TOKEN}" }
  },
  {
    "name": "gmail",
    "url": "https://mcp.example.com/mcp",
    "transport": "http"
  }
]
```

`${VAR}` expands from that profile’s Environment field, then `process.env`.
`enabled: false` omits the server at spawn.

## How it reaches each backend

| Backend | Path |
|---|---|
| Claude | `{dataDir}/mcp/{profileId}.mcp.json` + `--mcp-config` |
| Grok ACP | `mcpServers` on `session/new` and `session/load` |
| Antigravity | JSON is written; `agy` has no flag yet |
| Bot | none (in-process, no MCP runtime) |

## Remote OAuth (HTTP / SSE)

For URL servers, the profile editor shows **Sign in** / **Sign out**.

1. Sign in starts MCP OAuth 2.1 + PKCE on this Mac.
2. The authorization server redirects to
   `http://127.0.0.1:8787/mcp/oauth/callback`.
3. Tokens land in `~/.grok-dispatch/mcp-oauth/{profileId}/{serverName}.json`
   (mode `0600`), not in `config.json`.
4. Dispatch injects `Authorization: Bearer …` unless the JSON already set
   that header (static keys still win).

If the server does not support dynamic client registration, add
`oauthClientId` (and optional `oauthClientSecret` / `oauthScope`) to the
server object.

Hosted claude.ai connectors (`mcp__claude_ai_*`) are not CLI MCP and are
out of scope.

## Operator

```bash
launchctl kickstart -k "gui/$(id -u)/com.nightmoose.grok-dispatch-host"
```

Then `/app/` on this machine → Profiles → save an HTTP server → Sign in.
