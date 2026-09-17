# MCP catalog — paste onto a profile

RFC: [rfcs/013-profile-mcp-catalog.md](rfcs/013-profile-mcp-catalog.md).
Mechanism: [MCP.md](MCP.md) (RFC-008/009).

`/app/` → Profiles (this Mac) → **Apply catalog defaults** (or chips /
JSON textarea). HTTP rows then **Sign in**. Do not put Gmail / M365 /
QuickBooks on NightMoose. NightMoose Grok home can stay blank (RFC-020
isolates spawn under `~/.grok-dispatch/grok-homes/nightmoose`).

Placeholders: replace `YOUR_ADO_ORG`. Tokens belong in that profile’s
**Environment** field (`${DATABRICKS_TOKEN}`), never in git.

---

## NightMoose (Grok)

```json
[
  {
    "name": "github",
    "url": "https://api.githubcopilot.com/mcp/",
    "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" },
    "transport": "http"
  },
  {
    "name": "vercel",
    "url": "https://mcp.vercel.com",
    "transport": "http"
  },
  {
    "name": "supabase",
    "url": "https://mcp.supabase.com/mcp",
    "transport": "http"
  },
  {
    "name": "notion",
    "url": "https://mcp.notion.com/mcp",
    "transport": "http"
  },
  {
    "name": "fly",
    "command": "flyctl",
    "args": ["mcp", "server"]
  }
]
```

GitHub: put `GITHUB_TOKEN=…` in Environment (PAT or `gh auth token`).
There is no Sign in — GitHub MCP has no registration endpoint. Vercel /
Supabase / Notion Sign in. Fly uses `flyctl` on this Mac.

Optional later: `stripe`, `sentry`, `context7`
(`https://mcp.context7.com/mcp`), `linear`
(`https://mcp.linear.app/mcp`).

---

## Personal (Claude)

```json
[
  {
    "name": "github",
    "url": "https://api.githubcopilot.com/mcp/",
    "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" },
    "transport": "http"
  },
  {
    "name": "notion",
    "url": "https://mcp.notion.com/mcp",
    "transport": "http"
  }
]
```

GitHub: `GITHUB_TOKEN` in Environment (this profile’s token, not
NightMoose’s unless you reuse it). Notion: Sign in (separate OAuth under
`mcp-oauth/personal/`). Add Gmail/Slack here, not on NightMoose.

---

## FullScore (Claude)

```json
[
  {
    "name": "databricks",
    "command": "npx",
    "args": ["-y", "databricks-mcp"],
    "env": { "DATABRICKS_TOKEN": "${DATABRICKS_TOKEN}" }
  },
  {
    "name": "azure-devops",
    "command": "npx",
    "args": ["-y", "@azure-devops/mcp", "ShoreCP"],
    "transport": "stdio"
  },
  {
    "name": "azure",
    "command": "npx",
    "args": ["-y", "@azure/mcp@latest", "server", "start"],
    "transport": "stdio"
  }
]
```

Remote HTTP Sign in for Azure / Azure DevOps fails here: Entra has no
`registration_endpoint`. Stdio is the catalog default. First Azure DevOps
tool use opens a browser; Azure uses this Mac's `az login`.

Databricks workspace URL, if the vendor HTTP server is used instead of
npx, is per-customer — keep it in FullScore env, not in this file.

---

## Gemini

Leave `[]` until Antigravity grows `--mcp-config`.

---

## Vendor notes

| Server | Canonical | Auth |
|---|---|---|
| GitHub | `https://api.githubcopilot.com/mcp/` | OAuth |
| Vercel | `https://mcp.vercel.com` | OAuth (this is what crashed unsigned NightMoose turns) |
| Supabase | `https://mcp.supabase.com/mcp` | OAuth; stdio `@supabase/mcp-server-supabase` if remote flakes |
| Notion | `https://mcp.notion.com/mcp` | OAuth |
| Fly.io | `flyctl mcp server` | existing flyctl session |
| Azure DevOps | `https://mcp.dev.azure.com/{org}` | Entra; stdio fallback `@azure-devops/mcp` |
| Azure | `https://mcp.management.azure.com` | Entra (Data Factory / cloud data plane) |
| Databricks | workspace-specific or `npx -y databricks-mcp` | PAT |

---

## Soak

1. Apply catalog on NightMoose, Sign in Vercel, dispatch, tools include Vercel.
2. FullScore turn on the same host: **no** Vercel tools.
3. Unsigned Vercel must **not** pop “NightMoose needs to sign in”
   (RFC-012). Prefer Sign in or `enabled: false` over a dead worker.
