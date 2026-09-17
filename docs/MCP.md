# Per-profile MCP

MCP servers are billed to the **profile**, not the host. Configure them on
this Mac in `/app/` → Profiles (loopback only). Public API lists **names
only** — env, headers, and OAuth tokens never leave the machine.

See RFC-008 (server list), RFC-009 (remote OAuth), RFC-013 (paste map),
and RFC-020 (catalog chips + Grok spawn isolation). NightMoose gets
GitHub / Vercel / Fly / Supabase / Notion; Personal gets GitHub + Notion
(separate Sign in); FullScore gets Databricks / Azure DevOps / Azure. No
Gmail / M365 / QuickBooks on NightMoose.

`/app/` → Profiles (this Mac) → **Apply catalog defaults** (or tap chips)
→ **Sign in** HTTP rows. `GET /mcp/catalog` is the same list.

Grok ACP no longer inherits Claude's Vercel plugin MCP. When `grokHome`
is blank, spawn uses `{dataDir}/grok-homes/{profileId}` with an isolation
`config.toml` and a symlink to this Mac's `~/.grok/auth.json`. Leave
NightMoose's Grok home blank. Point a *second* Grok profile at its own
dir and Sign in there — do not set NightMoose to `~/.grok` or the Claude
plugin comes back.

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

**GitHub** is that case. Do not Sign in. On any profile: Environment
`GITHUB_TOKEN=<pat or gh auth token>`, and the GitHub catalog chip already
sets `Authorization: Bearer ${GITHUB_TOKEN}`. Each profile can use a
different token. Same Mac `gh` login can be reused, or a PAT per GitHub
user from github.com/settings/tokens.

**npm publish:** do not `npm login` in a session. Put `NPM_TOKEN` (automation
token from npmjs.com, or the value already in `~/.npmrc`) in that profile's
Environment. Spawn writes `~/.grok-dispatch/npm/{profileId}.npmrc` and sets
`NPM_CONFIG_USERCONFIG`. Project `.npmrc` may use
`//registry.npmjs.org/:_authToken=${NPM_TOKEN}`.

Hosted claude.ai connectors (`mcp__claude_ai_*`) are not CLI MCP and are
out of scope.

## Operator

```bash
launchctl kickstart -k "gui/$(id -u)/com.nightmoose.clankerspanker-host"
```

That is the Application Support LaunchAgent. Do not kick
`com.nightmoose.grok-dispatch-host` on a Mac that already has the app-managed
install. Then `/app/` on this machine → Profiles → **Apply catalog** → Sign in
each HTTP row.
